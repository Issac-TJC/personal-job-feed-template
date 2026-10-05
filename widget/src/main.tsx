import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { App as McpApp } from "@modelcontextprotocol/ext-apps";
import { Button } from "@openai/apps-sdk-ui/components/Button";
import { Badge } from "@openai/apps-sdk-ui/components/Badge";
import "./styles.css";

type Tab = "discover" | "saved" | "profile" | "settings";
type Status = "undecided" | "interested" | "applied" | "not_interested";
type Risk = "low" | "medium" | "high" | "not_applicable";

interface Job {
  id: string; company: string; title: string; location: string; directionTags?: string[]; direction_tags?: string[];
  eligibilityBasis?: string; eligibility_basis?: string; graduationEligibility?: string; sponsorshipRisk?: Risk; sponsorship_risk?: Risk;
  sponsorshipBasis?: string; sponsorship_basis?: string; matchPoints?: string[]; match_points?: string[]; resumeFocus?: string; resume_focus?: string;
  applicationUrl?: string; application_url?: string; lastVerifiedAt?: string; last_verified_at?: string; status: Status; notes?: string; finalScore?: number; match_score?: number;
}

interface Feed { feed_key?: string; date: string; slot_id?: string; count: number; jobs: Job[]; message?: string; blocked_companies?: string[]; explicit_preferences?: string[] }
interface ProfileData {
  education: string[]; experience: string[]; projects: string[]; skills: string[]; skill_tags: string[];
  constraints: { target_roles: string[]; target_industries: string[]; seniority_levels: string[]; countries: string[]; locations: string[]; remote_preference: string; employment_types: string[]; available_from?: string; current_work_authorization?: string; future_sponsorship_required: boolean; salary_notes?: string; excluded_companies: string[]; excluded_industries: string[] };
}
interface ProfileState { status: "needs_resume" | "draft" | "active"; profile_version: number; summary: string; profile: ProfileData; tag_weights: Record<string, number>; resume: null | { id: string; file_name: string; mime_type: string; byte_size: number; activated_at: string }; draft_resume_id?: string | null }
interface Slot { id: string; time: string; max_jobs: number }
interface ScheduleState { timezone: string; weekdays: number[]; slots: Slot[]; paused: boolean; version: number; syncedVersion?: number; synced_version?: number; schedule_apply_prompt?: string }
interface ToolResult { structuredContent?: Record<string, unknown>; isError?: boolean; content?: unknown }

const emptyProfile: ProfileData = { education: [], experience: [], projects: [], skills: [], skill_tags: [], constraints: { target_roles: [], target_industries: [], seniority_levels: [], countries: [], locations: [], remote_preference: "any", employment_types: ["full_time"], future_sponsorship_required: false, excluded_companies: [], excluded_industries: [] } };
const defaultSchedule: ScheduleState = { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "America/New_York", weekdays: [1,2,3,4,5,6,7], slots: [{ id: "evening", time: "20:00", max_jobs: 15 }], paused: false, version: 1, syncedVersion: 0 };
const bridge = new McpApp({ name: "personal-job-feed-ui", version: "1.0.0" }, {}, { autoResize: true });

function uuid(): string { return crypto.randomUUID(); }
function contentOf(result: ToolResult): Record<string, unknown> { if (result.isError) throw new Error("工具调用失败，请稍后重试"); return result.structuredContent ?? {}; }
async function callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> { return contentOf(await bridge.callServerTool({ name, arguments: args }) as ToolResult); }
function lines(value: string): string[] { return value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean); }
function textList(value: string[]): string { return value.join("\n"); }

function normalizeJob(job: Job): Job {
  return { ...job, directionTags: job.directionTags ?? job.direction_tags ?? [], eligibilityBasis: job.eligibilityBasis ?? job.eligibility_basis ?? job.graduationEligibility,
    sponsorshipRisk: job.sponsorshipRisk ?? job.sponsorship_risk, sponsorshipBasis: job.sponsorshipBasis ?? job.sponsorship_basis,
    matchPoints: job.matchPoints ?? job.match_points ?? [], resumeFocus: job.resumeFocus ?? job.resume_focus, applicationUrl: job.applicationUrl ?? job.application_url,
    lastVerifiedAt: job.lastVerifiedAt ?? job.last_verified_at, finalScore: job.finalScore ?? job.match_score };
}

