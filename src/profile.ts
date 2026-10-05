import mammoth from "mammoth";
import { extractText, getDocumentProxy } from "unpdf";
import { isSafePublicHttps, sha256 } from "./filters";
import { EMPTY_PROFILE, type Env, type JobProfileData, type OpenAIFileInput, type ScheduleSettings, type ScheduleSlot } from "./types";

const MAX_RESUME_BYTES = 10 * 1024 * 1024;
const MAX_EXTRACTED_CHARS = 50_000;
const STAGED_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_DOCX_UNCOMPRESSED_BYTES = 50 * 1024 * 1024;
const MAX_DOCX_ENTRIES = 2_000;

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function normalizeText(value: string): string {
  return value.replace(/\u0000/g, "").replace(/[\t ]+/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, MAX_EXTRACTED_CHARS);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function digestBytes(bytes: Uint8Array): Promise<string> {
  const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", copy)));
}

export function detectResumeKind(bytes: Uint8Array, file: OpenAIFileInput): "pdf" | "docx" | "txt" {
  const mime = (file.mime_type ?? "").toLowerCase();
  const name = (file.file_name ?? "").toLowerCase();
  if (bytes.length >= 5 && new TextDecoder().decode(bytes.slice(0, 5)) === "%PDF-") return "pdf";
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04 && (mime.includes("wordprocessingml") || name.endsWith(".docx"))) return "docx";
  const sample = bytes.slice(0, Math.min(bytes.length, 4096));
  if ((mime.startsWith("text/") || name.endsWith(".txt")) && !sample.includes(0)) return "txt";
  throw new Error("unsupported_or_mismatched_resume_file");
}

export function validateDocxContainer(bytes: Uint8Array): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const minimumEocd = 22;
  if (bytes.byteLength < minimumEocd) throw new Error("invalid_docx_archive");
  let eocd = -1;
  for (let offset = bytes.byteLength - minimumEocd; offset >= Math.max(0, bytes.byteLength - 65_557); offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) { eocd = offset; break; }
  }
  if (eocd < 0) throw new Error("invalid_docx_archive");
  const entryCount = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  if (!entryCount || entryCount > MAX_DOCX_ENTRIES || entryCount === 0xffff || centralOffset + centralSize > eocd) throw new Error("unsafe_docx_archive");
  let offset = centralOffset;
  let totalUncompressed = 0;
  let hasContentTypes = false;
  let hasDocument = false;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > bytes.byteLength || view.getUint32(offset, true) !== 0x02014b50) throw new Error("invalid_docx_archive");
    const flags = view.getUint16(offset + 8, true);
    const compressed = view.getUint32(offset + 20, true);
    const uncompressed = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    if ((flags & 1) !== 0 || compressed === 0xffffffff || uncompressed === 0xffffffff) throw new Error("unsafe_docx_archive");
    totalUncompressed += uncompressed;
    if (totalUncompressed > MAX_DOCX_UNCOMPRESSED_BYTES || (uncompressed > 5 * 1024 * 1024 && uncompressed > Math.max(1, compressed) * 200)) throw new Error("unsafe_docx_archive");
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > bytes.byteLength) throw new Error("invalid_docx_archive");
    const name = new TextDecoder().decode(bytes.subarray(nameStart, nameEnd)).replace(/\\/g, "/");
    if (name.startsWith("/") || name.split("/").includes("..")) throw new Error("unsafe_docx_archive");
    if (name === "[Content_Types].xml") hasContentTypes = true;
    if (name === "word/document.xml") hasDocument = true;
    offset = nameEnd + extraLength + commentLength;
  }
  if (offset > centralOffset + centralSize || !hasContentTypes || !hasDocument) throw new Error("invalid_docx_archive");
}

async function extractResumeText(bytes: Uint8Array, kind: "pdf" | "docx" | "txt"): Promise<string> {
  if (kind === "txt") return normalizeText(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (kind === "docx") {
    validateDocxContainer(bytes);
    const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const result = await mammoth.extractRawText({ arrayBuffer: copy });
    return normalizeText(result.value);
  }
  const pdf = await getDocumentProxy(bytes);
  if (pdf.numPages > 50) throw new Error("resume_has_too_many_pages");
  const result = await extractText(pdf, { mergePages: true });
  return normalizeText(String(result.text));
}

async function fetchFile(input: OpenAIFileInput): Promise<{ bytes: Uint8Array; contentType: string }> {
  let current = input.download_url;
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    if (!isSafePublicHttps(current)) throw new Error("unsafe_resume_download_url");
    const response = await fetch(current, { redirect: "manual", headers: { accept: "application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain" } });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error("resume_redirect_without_location");
      current = new URL(location, current).toString();
      continue;
    }
    if (!response.ok) throw new Error(`resume_download_failed:${response.status}`);
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > MAX_RESUME_BYTES) throw new Error("resume_too_large");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!bytes.length) throw new Error("resume_empty");
    if (bytes.byteLength > MAX_RESUME_BYTES) throw new Error("resume_too_large");
    return { bytes, contentType: response.headers.get("content-type") ?? input.mime_type ?? "application/octet-stream" };
  }
  throw new Error("too_many_resume_redirects");
}

