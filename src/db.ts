import { scanSource, verifyApplicationUrl, type SourceRecord } from "./ats";
import { genericHardFilter, jobFingerprint, normalizeCompany, normalizeTitle, sha256, validateClassification } from "./filters";
import { getJobProfile, getScheduleSettings } from "./profile";
import { applyFeedback, canShow, decayWeights, finalScore, freshnessScore, preferenceScore, selectFeed } from "./scoring";
import { EMPTY_PROFILE, type CandidateInput, type ClassificationInput, type JobProfile, type JobStatus, type RankedJob } from "./types";

export interface DiscoveredSource { company: string; kind: SourceRecord["kind"]; board_url: string }
export interface SponsorshipUpdate { company: string; risk: "low" | "medium" | "high"; basis: string; evidence_url?: string; checked_at: string }
export interface FeedOptions {
  runAt: string;
  localDate: string;
  slotId: string;
  scheduleVersion: number;
  maxJobs: number;
  discoverSources: boolean;
  refreshSponsorship: boolean;
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function feedKey(options: Pick<FeedOptions, "localDate" | "slotId" | "scheduleVersion">): string {
  return `${options.localDate}:${options.slotId}:v${options.scheduleVersion}`;
}

export async function ensureProfile(db: D1Database, userId: string): Promise<void> {
  await db.prepare(`INSERT OR IGNORE INTO user_profile (user_id,profile_summary,tag_weights,profile_json,profile_status) VALUES (?,'','{}','{}','needs_resume')`).bind(userId).run();
}

export async function getProfile(db: D1Database, userId: string): Promise<JobProfile> {
  await ensureProfile(db, userId);
  const row = await db.prepare(`SELECT * FROM user_profile WHERE user_id=?`).bind(userId).first<Record<string, unknown>>();
  if (!row) throw new Error("profile_missing");
  const month = new Date().toISOString().slice(0, 7);
  let weights = parseJson<Record<string, number>>(row.tag_weights, {});
  if (row.last_decay_month && row.last_decay_month !== month) {
    weights = decayWeights(weights);
    await db.prepare(`UPDATE user_profile SET tag_weights=?,last_decay_month=?,updated_at=CURRENT_TIMESTAMP WHERE user_id=?`).bind(JSON.stringify(weights), month, userId).run();
  } else if (!row.last_decay_month) {
    await db.prepare(`UPDATE user_profile SET last_decay_month=? WHERE user_id=?`).bind(month, userId).run();
  }
  return {
    status: String(row.profile_status ?? "needs_resume") as JobProfile["status"], summary: String(row.profile_summary ?? ""), profileVersion: Number(row.profile_version ?? 1),
    profile: parseJson(row.profile_json, EMPTY_PROFILE), weights, preferences: parseJson(row.explicit_preferences, []), blockedCompanies: parseJson(row.blocked_companies, []),
    activeResumeId: row.active_resume_id ? String(row.active_resume_id) : undefined,
  };
}

async function saveDiscoveredSources(db: D1Database, sources: DiscoveredSource[]): Promise<void> {
  for (const source of sources) {
    try {
      const url = new URL(source.board_url);
      if (url.protocol !== "https:" || !genericHardFilter({ title: "source", location: "", application_url: `${url.origin}/job`, description_excerpt: "", country: "", employment_type: "" }, EMPTY_PROFILE.constraints).eligible) continue;
      const normalized = normalizeCompany(source.company);
      await db.prepare(`INSERT OR IGNORE INTO companies (name,normalized_name) VALUES (?,?)`).bind(source.company, normalized).run();
      await db.prepare(`INSERT OR IGNORE INTO sources (company_id,kind,board_url) SELECT id,?,? FROM companies WHERE normalized_name=?`).bind(source.kind, source.board_url, normalized).run();
    } catch { /* Ignore malformed discovered sources. */ }
  }
}

function candidateFromRow(row: Record<string, unknown>): CandidateInput {
  return {
    company: String(row.company), title: String(row.title), location: String(row.location), application_url: String(row.application_url),
    source_job_id: row.source_job_id ? String(row.source_job_id) : undefined, description_excerpt: String(row.description_excerpt ?? ""),
    content_hash: String(row.content_hash), published_at: row.published_at ? String(row.published_at) : undefined,
    country: String(row.country ?? ""), employment_type: String(row.employment_type ?? ""),
  };
}

export async function prepareFeed(db: D1Database, userId: string, options: FeedOptions, supplied: CandidateInput[], discoveredSources: DiscoveredSource[]) {
  await ensureProfile(db, userId);
  const profile = await getProfile(db, userId);
  if (profile.status !== "active" && !profile.activeResumeId) throw new Error("profile_not_active");
  const schedule = await getScheduleSettings(db, userId);
  if (schedule.paused) return { paused: true, requires_model_review: [], instructions: "Recommendations are paused. Do not create a user-facing message." };
  const key = feedKey(options);
  const completed = await db.prepare(`SELECT id FROM feeds WHERE user_id=? AND feed_key=?`).bind(userId, key).first();
  if (completed) return { feed_key: key, already_committed: true, requires_model_review: [], instructions: "This feed already exists. Call render_feed with the same key." };
  await db.prepare(`INSERT INTO runs (user_id,run_key,kind,status,feed_key,slot_id,profile_version,run_at) VALUES (?,?,'daily','started',?,?,?,?)
    ON CONFLICT(run_key) DO UPDATE SET status='started',error=NULL,updated_at=CURRENT_TIMESTAMP`)
    .bind(userId, `${userId}:${key}`, key, options.slotId, profile.profileVersion, options.runAt).run();

  if (options.discoverSources) await saveDiscoveredSources(db, discoveredSources);
  const sourceRows = await db.prepare(`SELECT s.id,c.name AS company,s.kind,s.board_url FROM sources s JOIN companies c ON c.id=s.company_id WHERE s.active=1`).all<SourceRecord>();
  const candidates: CandidateInput[] = [...supplied];
  const errors: string[] = [];
  await Promise.all(sourceRows.results.map(async (source) => {
    try {
      candidates.push(...await scanSource(source));
      await db.prepare(`UPDATE sources SET last_scanned_at=CURRENT_TIMESTAMP,last_error=NULL WHERE id=?`).bind(source.id).run();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${source.company}: ${message}`);
      await db.prepare(`UPDATE sources SET last_scanned_at=CURRENT_TIMESTAMP,last_error=? WHERE id=?`).bind(message.slice(0, 500), source.id).run();
    }
  }));

  const unique = new Map<string, CandidateInput>();
  for (const candidate of candidates) {
    if (!genericHardFilter(candidate, profile.profile.constraints).eligible) continue;
    const fingerprint = await jobFingerprint(candidate);
    unique.set(fingerprint, { ...candidate, content_hash: candidate.content_hash ?? await sha256(candidate.description_excerpt ?? "") });
  }

  const review = new Map<string, CandidateInput & { fingerprint: string; reason: string }>();
  for (const [fingerprint, candidate] of unique) {
    const existing = await db.prepare(`SELECT id,content_hash FROM jobs WHERE fingerprint=?`).bind(fingerprint).first<{ id: string; content_hash: string }>();
    if (!existing) review.set(fingerprint, { ...candidate, fingerprint, reason: "new" });
    else if (existing.content_hash !== candidate.content_hash) review.set(fingerprint, { ...candidate, fingerprint, reason: "content_changed" });
    else {
      const matched = await db.prepare(`SELECT 1 AS ok FROM user_job_match WHERE user_id=? AND job_id=? AND profile_version=?`).bind(userId, existing.id, profile.profileVersion).first();
      if (!matched) review.set(fingerprint, { ...candidate, fingerprint, reason: "profile_changed" });
    }
  }

  if (review.size < 80) {
    const remaining = await db.prepare(`SELECT j.*,c.name AS company FROM jobs j JOIN companies c ON c.id=j.company_id
      LEFT JOIN user_job_match m ON m.user_id=? AND m.job_id=j.id AND m.profile_version=?
      WHERE j.status='open' AND m.job_id IS NULL ORDER BY j.first_seen_at DESC LIMIT ?`)
      .bind(userId, profile.profileVersion, 80 - review.size).all<Record<string, unknown>>();
    for (const row of remaining.results) review.set(String(row.fingerprint), { ...candidateFromRow(row), fingerprint: String(row.fingerprint), reason: "profile_changed" });
  }

  const needsSponsor = profile.profile.constraints.future_sponsorship_required;
  const sponsorshipReview = options.refreshSponsorship && needsSponsor ? (await db.prepare(`SELECT c.name,c.sponsorship_risk,c.sponsorship_basis,c.evidence_url,c.evidence_checked_at
    FROM companies c WHERE c.evidence_checked_at IS NULL OR date(c.evidence_checked_at)<=date(?, '-30 days') ORDER BY c.name`).bind(options.localDate).all<Record<string, unknown>>()).results : [];
  await db.prepare(`UPDATE runs SET status='prepared',candidate_count=?,cursor_json=?,updated_at=CURRENT_TIMESTAMP WHERE run_key=?`)
    .bind(review.size, JSON.stringify({ options, errors }), `${userId}:${key}`).run();
  return {
    feed_key: key, run_at: options.runAt, local_date: options.localDate, slot_id: options.slotId, max_jobs: Math.max(1, Math.min(30, options.maxJobs)),
    profile_version: profile.profileVersion, profile_summary: profile.summary, job_profile: profile.profile, tag_weights: profile.weights,
    requires_model_review: [...review.values()].slice(0, 80), source_discovery_requested: options.discoverSources,
    sponsorship_refresh_requested: options.refreshSponsorship && needsSponsor, sponsorship_review: sponsorshipReview, source_errors: errors,
    instructions: "Batch-review only requires_model_review. Return public facts plus this profile's eligibility and match. Do not pad below 60.",
  };
}

async function ensureCompany(db: D1Database, item: ClassificationInput): Promise<number> {
  const normalized = normalizeCompany(item.company);
  const companyRisk = item.sponsorship_risk === "low" || item.sponsorship_risk === "medium" ? item.sponsorship_risk : "high";
  await db.prepare(`INSERT INTO companies (name,normalized_name,sponsorship_risk,sponsorship_basis,updated_at) VALUES (?,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(normalized_name) DO UPDATE SET sponsorship_risk=excluded.sponsorship_risk,sponsorship_basis=excluded.sponsorship_basis,updated_at=CURRENT_TIMESTAMP`)
    .bind(item.company, normalized, companyRisk, item.sponsorship_basis).run();
  const row = await db.prepare(`SELECT id FROM companies WHERE normalized_name=?`).bind(normalized).first<{ id: number }>();
  if (!row) throw new Error("company_upsert_failed");
  return row.id;
}

async function upsertClassification(db: D1Database, userId: string, profile: JobProfile, item: ClassificationInput) {
  const companyId = await ensureCompany(db, item);
  let fingerprint = await jobFingerprint(item);
  let id = (await sha256(`job:${fingerprint}`)).slice(0, 24);
  const similar = await db.prepare(`SELECT id,fingerprint FROM jobs WHERE company_id=? AND normalized_title=? AND lower(location)=lower(?) ORDER BY first_seen_at LIMIT 1`)
    .bind(companyId, normalizeTitle(item.title), item.location).first<{ id: string; fingerprint: string }>();
  if (similar) { id = similar.id; fingerprint = similar.fingerprint; }
  const deterministic = genericHardFilter(item, profile.profile.constraints);
  const publicStatus = deterministic.eligible ? "open" : "review";
  const legacyRisk = item.sponsorship_risk === "not_applicable" ? "high" : item.sponsorship_risk;
  await db.prepare(`INSERT INTO jobs (
    id,company_id,source_job_id,fingerprint,title,normalized_title,location,country,employment_type,direction_tags,graduation_eligibility,
    sponsorship_risk,sponsorship_basis,match_points,resume_variant,application_url,description_excerpt,content_hash,base_match_score,published_at,
    first_seen_at,last_verified_at,status,model_reviewed_at,raw_json,eligibility_facts,work_authorization_facts,seniority
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'hybrid',?,?,?,?,?,CURRENT_TIMESTAMP,?,?,CURRENT_TIMESTAMP,?,?,?,?)
  ON CONFLICT(fingerprint) DO UPDATE SET title=excluded.title,normalized_title=excluded.normalized_title,location=excluded.location,country=excluded.country,
    employment_type=excluded.employment_type,direction_tags=excluded.direction_tags,graduation_eligibility=excluded.graduation_eligibility,
    sponsorship_risk=excluded.sponsorship_risk,sponsorship_basis=excluded.sponsorship_basis,application_url=excluded.application_url,
    description_excerpt=excluded.description_excerpt,content_hash=excluded.content_hash,published_at=COALESCE(excluded.published_at,jobs.published_at),
    last_verified_at=excluded.last_verified_at,status=excluded.status,model_reviewed_at=CURRENT_TIMESTAMP,raw_json=excluded.raw_json,
    eligibility_facts=excluded.eligibility_facts,work_authorization_facts=excluded.work_authorization_facts,seniority=excluded.seniority`)
    .bind(id, companyId, item.source_job_id ?? null, fingerprint, item.title, normalizeTitle(item.title), item.location, item.country ?? "", item.employment_type ?? "",
      JSON.stringify(item.direction_tags), item.eligibility_basis, legacyRisk, item.sponsorship_basis, JSON.stringify(item.match_points), item.application_url,
      item.description_excerpt ?? "", item.content_hash ?? await sha256(item.description_excerpt ?? ""), item.resume_match_score, item.published_at ?? null,
      item.verified_at, publicStatus, JSON.stringify(item), JSON.stringify({ eligibility_basis: item.eligibility_basis }), item.work_authorization_facts ?? item.sponsorship_basis, item.seniority ?? "").run();
  const validation = validateClassification(item, profile.profile.constraints);
  await db.prepare(`INSERT INTO user_job_match (user_id,job_id,profile_version,eligible,eligibility_basis,sponsorship_risk,sponsorship_basis,match_score,match_points,resume_focus,matched_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(user_id,job_id,profile_version) DO UPDATE SET eligible=excluded.eligible,eligibility_basis=excluded.eligibility_basis,
    sponsorship_risk=excluded.sponsorship_risk,sponsorship_basis=excluded.sponsorship_basis,match_score=excluded.match_score,
    match_points=excluded.match_points,resume_focus=excluded.resume_focus,matched_at=CURRENT_TIMESTAMP`)
    .bind(userId, id, profile.profileVersion, validation.eligible ? 1 : 0, item.eligibility_basis, item.sponsorship_risk, item.sponsorship_basis,
      item.resume_match_score, JSON.stringify(item.match_points), item.resume_focus).run();
  return { id, included: validation.eligible, reasons: validation.reasons };
}

function rowToRanked(row: Record<string, unknown>, weights: Record<string, number>, now: Date): RankedJob {
  const tags = parseJson<string[]>(row.direction_tags, []);
  const pref = preferenceScore(tags, weights);
  const fresh = freshnessScore(String(row.first_seen_at), now);
  const base = Number(row.match_score ?? row.base_match_score ?? 0);
  return {
    id: String(row.id), company: String(row.company), companyId: Number(row.company_id), title: String(row.title), location: String(row.location), directionTags: tags,
    eligibilityBasis: String(row.match_eligibility_basis ?? row.graduation_eligibility ?? ""), sponsorshipRisk: String(row.match_sponsorship_risk ?? row.sponsorship_risk) as RankedJob["sponsorshipRisk"],
    sponsorshipBasis: String(row.match_sponsorship_basis ?? row.sponsorship_basis ?? ""), matchPoints: parseJson(row.user_match_points ?? row.match_points, []),
    resumeFocus: String(row.resume_focus ?? row.resume_variant ?? "primary resume"), applicationUrl: String(row.application_url), baseMatchScore: base,
    preferenceScore: pref, freshnessScore: fresh, finalScore: finalScore(base, pref, fresh), firstSeenAt: String(row.first_seen_at), lastVerifiedAt: String(row.last_verified_at),
    status: String(row.user_status ?? "undecided") as JobStatus, lastShownAt: row.last_shown_at ? String(row.last_shown_at) : undefined,
    impressionCount: Number(row.impression_count ?? 0), notes: String(row.notes ?? ""),
  };
}

async function applySponsorshipUpdates(db: D1Database, updates: SponsorshipUpdate[]): Promise<void> {
  for (const update of updates) {
    const normalized = normalizeCompany(update.company);
    const expires = new Date(`${update.checked_at}T00:00:00Z`); expires.setUTCDate(expires.getUTCDate() + 30);
    await db.prepare(`UPDATE companies SET sponsorship_risk=?,sponsorship_basis=?,evidence_url=?,evidence_checked_at=?,updated_at=CURRENT_TIMESTAMP WHERE normalized_name=?`)
      .bind(update.risk, update.basis, update.evidence_url ?? null, update.checked_at, normalized).run();
    await db.prepare(`INSERT INTO sponsorship_evidence (company_id,risk,basis,evidence_url,checked_at,expires_at)
      SELECT id,?,?,?,?,? FROM companies WHERE normalized_name=? ON CONFLICT(company_id,evidence_url) DO UPDATE SET risk=excluded.risk,basis=excluded.basis,checked_at=excluded.checked_at,expires_at=excluded.expires_at`)
      .bind(update.risk, update.basis, update.evidence_url ?? null, update.checked_at, expires.toISOString().slice(0, 10), normalized).run();
  }
}

export async function commitFeed(db: D1Database, userId: string, options: FeedOptions, classifications: ClassificationInput[], sponsorshipUpdates: SponsorshipUpdate[] = []) {
  const key = feedKey(options);
  const existing = await db.prepare(`SELECT id FROM feeds WHERE user_id=? AND feed_key=?`).bind(userId, key).first();
  if (existing) return { ...(await renderFeed(db, userId, key)), idempotent: true, rejected: [], quality_floor: 60 };
  const profile = await getProfile(db, userId);
  if (profile.status !== "active" && !profile.activeResumeId) throw new Error("profile_not_active");
  await applySponsorshipUpdates(db, sponsorshipUpdates);
  const results = [];
  for (const item of classifications) results.push(await upsertClassification(db, userId, profile, item));
  const rows = await db.prepare(`SELECT j.*,c.name AS company,m.match_score,m.eligibility_basis AS match_eligibility_basis,m.sponsorship_risk AS match_sponsorship_risk,
    m.sponsorship_basis AS match_sponsorship_basis,m.match_points AS user_match_points,m.resume_focus,
    COALESCE(s.status,'undecided') AS user_status,s.last_shown_at,COALESCE(s.impression_count,0) AS impression_count,COALESCE(s.notes,'') AS notes
    FROM jobs j JOIN companies c ON c.id=j.company_id JOIN user_job_match m ON m.job_id=j.id AND m.user_id=? AND m.profile_version=?
    LEFT JOIN user_job_state s ON s.user_id=? AND s.job_id=j.id
    WHERE j.status='open' AND m.eligible=1 AND m.match_score>=60 AND m.sponsorship_risk!='excluded'`)
    .bind(userId, profile.profileVersion, userId).all<Record<string, unknown>>();
  const blocked = new Set([...profile.blockedCompanies, ...profile.profile.constraints.excluded_companies].map(normalizeCompany));
  const effectiveWeights = { ...profile.weights };
  for (const preference of profile.preferences) effectiveWeights[preference] = Math.min(5, (effectiveWeights[preference] ?? 0) + 2);
  const now = new Date(options.runAt);
  const ranked = rows.results.map((row) => rowToRanked(row, effectiveWeights, now))
    .filter((job) => !blocked.has(normalizeCompany(job.company)) && canShow(job.status, job.lastShownAt, now));
  const chosen = selectFeed(ranked, Math.max(1, Math.min(30, options.maxJobs)), profile.profile.constraints.future_sponsorship_required);
  const verification = await Promise.allSettled(chosen.map(async (job) => ({ job, check: await verifyApplicationUrl(job.applicationUrl) })));
  const selected: RankedJob[] = [];
  for (const checked of verification) {
    if (checked.status === "rejected") continue;
    const { job, check } = checked.value;
    if (!check.open) {
      await db.prepare(`UPDATE jobs SET status='closed',closed_at=CURRENT_TIMESTAMP,last_verified_at=CURRENT_TIMESTAMP WHERE id=?`).bind(job.id).run();
      continue;
    }
    await db.prepare(`UPDATE jobs SET application_url=?,content_hash=?,last_verified_at=CURRENT_TIMESTAMP WHERE id=?`).bind(check.finalUrl, check.contentHash, job.id).run();
    selected.push({ ...job, applicationUrl: check.finalUrl, lastVerifiedAt: new Date().toISOString() });
  }
  const ids = selected.map((job) => job.id);
  await db.prepare(`INSERT INTO feeds (user_id,feed_key,local_date,slot_id,schedule_version,profile_version,max_jobs,job_ids) VALUES (?,?,?,?,?,?,?,?)`)
    .bind(userId, key, options.localDate, options.slotId, options.scheduleVersion, profile.profileVersion, options.maxJobs, JSON.stringify(ids)).run();
  for (const id of ids) await db.prepare(`INSERT INTO user_job_state (user_id,job_id,status,last_shown_at,impression_count) VALUES (?,?,'undecided',CURRENT_TIMESTAMP,1)
    ON CONFLICT(user_id,job_id) DO UPDATE SET last_shown_at=CURRENT_TIMESTAMP,impression_count=impression_count+1,updated_at=CURRENT_TIMESTAMP`).bind(userId, id).run();
  await db.prepare(`UPDATE runs SET status='committed',feed_count=?,finished_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE run_key=?`).bind(ids.length, `${userId}:${key}`).run();
  return { feed_key: key, date: options.localDate, slot_id: options.slotId, count: selected.length, jobs: selected, silent: selected.length === 0, rejected: results.filter((item) => !item.included), quality_floor: 60 };
}

export async function renderFeed(db: D1Database, userId: string, key: string) {
  const feed = await db.prepare(`SELECT * FROM feeds WHERE user_id=? AND feed_key=?`).bind(userId, key).first<Record<string, unknown>>();
  if (!feed) throw new Error("feed_not_found");
  const ids = parseJson<string[]>(feed.job_ids, []);
  const profile = await getProfile(db, userId);
  if (!ids.length) {
    await db.prepare(`UPDATE runs SET status='rendered',finished_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE run_key=?`).bind(`${userId}:${key}`).run();
    return { feed_key: key, date: feed.local_date, slot_id: feed.slot_id, count: 0, jobs: [], silent: true, message: "No jobs met the quality threshold.", blocked_companies: profile.blockedCompanies, explicit_preferences: profile.preferences };
  }
  const placeholders = ids.map(() => "?").join(",");
  const rows = await db.prepare(`SELECT j.*,c.name AS company,m.match_score,m.eligibility_basis AS match_eligibility_basis,m.sponsorship_risk AS match_sponsorship_risk,
    m.sponsorship_basis AS match_sponsorship_basis,m.match_points AS user_match_points,m.resume_focus,
    COALESCE(s.status,'undecided') AS user_status,s.last_shown_at,COALESCE(s.impression_count,0) AS impression_count,COALESCE(s.notes,'') AS notes
    FROM jobs j JOIN companies c ON c.id=j.company_id LEFT JOIN user_job_match m ON m.user_id=? AND m.job_id=j.id AND m.profile_version=?
    LEFT JOIN user_job_state s ON s.user_id=? AND s.job_id=j.id WHERE j.id IN (${placeholders})`)
    .bind(userId, Number(feed.profile_version), userId, ...ids).all<Record<string, unknown>>();
  const byId = new Map(rows.results.map((row) => [String(row.id), rowToRanked(row, profile.weights, new Date())]));
  const jobs = ids.map((id) => byId.get(id)).filter((job): job is RankedJob => Boolean(job) && job?.status === "undecided");
  await db.prepare(`UPDATE runs SET status='rendered',finished_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE run_key=?`).bind(`${userId}:${key}`).run();
  return { feed_key: key, date: feed.local_date, slot_id: feed.slot_id, count: jobs.length, total_count: ids.length, jobs, generated_at: feed.generated_at, blocked_companies: profile.blockedCompanies, explicit_preferences: profile.preferences };
}

export async function prepareDailyFeed(db: D1Database, userId: string, date: string, discoverSources: boolean, refreshSponsorship: boolean, supplied: CandidateInput[], discoveredSources: DiscoveredSource[]) {
  return prepareFeed(db, userId, { runAt: `${date}T20:00:00-04:00`, localDate: date, slotId: "legacy", scheduleVersion: 1, maxJobs: 15, discoverSources, refreshSponsorship }, supplied, discoveredSources);
}

export async function commitDailyFeed(db: D1Database, userId: string, date: string, classifications: ClassificationInput[], sponsorshipUpdates: SponsorshipUpdate[] = []) {
  return commitFeed(db, userId, { runAt: `${date}T20:00:00-04:00`, localDate: date, slotId: "legacy", scheduleVersion: 1, maxJobs: 15, discoverSources: false, refreshSponsorship: false }, classifications, sponsorshipUpdates);
}

export async function renderDailyFeed(db: D1Database, userId: string, date: string) {
  const key = `${date}:legacy:v1`;
  const exists = await db.prepare(`SELECT 1 AS ok FROM feeds WHERE user_id=? AND feed_key=?`).bind(userId, key).first();
  if (exists) return renderFeed(db, userId, key);
  const legacy = await db.prepare(`SELECT job_ids,generated_at,updated_at FROM daily_feeds WHERE user_id=? AND feed_date=?`).bind(userId, date).first<Record<string, unknown>>();
  if (!legacy) throw new Error("feed_not_found");
  const profile = await getProfile(db, userId);
  await db.prepare(`INSERT OR IGNORE INTO feeds (user_id,feed_key,local_date,slot_id,schedule_version,profile_version,max_jobs,job_ids,generated_at,updated_at) VALUES (?,?,?,?,1,?,15,?,?,?)`)
    .bind(userId, key, date, "legacy", profile.profileVersion, legacy.job_ids, legacy.generated_at, legacy.updated_at).run();
  return renderFeed(db, userId, key);
}

export async function recordRunFailure(db: D1Database, userId: string, key: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const runKey = `${userId}:${key}`;
  await db.prepare(`INSERT INTO runs (user_id,run_key,kind,status,error,finished_at,feed_key) VALUES (?,?,'daily','failed',?,CURRENT_TIMESTAMP,?)
    ON CONFLICT(run_key) DO UPDATE SET status='failed',error=excluded.error,finished_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP`)
    .bind(userId, runKey, message.slice(0, 1000), key).run();
}

export async function recordDecision(db: D1Database, userId: string, jobId: string, decision: "interested" | "not_interested", actionId: string) {
  const duplicate = await db.prepare(`SELECT after_state FROM action_log WHERE action_id=? AND user_id=?`).bind(actionId, userId).first<{ after_state: string }>();
  if (duplicate) return { idempotent: true, state: parseJson(duplicate.after_state, {}) };
  const before = await db.prepare(`SELECT * FROM user_job_state WHERE user_id=? AND job_id=?`).bind(userId, jobId).first<Record<string, unknown>>();
  const job = await db.prepare(`SELECT direction_tags FROM jobs WHERE id=?`).bind(jobId).first<{ direction_tags: string }>();
  if (!job) throw new Error("job_not_found");
  const beforeState = before ?? { user_id: userId, job_id: jobId, status: "undecided", notes: "", impression_count: 0 };
  await db.prepare(`INSERT INTO user_job_state (user_id,job_id,status,decided_at,last_action_id) VALUES (?,?,?,CURRENT_TIMESTAMP,?)
    ON CONFLICT(user_id,job_id) DO UPDATE SET status=excluded.status,decided_at=CURRENT_TIMESTAMP,last_action_id=excluded.last_action_id,updated_at=CURRENT_TIMESTAMP`)
    .bind(userId, jobId, decision, actionId).run();
  const after = { ...beforeState, status: decision, decided_at: new Date().toISOString(), last_action_id: actionId };
  await db.prepare(`INSERT INTO action_log (action_id,user_id,job_id,action,before_state,after_state) VALUES (?,?,?,?,?,?)`)
    .bind(actionId, userId, jobId, decision, JSON.stringify(beforeState), JSON.stringify(after)).run();
  const profile = await getProfile(db, userId);
  const next = applyFeedback(profile.weights, parseJson(job.direction_tags, []), decision === "interested" ? 1 : -1);
  await db.prepare(`UPDATE user_profile SET tag_weights=?,updated_at=CURRENT_TIMESTAMP WHERE user_id=?`).bind(JSON.stringify(next), userId).run();
  return { idempotent: false, job_id: jobId, status: decision };
}

export async function undoDecision(db: D1Database, userId: string, actionId: string) {
  const action = await db.prepare(`SELECT * FROM action_log WHERE action_id=? AND user_id=? AND undone_at IS NULL`).bind(actionId, userId).first<Record<string, unknown>>();
  if (!action) throw new Error("undo_not_available");
  const before = parseJson<Record<string, unknown>>(action.before_state, {});
  await db.prepare(`UPDATE user_job_state SET status=?,decided_at=?,applied_at=?,notes=?,last_action_id=NULL,updated_at=CURRENT_TIMESTAMP WHERE user_id=? AND job_id=?`)
    .bind(before.status ?? "undecided", before.decided_at ?? null, before.applied_at ?? null, before.notes ?? "", userId, action.job_id).run();
  await db.prepare(`UPDATE action_log SET undone_at=CURRENT_TIMESTAMP WHERE action_id=?`).bind(actionId).run();
  return { job_id: action.job_id, status: before.status ?? "undecided" };
}

export async function listSavedJobs(db: D1Database, userId: string, page: number, pageSize: number) {
  const profile = await getProfile(db, userId);
  const offset = (page - 1) * pageSize;
  const rows = await db.prepare(`SELECT j.id,c.name AS company,j.title,j.location,j.direction_tags,COALESCE(m.sponsorship_risk,j.sponsorship_risk) AS sponsorship_risk,
    COALESCE(m.sponsorship_basis,j.sponsorship_basis) AS sponsorship_basis,j.application_url,j.last_verified_at,m.match_points,m.resume_focus,m.match_score,
    s.status,s.decided_at AS saved_at,s.applied_at,s.notes FROM user_job_state s JOIN jobs j ON j.id=s.job_id JOIN companies c ON c.id=j.company_id
    LEFT JOIN user_job_match m ON m.user_id=s.user_id AND m.job_id=j.id AND m.profile_version=?
    WHERE s.user_id=? AND s.status IN ('interested','applied') ORDER BY COALESCE(s.applied_at,s.decided_at,s.updated_at) DESC LIMIT ? OFFSET ?`)
    .bind(profile.profileVersion, userId, pageSize, offset).all<Record<string, unknown>>();
  const total = await db.prepare(`SELECT COUNT(*) AS n FROM user_job_state WHERE user_id=? AND status IN ('interested','applied')`).bind(userId).first<{ n: number }>();
  return { page, page_size: pageSize, total: total?.n ?? 0, jobs: rows.results.map((row) => ({ ...row, direction_tags: parseJson(row.direction_tags, []), match_points: parseJson(row.match_points, []) })) };
}

export async function updateJobStatus(db: D1Database, userId: string, jobId: string, status: JobStatus, notes: string | undefined, actionId: string) {
  const duplicate = await db.prepare(`SELECT after_state FROM action_log WHERE action_id=? AND user_id=?`).bind(actionId, userId).first<{ after_state: string }>();
  if (duplicate) return { idempotent: true, state: parseJson(duplicate.after_state, {}) };
  const before = await db.prepare(`SELECT * FROM user_job_state WHERE user_id=? AND job_id=?`).bind(userId, jobId).first<Record<string, unknown>>();
  const beforeState = before ?? { status: "undecided", notes: "" };
  await db.prepare(`INSERT INTO user_job_state (user_id,job_id,status,decided_at,applied_at,notes,last_action_id) VALUES (?,?,?,CURRENT_TIMESTAMP,CASE WHEN ?='applied' THEN CURRENT_TIMESTAMP END,?,?)
    ON CONFLICT(user_id,job_id) DO UPDATE SET status=excluded.status,decided_at=CURRENT_TIMESTAMP,applied_at=CASE WHEN excluded.status='applied' THEN CURRENT_TIMESTAMP ELSE applied_at END,notes=excluded.notes,last_action_id=excluded.last_action_id,updated_at=CURRENT_TIMESTAMP`)
    .bind(userId, jobId, status, status, notes ?? String(beforeState.notes ?? ""), actionId).run();
  const after = { ...beforeState, status, notes: notes ?? beforeState.notes, applied_at: status === "applied" ? new Date().toISOString() : beforeState.applied_at };
  await db.prepare(`INSERT INTO action_log (action_id,user_id,job_id,action,before_state,after_state) VALUES (?,?,?,?,?,?)`)
    .bind(actionId, userId, jobId, `status:${status}`, JSON.stringify(beforeState), JSON.stringify(after)).run();
  if (status === "applied" && beforeState.status !== "applied") {
    const job = await db.prepare(`SELECT direction_tags FROM jobs WHERE id=?`).bind(jobId).first<{ direction_tags: string }>();
    const profile = await getProfile(db, userId);
    const next = applyFeedback(profile.weights, parseJson(job?.direction_tags, []), 2);
    await db.prepare(`UPDATE user_profile SET tag_weights=?,updated_at=CURRENT_TIMESTAMP WHERE user_id=?`).bind(JSON.stringify(next), userId).run();
  }
  return { idempotent: false, job_id: jobId, status, notes: after.notes };
}

export async function updatePreferences(db: D1Database, userId: string, blockedCompanies: string[], preferences: string[]) {
  await ensureProfile(db, userId);
  const blocked = [...new Set(blockedCompanies.map((value) => value.trim()).filter(Boolean))];
  const prefs = [...new Set(preferences.map((value) => value.trim()).filter(Boolean))];
  await db.prepare(`UPDATE user_profile SET blocked_companies=?,explicit_preferences=?,updated_at=CURRENT_TIMESTAMP WHERE user_id=?`).bind(JSON.stringify(blocked), JSON.stringify(prefs), userId).run();
  return { blocked_companies: blocked, explicit_preferences: prefs };
}

function csvCell(value: unknown): string { return `"${String(value ?? "").replace(/"/g, '""')}"`; }

export async function exportSavedCsv(db: D1Database, userId: string) {
  const rows = await db.prepare(`SELECT c.name AS company,j.title,j.location,j.sponsorship_risk,j.sponsorship_basis,j.direction_tags,s.status,s.decided_at,s.applied_at,s.notes,j.last_verified_at,j.application_url
    FROM user_job_state s JOIN jobs j ON j.id=s.job_id JOIN companies c ON c.id=j.company_id WHERE s.user_id=? AND s.status!='undecided' ORDER BY s.updated_at DESC`)
    .bind(userId).all<Record<string, unknown>>();
  const columns = ["company","title","location","sponsorship_risk","sponsorship_basis","direction_tags","status","saved_at","applied_at","notes","last_verified_at","application_url"];
  const csv = [columns.join(","), ...rows.results.map((row) => columns.map((column) => csvCell(column === "saved_at" ? row.decided_at : row[column])).join(","))].join("\n");
  return { filename: `job-feed-${new Date().toISOString().slice(0, 10)}.csv`, csv, count: rows.results.length };
}