const riskLabels: Record<Risk, string> = { low: "Sponsor 低风险", medium: "Sponsor 中风险", high: "Sponsor 较高风险", not_applicable: "无需 Sponsor" };

function JobCard({ job, offset, onDecision, onApply }: { job: Job; offset: number; onDecision: (decision: "interested" | "not_interested") => void; onApply: () => void }) {
  const [drag, setDrag] = useState(0);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const risk = job.sponsorshipRisk ?? "high";
  const release = () => { if (drag <= -90) onDecision("interested"); else if (drag >= 90) onDecision("not_interested"); setDrag(0); origin.current = null; };
  return <article className="job-card" style={{ transform: `translate3d(${drag}px, ${offset * 9}px, 0) rotate(${drag / 34}deg) scale(${1 - offset * .025})`, zIndex: 10 - offset }}
    onPointerDown={(event) => { origin.current = { x: event.clientX, y: event.clientY }; event.currentTarget.setPointerCapture(event.pointerId); }}
    onPointerMove={(event) => { if (!origin.current) return; const dx = event.clientX - origin.current.x; const dy = event.clientY - origin.current.y; if (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy) * 1.2) setDrag(dx); }}
    onPointerUp={release} onPointerCancel={() => { setDrag(0); origin.current = null; }}>
    <div className={`swipe-hint interested ${drag < -30 ? "visible" : ""}`}>感兴趣</div>
    <div className={`swipe-hint reject ${drag > 30 ? "visible" : ""}`}>不感兴趣</div>
    <div className="card-head"><div><p className="company">{job.company}</p><h2>{job.title}</h2></div><Badge color="secondary" variant="soft" pill>{riskLabels[risk]}</Badge></div>
    <p className="location">{job.location}</p>
    <div className="tags">{job.directionTags?.map((tag) => <Badge key={tag} color="secondary" variant="soft" pill>{tag.replaceAll("_", " ")}</Badge>)}</div>
    <section><h3>资格判断</h3><p>{job.eligibilityBasis || "符合当前画像的基础条件"}</p></section>
    <section><h3>工作许可 / Sponsorship</h3><p>{job.sponsorshipBasis}</p></section>
    {!!job.matchPoints?.length && <section><h3>匹配点</h3><ul>{job.matchPoints.map((point) => <li key={point}>{point}</li>)}</ul></section>}
    <div className="card-meta"><span>简历侧重：{job.resumeFocus ?? "主简历"}</span><span>匹配 {Math.round(job.finalScore ?? 0)}</span></div>
    <button className="apply-link" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onApply(); }}>打开官网投递 ↗</button>
  </article>;
}

function SavedTable({ refreshKey }: { refreshKey: number }) {
  const [jobs, setJobs] = useState<Job[]>([]); const [busy, setBusy] = useState(false);
  const load = async () => { setBusy(true); try { const data = await callTool("list_saved_jobs", { page: 1, page_size: 100 }); setJobs(((data.jobs as Job[]) ?? []).map(normalizeJob)); } finally { setBusy(false); } };
  useEffect(() => { void load(); }, [refreshKey]);
  const update = async (job: Job, status: Status, notes = job.notes ?? "") => { await callTool("update_job_status", { job_id: job.id, status, notes, action_id: uuid() }); await load(); };
  if (busy && !jobs.length) return <div className="empty">正在读取 Saved…</div>;
  if (!jobs.length) return <div className="empty">还没有保存的岗位。将卡片向左滑即可加入。</div>;
  return <div className="saved-list">{jobs.map((job) => <article className="saved-row glass-panel" key={job.id}>
    <div className="saved-main"><strong>{job.company}</strong><h3>{job.title}</h3><p>{job.location}</p><div className="tags">{job.directionTags?.slice(0, 4).map((tag) => <Badge key={tag} color="secondary" variant="soft">{tag}</Badge>)}</div></div>
    <div className="saved-controls"><select aria-label="岗位状态" value={job.status} onChange={(event) => void update(job, event.target.value as Status)}><option value="interested">感兴趣</option><option value="applied">已投</option><option value="not_interested">不感兴趣</option></select>
      <input aria-label="备注" defaultValue={job.notes ?? ""} placeholder="备注" onBlur={(event) => { if (event.target.value !== (job.notes ?? "")) void update(job, job.status, event.target.value); }} />
      <Button color="secondary" onClick={() => job.applicationUrl && void bridge.openLink({ url: job.applicationUrl })}>投递链接</Button></div>
    <small>最后核验：{job.lastVerifiedAt?.slice(0, 10) ?? "未知"}</small>
  </article>)}</div>;
}