export async function purgeExpiredStagedResumes(env: Env, userId: string): Promise<void> {
  const expired = await env.JOB_FEED_DB.prepare(`SELECT id, object_key FROM resume_assets WHERE user_id=? AND status='staged' AND expires_at < CURRENT_TIMESTAMP`).bind(userId).all<{ id: string; object_key: string }>();
  for (const row of expired.results) await env.JOB_FEED_RESUMES.delete(row.object_key);
  await env.JOB_FEED_DB.prepare(`DELETE FROM resume_assets WHERE user_id=? AND status='staged' AND expires_at < CURRENT_TIMESTAMP`).bind(userId).run();
}

export async function stageResume(env: Env, userId: string, input: OpenAIFileInput) {
  await purgeExpiredStagedResumes(env, userId);
  const { bytes, contentType } = await fetchFile(input);
  const kind = detectResumeKind(bytes, input);
  const extracted = await extractResumeText(bytes, kind);
  if (extracted.length < 40) throw new Error("resume_text_too_short");
  const hash = await digestBytes(bytes);
  const userHash = (await sha256(userId)).slice(0, 16);
  const id = crypto.randomUUID();
  const objectKey = `resumes/${userHash}/${id}.${kind}`;
  await env.JOB_FEED_RESUMES.put(objectKey, bytes, {
    httpMetadata: { contentType },
    customMetadata: { sha256: hash, originalName: (input.file_name ?? `resume.${kind}`).slice(0, 200) },
  });
  const expires = new Date(Date.now() + STAGED_TTL_MS).toISOString();
  await env.JOB_FEED_DB.prepare(`INSERT INTO resume_assets (id,user_id,object_key,file_id,file_name,mime_type,byte_size,sha256,status,extracted_text,expires_at)
    VALUES (?,?,?,?,?,?,?,?,'staged',?,?)`)
    .bind(id, userId, objectKey, input.file_id, (input.file_name ?? `resume.${kind}`).slice(0, 200), contentType, bytes.byteLength, hash, extracted, expires).run();
  return { resume_id: id, file_name: input.file_name ?? `resume.${kind}`, mime_type: contentType, byte_size: bytes.byteLength, expires_at: expires, next_step: "Call get_staged_resume_text, create a structured profile draft, then call save_profile_draft." };
}

export async function getStagedResumeText(env: Env, userId: string, resumeId: string) {
  await purgeExpiredStagedResumes(env, userId);
  const row = await env.JOB_FEED_DB.prepare(`SELECT id,file_name,mime_type,extracted_text,expires_at FROM resume_assets WHERE id=? AND user_id=? AND status='staged'`)
    .bind(resumeId, userId).first<Record<string, unknown>>();
  if (!row) throw new Error("staged_resume_not_found_or_expired");
  return { resume_id: row.id, file_name: row.file_name, mime_type: row.mime_type, text: row.extracted_text, expires_at: row.expires_at };
}

export async function saveProfileDraft(env: Env, userId: string, resumeId: string, summary: string, profile: JobProfileData, tagWeights: Record<string, number>) {
  const resume = await env.JOB_FEED_DB.prepare(`SELECT id FROM resume_assets WHERE id=? AND user_id=? AND status='staged' AND expires_at >= CURRENT_TIMESTAMP`).bind(resumeId, userId).first();
  if (!resume) throw new Error("staged_resume_not_found_or_expired");
  const weights = Object.fromEntries(Object.entries(tagWeights).slice(0, 100).map(([key, value]) => [key.trim(), Math.max(-5, Math.min(5, Number(value) || 0))]).filter(([key]) => key));
  await env.JOB_FEED_DB.prepare(`INSERT INTO user_profile (user_id,profile_summary,tag_weights,profile_json,profile_status,draft_resume_id,draft_summary,draft_profile_json,draft_tag_weights)
    VALUES (?,'','{}','{}','draft',?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET draft_summary=excluded.draft_summary,draft_tag_weights=excluded.draft_tag_weights,draft_profile_json=excluded.draft_profile_json,profile_status='draft',draft_resume_id=excluded.draft_resume_id,updated_at=CURRENT_TIMESTAMP`)
    .bind(userId, resumeId, summary.trim().slice(0, 4000), JSON.stringify(profile), JSON.stringify(weights)).run();
  return getJobProfile(env.JOB_FEED_DB, userId);
}