function ResumeUploader({ onStaged }: { onStaged: () => void }) {
  const input = useRef<HTMLInputElement>(null); const [busy, setBusy] = useState(false); const [message, setMessage] = useState("");
  const upload = async (file: File) => {
    const host = (window as unknown as { openai?: { uploadFile?: (file: File, options?: { library?: boolean }) => Promise<{ fileId: string }>; getFileDownloadUrl?: (input: { fileId: string }) => Promise<{ downloadUrl: string }>; sendFollowUpMessage?: (input: { prompt: string; scrollToBottom?: boolean }) => Promise<void> } }).openai;
    if (!host?.uploadFile || !host.getFileDownloadUrl) { setMessage("当前客户端不支持组件内上传。请在聊天中附上简历并让插件建立画像。"); return; }
    setBusy(true); setMessage("");
    try {
      const { fileId } = await host.uploadFile(file, { library: true });
      const { downloadUrl } = await host.getFileDownloadUrl({ fileId });
      const data = await callTool("stage_resume", { file: { file_id: fileId, download_url: downloadUrl, mime_type: file.type, file_name: file.name } });
      const resumeId = String(data.resume_id);
      setMessage("简历已安全保存，正在请求 ChatGPT 建立画像…");
      await host.sendFollowUpMessage?.({ prompt: `请使用已连接的 Job Feed 插件读取 staged resume ${resumeId}。调用 get_staged_resume_text，仅根据简历内容生成通用求职画像；对目标岗位、地点、用工类型和工作许可不明确的内容使用保守默认并在画像中标明。调用 save_profile_draft 保存草稿，但不要确认生效。完成后调用 get_onboarding_state 重新打开画像预览。`, scrollToBottom: true });
      onStaged();
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); }
  };
  return <div className="upload-box"><input ref={input} type="file" accept=".pdf,.docx,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void upload(file); }} />
    <p><strong>上传简历建立画像</strong><span>PDF、DOCX 或 TXT，最大 10 MiB。原件仅保存在你的私有 R2。</span></p><Button color="secondary" disabled={busy} onClick={() => input.current?.click()}>{busy ? "上传中…" : "选择简历"}</Button>{message && <small>{message}</small>}</div>;
}