export async function confirmProfile(env: Env, userId: string) {
  const row = await env.JOB_FEED_DB.prepare(`SELECT profile_status,profile_version,active_resume_id,draft_resume_id FROM user_profile WHERE user_id=?`).bind(userId).first<Record<string, unknown>>();
  if (!row || row.profile_status !== "draft" || !row.draft_resume_id) throw new Error("profile_draft_not_ready");
  const nextVersion = row.active_resume_id ? Number(row.profile_version ?? 0) + 1 : Math.max(1, Number(row.profile_version ?? 1));
  const newResumeId = String(row.draft_resume_id);
  await env.JOB_FEED_DB.batch([
    env.JOB_FEED_DB.prepare(`UPDATE resume_assets SET status='active',activated_at=CURRENT_TIMESTAMP,expires_at=NULL WHERE id=? AND user_id=?`).bind(newResumeId, userId),
    env.JOB_FEED_DB.prepare(`UPDATE user_profile SET profile_status='active',profile_version=?,active_resume_id=?,profile_summary=COALESCE(draft_summary,profile_summary),profile_json=COALESCE(draft_profile_json,profile_json),tag_weights=COALESCE(draft_tag_weights,tag_weights),draft_resume_id=NULL,draft_summary=NULL,draft_profile_json=NULL,draft_tag_weights=NULL,updated_at=CURRENT_TIMESTAMP WHERE user_id=?`).bind(nextVersion, newResumeId, userId),
  ]);
  if (row.active_resume_id && row.active_resume_id !== newResumeId) {
    const old = await env.JOB_FEED_DB.prepare(`SELECT object_key FROM resume_assets WHERE id=? AND user_id=?`).bind(row.active_resume_id, userId).first<{ object_key: string }>();
    if (old) await env.JOB_FEED_RESUMES.delete(old.object_key);
    await env.JOB_FEED_DB.prepare(`DELETE FROM resume_assets WHERE id=? AND user_id=?`).bind(row.active_resume_id, userId).run();
  }
  return getJobProfile(env.JOB_FEED_DB, userId);
}

export async function getJobProfile(db: D1Database, userId: string) {
  const row = await db.prepare(`SELECT p.*, r.file_name AS resume_file_name,r.mime_type AS resume_mime_type,r.byte_size AS resume_byte_size,r.activated_at AS resume_activated_at
    FROM user_profile p LEFT JOIN resume_assets r ON r.id=p.active_resume_id WHERE p.user_id=?`).bind(userId).first<Record<string, unknown>>();
  if (!row) return { status: "needs_resume", profile_version: 0, summary: "", profile: EMPTY_PROFILE, tag_weights: {}, resume: null };
  const showingDraft = row.profile_status === "draft" && row.draft_resume_id;
  return {
    status: String(row.profile_status), profile_version: Number(row.profile_version), summary: String(showingDraft ? row.draft_summary ?? "" : row.profile_summary ?? ""),
    profile: parseJson(showingDraft ? row.draft_profile_json : row.profile_json, EMPTY_PROFILE), tag_weights: parseJson(showingDraft ? row.draft_tag_weights : row.tag_weights, {}),
    blocked_companies: parseJson(row.blocked_companies, []), explicit_preferences: parseJson(row.explicit_preferences, []),
    resume: row.active_resume_id ? { id: row.active_resume_id, file_name: row.resume_file_name, mime_type: row.resume_mime_type, byte_size: row.resume_byte_size, activated_at: row.resume_activated_at } : null,
    draft_resume_id: row.draft_resume_id ?? null,
  };
}

export async function deleteResumeProfile(env: Env, userId: string) {
  const rows = await env.JOB_FEED_DB.prepare(`SELECT object_key FROM resume_assets WHERE user_id=?`).bind(userId).all<{ object_key: string }>();
  for (const row of rows.results) await env.JOB_FEED_RESUMES.delete(row.object_key);
  await env.JOB_FEED_DB.batch([
    env.JOB_FEED_DB.prepare(`DELETE FROM resume_assets WHERE user_id=?`).bind(userId),
    env.JOB_FEED_DB.prepare(`DELETE FROM user_job_match WHERE user_id=?`).bind(userId),
    env.JOB_FEED_DB.prepare(`UPDATE user_profile SET profile_summary='',profile_json='{}',tag_weights='{}',profile_status='needs_resume',active_resume_id=NULL,draft_resume_id=NULL,draft_summary=NULL,draft_profile_json=NULL,draft_tag_weights=NULL,updated_at=CURRENT_TIMESTAMP WHERE user_id=?`).bind(userId),
  ]);
  return { deleted: true, status: "needs_resume" };
}

export async function getActiveResumeFile(env: Env, userId: string) {
  const row = await env.JOB_FEED_DB.prepare(`SELECT r.object_key,r.file_name,r.mime_type,r.byte_size FROM user_profile p JOIN resume_assets r ON r.id=p.active_resume_id WHERE p.user_id=? AND r.user_id=? AND r.status='active'`)
    .bind(userId, userId).first<{ object_key: string; file_name: string; mime_type: string; byte_size: number }>();
  if (!row) throw new Error("active_resume_not_found");
  const object = await env.JOB_FEED_RESUMES.get(row.object_key);
  if (!object) throw new Error("resume_object_missing");
  const bytes = new Uint8Array(await object.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + 0x8000)));
  return { file_name: row.file_name, mime_type: row.mime_type, byte_size: row.byte_size, base64: btoa(binary) };
}

export async function getOnboardingState(db: D1Database, userId: string) {
  const profile = await getJobProfile(db, userId);
  const schedule = await getScheduleSettings(db, userId);
  return { profile, schedule, ready: profile.status === "active", next_step: profile.status === "active" ? "Review preferences and apply a schedule." : "Upload a resume and confirm the generated profile." };
}

export function validateSchedule(timezone: string, weekdays: number[], slots: ScheduleSlot[]): void {
  try { new Intl.DateTimeFormat("en", { timeZone: timezone }).format(); } catch { throw new Error("invalid_timezone"); }
  if (!weekdays.length || weekdays.some((day) => !Number.isInteger(day) || day < 1 || day > 7)) throw new Error("invalid_weekdays");
  if (new Set(weekdays).size !== weekdays.length) throw new Error("duplicate_weekdays");
  if (slots.length < 1 || slots.length > 3) throw new Error("schedule_requires_one_to_three_slots");
  const ids = new Set<string>();
  const times = new Set<string>();
  for (const slot of slots) {
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(slot.id) || ids.has(slot.id)) throw new Error("invalid_or_duplicate_slot_id");
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(slot.time) || times.has(slot.time)) throw new Error("invalid_or_duplicate_slot_time");
    if (!Number.isInteger(slot.max_jobs) || slot.max_jobs < 1 || slot.max_jobs > 30) throw new Error("invalid_slot_job_count");
    ids.add(slot.id); times.add(slot.time);
  }
}

export async function getScheduleSettings(db: D1Database, userId: string): Promise<ScheduleSettings> {
  await db.prepare(`INSERT OR IGNORE INTO schedule_settings (user_id) VALUES (?)`).bind(userId).run();
  const row = await db.prepare(`SELECT * FROM schedule_settings WHERE user_id=?`).bind(userId).first<Record<string, unknown>>();
  if (!row) throw new Error("schedule_missing");
  return { timezone: String(row.timezone), weekdays: parseJson(row.weekdays, [1,2,3,4,5,6,7]), slots: parseJson(row.slots, [{ id: "evening", time: "20:00", max_jobs: 15 }]), paused: Boolean(row.paused), version: Number(row.version), syncedVersion: Number(row.synced_version) };
}

export async function updateScheduleSettings(db: D1Database, userId: string, timezone: string, weekdays: number[], slots: ScheduleSlot[], paused: boolean) {
  validateSchedule(timezone, weekdays, slots);
  const current = await getScheduleSettings(db, userId);
  const changed = current.timezone !== timezone || JSON.stringify(current.weekdays) !== JSON.stringify(weekdays) || JSON.stringify(current.slots) !== JSON.stringify(slots) || current.paused !== paused;
  if (changed) await db.prepare(`UPDATE schedule_settings SET timezone=?,weekdays=?,slots=?,paused=?,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE user_id=?`)
    .bind(timezone, JSON.stringify(weekdays), JSON.stringify(slots), paused ? 1 : 0, userId).run();
  const settings = await getScheduleSettings(db, userId);
  return { ...settings, schedule_apply_prompt: buildScheduleApplyPrompt(settings) };
}

export async function markScheduleSynced(db: D1Database, userId: string, version: number) {
  const current = await getScheduleSettings(db, userId);
  if (current.version !== version) throw new Error("schedule_version_changed");
  await db.prepare(`UPDATE schedule_settings SET synced_version=?,updated_at=CURRENT_TIMESTAMP WHERE user_id=?`).bind(version, userId).run();
  return { ...(await getScheduleSettings(db, userId)), synced: true };
}

export function buildScheduleApplyPrompt(settings: ScheduleSettings): string {
  const slots = settings.slots.map((slot) => `${slot.id} at ${slot.time}, max ${slot.max_jobs} jobs`).join("; ");
  return `Apply my Job Feed schedule version ${settings.version}. Timezone: ${settings.timezone}. ISO weekdays: ${settings.weekdays.join(",")}. ${settings.paused ? "Pause and remove all Job Feed scheduled tasks." : `Create or update one stable task per slot: ${slots}.`} Use the connected plugin and $daily-job-feed skill. After every task is updated successfully, call mark_schedule_synced with version ${settings.version}.`;
}