function ProfilePanel({ profile, reload }: { profile: ProfileState | null; reload: () => Promise<void> }) {
  const [draft, setDraft] = useState<ProfileState | null>(profile); const [message, setMessage] = useState("");
  useEffect(() => setDraft(profile), [profile]);
  if (!draft || draft.status === "needs_resume") return <div className="profile-stack"><ResumeUploader onStaged={() => setMessage("请在聊天中完成一次画像生成。")} />{message && <p className="notice">{message}</p>}</div>;
  const setProfile = (patch: Partial<ProfileData>) => setDraft({ ...draft, profile: { ...draft.profile, ...patch } });
  const setConstraints = (patch: Partial<ProfileData["constraints"]>) => setDraft({ ...draft, profile: { ...draft.profile, constraints: { ...draft.profile.constraints, ...patch } } });
  const saveDraft = async () => {
    if (!draft.draft_resume_id) { setMessage("当前是已生效画像。请上传新简历后再创建替换草稿。"); return; }
    await callTool("save_profile_draft", { resume_id: draft.draft_resume_id, summary: draft.summary, profile: draft.profile, tag_weights: draft.tag_weights }); setMessage("草稿已保存。"); await reload();
  };
  const confirm = async () => { await saveDraft(); await callTool("confirm_profile", { confirmed: true }); setMessage("画像已生效，后续岗位会按新版本重新匹配。"); await reload(); };
  const download = async () => {
    const response = await bridge.callServerTool({ name: "download_active_resume", arguments: {} }) as ToolResult;
    if (response.isError || !Array.isArray(response.content)) throw new Error("简历下载失败");
    await bridge.downloadFile({ contents: response.content as never[] });
  };
  const remove = async () => { if (!window.confirm("永久删除简历原件、画像和匹配缓存？岗位状态会保留。")) return; await callTool("delete_resume_profile", { confirmation: "DELETE" }); await reload(); };
  return <div className="profile-stack">
    <div className="profile-head glass-panel"><div><p className="eyebrow">PROFILE · V{draft.profile_version}</p><h2>{draft.status === "draft" ? "画像草稿待确认" : "当前求职画像"}</h2><p>{draft.resume?.file_name ?? "新上传的简历"}</p></div><div className="profile-actions">{draft.resume && <Button color="secondary" onClick={() => void download()}>下载原件</Button>}<Button color="secondary" onClick={() => void remove()}>删除画像</Button></div></div>
    <div className="form-grid glass-panel"><label className="wide">画像摘要<textarea value={draft.summary} onChange={(event) => setDraft({ ...draft, summary: event.target.value })} /></label>
      <ListField label="目标岗位" value={draft.profile.constraints.target_roles} onChange={(value) => setConstraints({ target_roles: value })} />
      <ListField label="技能标签" value={draft.profile.skill_tags} onChange={(value) => setProfile({ skill_tags: value })} />
      <ListField label="目标国家" value={draft.profile.constraints.countries} onChange={(value) => setConstraints({ countries: value })} />
      <ListField label="目标地点" value={draft.profile.constraints.locations} onChange={(value) => setConstraints({ locations: value })} />
      <ListField label="经验级别" value={draft.profile.constraints.seniority_levels} onChange={(value) => setConstraints({ seniority_levels: value })} />
      <ListField label="用工类型" value={draft.profile.constraints.employment_types} onChange={(value) => setConstraints({ employment_types: value })} />
      <label>办公偏好<select value={draft.profile.constraints.remote_preference} onChange={(event) => setConstraints({ remote_preference: event.target.value })}><option value="any">不限</option><option value="remote">远程</option><option value="hybrid">混合</option><option value="onsite">现场</option></select></label>
      <label>可入职时间<input type="date" value={draft.profile.constraints.available_from ?? ""} onChange={(event) => setConstraints({ available_from: event.target.value || undefined })} /></label>
      <label className="wide">当前工作许可<input value={draft.profile.constraints.current_work_authorization ?? ""} onChange={(event) => setConstraints({ current_work_authorization: event.target.value })} placeholder="例如 F-1 OPT / 无限制" /></label>
      <label className="check-row wide"><input type="checkbox" checked={draft.profile.constraints.future_sponsorship_required} onChange={(event) => setConstraints({ future_sponsorship_required: event.target.checked })} />未来需要雇主 sponsorship</label>
    </div>
    <div className="panel-actions"><Button color="secondary" onClick={() => void saveDraft()}>保存草稿</Button>{draft.status === "draft" && <Button color="secondary" onClick={() => void confirm()}>确认并生效</Button>}<ResumeUploader onStaged={() => setMessage("新简历已暂存，请在聊天中生成替换画像。")} /></div>
    {message && <p className="notice">{message}</p>}
  </div>;
}

function ListField({ label, value, onChange }: { label: string; value: string[]; onChange: (value: string[]) => void }) {
  return <label>{label}<textarea value={textList(value)} onChange={(event) => onChange(lines(event.target.value))} placeholder="每行一个" /></label>;
}

function Settings({ feed, schedule, reloadSchedule }: { feed: Feed | null; schedule: ScheduleState | null; reloadSchedule: () => Promise<void> }) {
  const [blocked, setBlocked] = useState((feed?.blocked_companies ?? []).join("\n")); const [prefs, setPrefs] = useState((feed?.explicit_preferences ?? []).join("\n"));
  const [local, setLocal] = useState<ScheduleState>(schedule ?? defaultSchedule); const [message, setMessage] = useState("");
  useEffect(() => { if (schedule) setLocal(schedule); }, [schedule]);
  const savePrefs = async () => { await callTool("update_preferences", { blocked_companies: lines(blocked), explicit_preferences: lines(prefs) }); setMessage("偏好已保存。"); };
  const saveSchedule = async (apply: boolean) => {
    const data = await callTool("update_schedule_settings", { timezone: local.timezone, weekdays: local.weekdays, slots: local.slots, paused: local.paused });
    setLocal(data as unknown as ScheduleState); await reloadSchedule(); setMessage("推送设置已保存，但尚未在 ChatGPT Scheduled 中应用。");
    if (apply) {
      const host = (window as unknown as { openai?: { sendFollowUpMessage?: (input: { prompt: string; scrollToBottom?: boolean }) => Promise<void> } }).openai;
      if (host?.sendFollowUpMessage) await host.sendFollowUpMessage({ prompt: String(data.schedule_apply_prompt), scrollToBottom: true });
      else setMessage("当前客户端不能直接发送任务配置。请复制下方同步提示到聊天中。");
    }
  };
  const addSlot = () => { if (local.slots.length >= 3) return; const number = local.slots.length + 1; setLocal({ ...local, slots: [...local.slots, { id: `slot-${number}`, time: number === 2 ? "12:00" : "18:00", max_jobs: 15 }] }); };
  const exportCsv = async () => { const data = await callTool("export_saved_csv", {}); await bridge.downloadFile({ contents: [{ type: "resource", resource: { uri: `file:///${String(data.filename)}`, mimeType: "text/csv", text: String(data.csv ?? "") } }] }); };
  const synced = (local.syncedVersion ?? local.synced_version ?? 0) === local.version;
  return <div className="settings-stack">
    <section className="settings-panel glass-panel"><div className="section-title"><div><p className="eyebrow">RECOMMENDATION SCHEDULE</p><h2>推送周期</h2></div><Badge color="secondary" variant="soft">{synced ? "已同步" : "待同步"}</Badge></div>
      <label>时区<input value={local.timezone} onChange={(event) => setLocal({ ...local, timezone: event.target.value })} /></label>
      <div><span className="field-label">运行日期</span><div className="weekday-row">{["一","二","三","四","五","六","日"].map((label, index) => { const day = index + 1; const active = local.weekdays.includes(day); return <button key={day} className={active ? "selected" : ""} onClick={() => setLocal({ ...local, weekdays: active ? local.weekdays.filter((value) => value !== day) : [...local.weekdays, day].sort() })}>{label}</button>; })}</div></div>
      <div className="slot-list">{local.slots.map((slot, index) => <div className="slot-row" key={slot.id}><input type="time" value={slot.time} onChange={(event) => setLocal({ ...local, slots: local.slots.map((item, i) => i === index ? { ...item, time: event.target.value } : item) })} /><label>岗位数<input type="number" min={1} max={30} value={slot.max_jobs} onChange={(event) => setLocal({ ...local, slots: local.slots.map((item, i) => i === index ? { ...item, max_jobs: Number(event.target.value) } : item) })} /></label>{local.slots.length > 1 && <button onClick={() => setLocal({ ...local, slots: local.slots.filter((_, i) => i !== index) })}>移除</button>}</div>)}</div>
      <div className="settings-actions"><Button color="secondary" disabled={local.slots.length >= 3} onClick={addSlot}>增加时段</Button><Button color="secondary" onClick={() => setLocal({ ...local, paused: !local.paused })}>{local.paused ? "恢复推荐" : "暂停推荐"}</Button><Button color="secondary" onClick={() => void saveSchedule(true)}>保存并应用任务</Button></div>
      <p className="privacy-note">版本 {local.version} · “保存”只写入插件；“应用任务”会让 ChatGPT 创建或更新属于你账号的 Scheduled Tasks。</p>
    </section>
    <section className="settings-panel glass-panel"><p className="eyebrow">PREFERENCES</p><h2>推荐偏好</h2><label>明确偏好的方向<textarea value={prefs} onChange={(event) => setPrefs(event.target.value)} placeholder="每行一个" /></label><label>屏蔽公司<textarea value={blocked} onChange={(event) => setBlocked(event.target.value)} placeholder="每行一个公司名" /></label><div className="settings-actions"><Button color="secondary" onClick={() => void savePrefs()}>保存偏好</Button><Button color="secondary" onClick={() => void exportCsv()}>导出 CSV</Button></div></section>
    {message && <p className="notice">{message}</p>}
  </div>;
}

function App() {
  const [feed, setFeed] = useState<Feed | null>(null); const [jobs, setJobs] = useState<Job[]>([]); const [tab, setTab] = useState<Tab>("discover");
  const [profile, setProfile] = useState<ProfileState | null>(null); const [schedule, setSchedule] = useState<ScheduleState | null>(null); const [error, setError] = useState("");
  const [lastAction, setLastAction] = useState<{ actionId: string; job: Job } | null>(null); const [savedRefresh, setSavedRefresh] = useState(0); const [connected, setConnected] = useState(false);
  const acceptData = (value: unknown) => { const next = value as Record<string, unknown>; if (!next) return; if (Array.isArray(next.jobs)) { const normalized = (next.jobs as Job[]).map(normalizeJob).filter((job) => job.status === "undecided"); setFeed({ ...(next as unknown as Feed), jobs: normalized }); setJobs(normalized); }
    if (next.profile && next.schedule) { const nested = next.profile as ProfileState; setProfile(nested); setSchedule(next.schedule as ScheduleState); if (nested.status !== "active") setTab("profile"); }
    else if (next.status && next.profile_version !== undefined) setProfile(next as unknown as ProfileState); };
  const reloadProfile = async () => { const data = await callTool("get_job_profile", {}); setProfile(data as unknown as ProfileState); };
  const reloadSchedule = async () => { const data = await callTool("get_schedule_settings", {}); setSchedule(data as unknown as ScheduleState); };
  useEffect(() => {
    bridge.addEventListener("toolresult", (params) => acceptData(params.structuredContent));
    const legacy = (window as unknown as { openai?: { toolOutput?: unknown } }).openai?.toolOutput; if (legacy) acceptData(legacy);
    void bridge.connect().then(async () => { setConnected(true); const context = bridge.getHostContext(); if (context?.availableDisplayModes?.includes("fullscreen")) await bridge.requestDisplayMode({ mode: "fullscreen" }).catch(() => undefined);
      const state = await callTool("get_onboarding_state", {}); acceptData(state); }).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, []);
  const current = jobs[0]; const progress = useMemo(() => feed ? `${Math.max(0, feed.count - jobs.length)}/${feed.count}` : "—", [feed, jobs.length]);
  const decide = async (decision: "interested" | "not_interested") => { if (!current) return; const actionId = uuid(); const selected = current; setJobs((items) => items.slice(1)); setLastAction({ actionId, job: selected });
    try { await callTool("record_job_decision", { job_id: selected.id, decision, action_id: actionId }); if (decision === "interested") setSavedRefresh((value) => value + 1); }
    catch (cause) { setJobs((items) => [selected, ...items]); setLastAction(null); setError(cause instanceof Error ? cause.message : String(cause)); } };
  const undo = async () => { if (!lastAction) return; await callTool("undo_job_decision", { action_id: lastAction.actionId }); setJobs((items) => [lastAction.job, ...items]); setLastAction(null); setSavedRefresh((value) => value + 1); };
  return <main className="app-shell"><header className="topbar"><div><p className="eyebrow">PRIVATE · PERSONAL</p><h1>Job Feed</h1></div><div className="header-actions"><span className={`status-dot ${connected ? "online" : ""}`}>{connected ? "已连接" : "连接中"}</span><Button color="secondary" onClick={() => void bridge.requestDisplayMode({ mode: "fullscreen" })}>全屏</Button></div></header>
    <nav className="tabs" aria-label="主导航"><button className={tab === "discover" ? "active" : ""} onClick={() => setTab("discover")}>Discover <span>{jobs.length}</span></button><button className={tab === "saved" ? "active" : ""} onClick={() => setTab("saved")}>Saved</button><button className={tab === "profile" ? "active" : ""} onClick={() => setTab("profile")}>Profile</button><button className={tab === "settings" ? "active" : ""} onClick={() => setTab("settings")}>Settings</button></nav>
    {error && <div className="error-banner">{error}<button onClick={() => setError("")}>×</button></div>}
    {tab === "discover" && <section className="discover-view"><div className="progress-row"><span>{feed?.date ?? "最新推荐"}</span><strong>{progress}</strong>{lastAction ? <button onClick={() => void undo()}>撤销</button> : <span />}</div>
      {!feed ? <div className="empty">等待下一次岗位推送…</div> : !current ? <div className="empty done"><span>✓</span><h2>{feed.count ? "本轮卡片已筛完" : feed.message ?? "暂无符合质量线的岗位"}</h2><p>向左滑保存，向右滑忽略；已处理岗位不会立即重复出现。</p></div> : <div className="deck">{jobs.slice(0, 3).reverse().map((job, reverseIndex) => { const index = Math.min(2, jobs.slice(0, 3).length - 1 - reverseIndex); return <JobCard key={job.id} job={job} offset={index} onDecision={(decision) => void decide(decision)} onApply={() => job.applicationUrl && void bridge.openLink({ url: job.applicationUrl })} />; })}</div>}
      <p className="gesture-note">← 左滑感兴趣 · 右滑不感兴趣 →</p></section>}
    {tab === "saved" && <SavedTable refreshKey={savedRefresh} />}
    {tab === "profile" && <ProfilePanel profile={profile} reload={reloadProfile} />}
    {tab === "settings" && <Settings feed={feed} schedule={schedule} reloadSchedule={reloadSchedule} />}
  </main>;
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
