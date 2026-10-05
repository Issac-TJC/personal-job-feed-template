import { McpServer } from "@modelcontextprotocol/server";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import widgetHtml from "../dist/widget/index.html";
import {
  commitDailyFeed, commitFeed, exportSavedCsv, listSavedJobs, prepareDailyFeed, prepareFeed, recordDecision, recordRunFailure,
  renderDailyFeed, renderFeed, undoDecision, updateJobStatus, updatePreferences,
} from "./db";
import { requireScope } from "./auth";
import {
  confirmProfile, deleteResumeProfile, getActiveResumeFile, getJobProfile, getOnboardingState, getScheduleSettings, getStagedResumeText,
  markScheduleSynced, saveProfileDraft, stageResume, updateScheduleSettings,
} from "./profile";
import type { ClassificationInput, Env, Principal } from "./types";

const UI_URI = "ui://job-feed/main.html";
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const runAtSchema = z.string().min(10).max(64);
const candidateSchema = z.object({
  company: z.string().min(1), title: z.string().min(1), location: z.string(), application_url: z.string().url(),
  source_job_id: z.string().optional(), description_excerpt: z.string().max(5000).optional(), content_hash: z.string().optional(),
  published_at: z.string().optional(), country: z.string().optional(), employment_type: z.string().optional(),
});
const classificationSchema = candidateSchema.extend({
  eligible: z.boolean(), exclusion_reason: z.string().optional(), eligibility_basis: z.string().optional(), graduation_eligibility: z.string().optional(),
  sponsorship_risk: z.enum(["low", "medium", "high", "excluded", "not_applicable"]), sponsorship_basis: z.string().min(1),
  direction_tags: z.array(z.string()).min(1).max(12), resume_match_score: z.number().min(0).max(100), match_points: z.array(z.string()).max(8),
  resume_focus: z.string().optional(), resume_variant: z.string().optional(), verified_at: z.string().min(1), seniority: z.string().optional(), work_authorization_facts: z.string().optional(),
}).refine((value) => Boolean(value.eligibility_basis || value.graduation_eligibility), "eligibility_basis is required")
  .refine((value) => Boolean(value.resume_focus || value.resume_variant), "resume_focus is required");
const sourceSchema = z.object({ company: z.string().min(1), kind: z.enum(["greenhouse","lever","ashby","smartrecruiters","workday","official"]), board_url: z.string().url() });
const sponsorshipUpdateSchema = z.object({ company: z.string().min(1), risk: z.enum(["low","medium","high"]), basis: z.string().min(1), evidence_url: z.string().url().optional(), checked_at: dateSchema });
const fileSchema = z.object({ download_url: z.string().url(), file_id: z.string().min(1), mime_type: z.string().optional(), file_name: z.string().optional() }).strict();
const constraintsSchema = z.object({
  target_roles: z.array(z.string()).max(30), target_industries: z.array(z.string()).max(30), seniority_levels: z.array(z.string()).max(20),
  countries: z.array(z.string()).max(30), locations: z.array(z.string()).max(50), remote_preference: z.enum(["any","remote","hybrid","onsite"]),
  employment_types: z.array(z.string()).max(20), available_from: z.string().optional(), current_work_authorization: z.string().max(500).optional(),
  future_sponsorship_required: z.boolean(), salary_notes: z.string().max(500).optional(), excluded_companies: z.array(z.string()).max(100), excluded_industries: z.array(z.string()).max(50),
});
const profileSchema = z.object({
  education: z.array(z.string()).max(20), experience: z.array(z.string()).max(30), projects: z.array(z.string()).max(30), skills: z.array(z.string()).max(100),
  skill_tags: z.array(z.string()).min(1).max(50), constraints: constraintsSchema,
});
const slotSchema = z.object({ id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/i), time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/), max_jobs: z.number().int().min(1).max(30) });
const looseOutput = z.object({}).passthrough();

function result(data: Record<string, unknown>, summary?: string) {
  return { content: [{ type: "text" as const, text: summary ?? JSON.stringify(data) }], structuredContent: data };
}

function appMeta(visibility: ("model" | "app")[] = ["model", "app"]) {
  return { ui: { resourceUri: UI_URI, visibility } };
}

function normalizeClassification(value: z.infer<typeof classificationSchema>): ClassificationInput {
  return {
    ...value,
    eligibility_basis: value.eligibility_basis ?? value.graduation_eligibility ?? "Eligibility unclear",
    resume_focus: value.resume_focus ?? value.resume_variant ?? "primary resume",
  };
}

const feedOptionsSchema = z.object({
  run_at: runAtSchema, local_date: dateSchema, slot_id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/i), schedule_version: z.number().int().min(1),
  max_jobs: z.number().int().min(1).max(30), discover_sources: z.boolean().default(false), refresh_sponsorship: z.boolean().default(false),
});

export function buildMcpServer(env: Env, principal: Principal): McpServer {
  const server = new McpServer({ name: "personal-job-feed", version: "1.0.0" }, {
    instructions: "Use get_onboarding_state first when profile readiness is unknown. For a scheduled feed, call prepare_feed, batch-review only returned candidates, call commit_feed once, and render only when count is greater than zero.",
  });

  registerAppResource(server, "Personal Job Feed", UI_URI, {
    description: "Resume onboarding, job discovery deck, saved jobs, preferences, and schedule settings.", _meta: { ui: { prefersBorder: false } },
  }, async () => ({ contents: [{ uri: UI_URI, mimeType: RESOURCE_MIME_TYPE, text: widgetHtml, _meta: { ui: { prefersBorder: false } } }] }));

  server.registerTool("get_authenticated_profile", {
    title: "Get connected account", description: "Return the stable authenticated identity for this private deployment.", inputSchema: z.object({}),
    outputSchema: z.object({ id: z.string(), nickname: z.string() }), annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    _meta: { "openai/profile": true },
  }, async () => {
    requireScope(principal, "jobfeed:read");
    return result({ id: principal.sub, nickname: "Private Job Feed owner" });
  });

  registerAppTool(server, "get_onboarding_state", {
    title: "Open job feed setup", description: "Open the app and return resume profile and schedule readiness.", inputSchema: z.object({}), outputSchema: looseOutput,
    annotations: { readOnlyHint: true, destructiveHint: false }, _meta: appMeta(),
  }, async () => {
    requireScope(principal, "jobfeed:read");
    return result(await getOnboardingState(env.JOB_FEED_DB, principal.sub), "Job Feed setup is ready.");
  });

  registerAppTool(server, "stage_resume", {
    title: "Upload resume", description: "Validate a PDF, DOCX, or TXT resume up to 10 MiB, store the original privately in R2, and stage its extracted text for profile creation.",
    inputSchema: z.object({ file: fileSchema }), outputSchema: looseOutput,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    _meta: { ...appMeta(), "openai/fileParams": ["file"] },
  }, async ({ file }) => {
    requireScope(principal, "jobfeed:resume");
    return result(await stageResume(env, principal.sub, file), "Resume staged. Analyze it once, create a draft, and ask the user to confirm.");
  });

  server.registerTool("get_staged_resume_text", {
    title: "Read staged resume", description: "Read normalized text from a resume the user explicitly staged, only to generate a profile draft.",
    inputSchema: z.object({ resume_id: z.string().uuid() }), outputSchema: looseOutput, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ resume_id }) => {
    requireScope(principal, "jobfeed:resume");
    return result(await getStagedResumeText(env, principal.sub, resume_id));
  });

  server.registerTool("save_profile_draft", {
    title: "Save job profile draft", description: "Save a structured profile inferred from the staged resume. The draft is not active until the user confirms it in the app.",
    inputSchema: z.object({ resume_id: z.string().uuid(), summary: z.string().min(50).max(4000), profile: profileSchema, tag_weights: z.record(z.string(), z.number().min(-5).max(5)) }),
    outputSchema: looseOutput, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, async ({ resume_id, summary, profile, tag_weights }) => {
    requireScope(principal, "jobfeed:resume");
    requireScope(principal, "jobfeed:write");
    return result(await saveProfileDraft(env, principal.sub, resume_id, summary, profile, tag_weights), "Profile draft saved. Open the app for review and confirmation.");
  });

  registerAppTool(server, "get_job_profile", {
    title: "Get job profile", description: "Return the active or draft structured job profile and resume metadata.", inputSchema: z.object({}), outputSchema: looseOutput,
    annotations: { readOnlyHint: true, destructiveHint: false }, _meta: appMeta(),
  }, async () => {
    requireScope(principal, "jobfeed:read");
    return result(await getJobProfile(env.JOB_FEED_DB, principal.sub));
  });

  registerAppTool(server, "confirm_profile", {
    title: "Confirm job profile", description: "Activate the reviewed profile draft, increment its version when replacing an active profile, and delete the previous resume.",
    inputSchema: z.object({ confirmed: z.literal(true) }), outputSchema: looseOutput,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }, _meta: appMeta(["app"]),
  }, async () => {
    requireScope(principal, "jobfeed:resume"); requireScope(principal, "jobfeed:write");
    return result(await confirmProfile(env, principal.sub), "Profile activated.");
  });

  registerAppTool(server, "delete_resume_profile", {
    title: "Delete resume and profile", description: "Permanently delete all resume objects, the structured profile, and cached matches. Job decisions are preserved.",
    inputSchema: z.object({ confirmation: z.literal("DELETE") }), outputSchema: looseOutput,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true }, _meta: appMeta(["app"]),
  }, async () => {
    requireScope(principal, "jobfeed:resume"); requireScope(principal, "jobfeed:write");
    return result(await deleteResumeProfile(env, principal.sub), "Resume and profile deleted.");
  });

  registerAppTool(server, "download_active_resume", {
    title: "Download active resume", description: "Return the authenticated user's active resume to the app as a private downloadable file.", inputSchema: z.object({}), outputSchema: looseOutput,
    annotations: { readOnlyHint: true, destructiveHint: false }, _meta: appMeta(["app"]),
  }, async () => {
    requireScope(principal, "jobfeed:resume");
    const file = await getActiveResumeFile(env, principal.sub);
    return {
      content: [{ type: "resource" as const, resource: { uri: `file:///${encodeURIComponent(file.file_name)}`, mimeType: file.mime_type, blob: file.base64 } }],
      structuredContent: { file_name: file.file_name, mime_type: file.mime_type, byte_size: file.byte_size },
    };
  });

  registerAppTool(server, "get_schedule_settings", {
    title: "Get recommendation schedule", description: "Return desired schedule and whether ChatGPT has acknowledged the current version.", inputSchema: z.object({}), outputSchema: looseOutput,
    annotations: { readOnlyHint: true, destructiveHint: false }, _meta: appMeta(),
  }, async () => { requireScope(principal, "jobfeed:read"); return result({ ...(await getScheduleSettings(env.JOB_FEED_DB, principal.sub)) }); });

  registerAppTool(server, "update_schedule_settings", {
    title: "Update recommendation schedule", description: "Save timezone, ISO weekdays, one to three daily slots, per-slot job counts, and paused state. This does not itself change ChatGPT Scheduled Tasks.",
    inputSchema: z.object({ timezone: z.string().min(1).max(100), weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7), slots: z.array(slotSchema).min(1).max(3), paused: z.boolean() }),
    outputSchema: looseOutput, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }, _meta: appMeta(["app"]),
  }, async ({ timezone, weekdays, slots, paused }) => {
    requireScope(principal, "jobfeed:write");
    return result(await updateScheduleSettings(env.JOB_FEED_DB, principal.sub, timezone, weekdays, slots, paused), "Schedule preference saved. Ask ChatGPT to apply the returned schedule prompt.");
  });

  server.registerTool("mark_schedule_synced", {
    title: "Mark schedule applied", description: "Mark a schedule version synchronized only after ChatGPT successfully creates, updates, or removes all matching Scheduled Tasks.",
    inputSchema: z.object({ version: z.number().int().min(1) }), outputSchema: looseOutput, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, async ({ version }) => { requireScope(principal, "jobfeed:write"); return result(await markScheduleSynced(env.JOB_FEED_DB, principal.sub, version)); });

  server.registerTool("prepare_feed", {
    title: "Prepare job feed", description: "Scan cached ATS sources and return only new, changed, or profile-unmatched jobs for one batched model review.",
    inputSchema: feedOptionsSchema.extend({ discovered_candidates: z.array(candidateSchema).max(100).default([]), discovered_sources: z.array(sourceSchema).max(30).default([]) }),
    outputSchema: looseOutput, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, async ({ run_at, local_date, slot_id, schedule_version, max_jobs, discover_sources, refresh_sponsorship, discovered_candidates, discovered_sources }) => {
    requireScope(principal, "jobfeed:write");
    const options = { runAt: run_at, localDate: local_date, slotId: slot_id, scheduleVersion: schedule_version, maxJobs: max_jobs, discoverSources: discover_sources, refreshSponsorship: refresh_sponsorship };
    try { return result(await prepareFeed(env.JOB_FEED_DB, principal.sub, options, discovered_candidates, discovered_sources), "Feed batch prepared."); }
    catch (error) { await recordRunFailure(env.JOB_FEED_DB, principal.sub, `${local_date}:${slot_id}:v${schedule_version}`, error); throw error; }
  });

  server.registerTool("commit_feed", {
    title: "Commit job feed", description: "Persist public job facts separately from this profile's match results and create an idempotent feed.",
    inputSchema: feedOptionsSchema.extend({ classifications: z.array(classificationSchema).max(100), sponsorship_updates: z.array(sponsorshipUpdateSchema).max(100).default([]) }),
    outputSchema: looseOutput, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, async ({ run_at, local_date, slot_id, schedule_version, max_jobs, discover_sources, refresh_sponsorship, classifications, sponsorship_updates }) => {
    requireScope(principal, "jobfeed:write");
    const options = { runAt: run_at, localDate: local_date, slotId: slot_id, scheduleVersion: schedule_version, maxJobs: max_jobs, discoverSources: discover_sources, refreshSponsorship: refresh_sponsorship };
    try {
      const data = await commitFeed(env.JOB_FEED_DB, principal.sub, options, classifications.map(normalizeClassification), sponsorship_updates);
      return result(data, data.count ? `${data.count} jobs are ready.` : "No jobs met the quality threshold. Do not send a user-facing feed.");
    } catch (error) { await recordRunFailure(env.JOB_FEED_DB, principal.sub, `${local_date}:${slot_id}:v${schedule_version}`, error); throw error; }
  });

  registerAppTool(server, "render_feed", {
    title: "Open job feed", description: "Open a non-empty feed in the interactive fullscreen app.", inputSchema: z.object({ feed_key: z.string().min(1).max(150) }), outputSchema: looseOutput,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }, _meta: appMeta(),
  }, async ({ feed_key }) => {
    requireScope(principal, "jobfeed:read");
    const data = await renderFeed(env.JOB_FEED_DB, principal.sub, feed_key);
    return result(data, data.count ? `${data.count} jobs are ready.` : "No jobs met the quality threshold.");
  });

  // Compatibility tools for the original single-daily New Grad automation.
  server.registerTool("prepare_daily_feed", {
    title: "Prepare legacy daily feed", description: "Compatibility wrapper for the original daily feed. New schedules should use prepare_feed.",
    inputSchema: z.object({ date: dateSchema, discover_sources: z.boolean().default(false), refresh_sponsorship: z.boolean().default(false), discovered_candidates: z.array(candidateSchema).max(100).default([]), discovered_sources: z.array(sourceSchema).max(30).default([]) }),
    outputSchema: looseOutput, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, async ({ date, discover_sources, refresh_sponsorship, discovered_candidates, discovered_sources }) => {
    requireScope(principal, "jobfeed:write");
    return result(await prepareDailyFeed(env.JOB_FEED_DB, principal.sub, date, discover_sources, refresh_sponsorship, discovered_candidates, discovered_sources));
  });

  server.registerTool("commit_daily_feed", {
    title: "Commit legacy daily feed", description: "Compatibility wrapper for the original daily feed. New schedules should use commit_feed.",
    inputSchema: z.object({ date: dateSchema, classifications: z.array(classificationSchema).max(100), sponsorship_updates: z.array(sponsorshipUpdateSchema).max(100).default([]) }), outputSchema: looseOutput,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, async ({ date, classifications, sponsorship_updates }) => {
    requireScope(principal, "jobfeed:write");
    return result(await commitDailyFeed(env.JOB_FEED_DB, principal.sub, date, classifications.map(normalizeClassification), sponsorship_updates));
  });

  registerAppTool(server, "render_daily_feed", {
    title: "Open legacy daily feed", description: "Compatibility wrapper that opens the original daily feed.", inputSchema: z.object({ date: dateSchema }), outputSchema: looseOutput,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }, _meta: appMeta(),
  }, async ({ date }) => { requireScope(principal, "jobfeed:read"); return result(await renderDailyFeed(env.JOB_FEED_DB, principal.sub, date)); });

  registerAppTool(server, "record_job_decision", {
    title: "Save swipe decision", description: "Record interested or not-interested. Left is interested and right is not interested.",
    inputSchema: z.object({ job_id: z.string().min(1), decision: z.enum(["interested","not_interested"]), action_id: z.string().uuid() }), outputSchema: looseOutput,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }, _meta: appMeta(["app"]),
  }, async ({ job_id, decision, action_id }) => { requireScope(principal, "jobfeed:write"); return result(await recordDecision(env.JOB_FEED_DB, principal.sub, job_id, decision, action_id)); });

  registerAppTool(server, "undo_job_decision", {
    title: "Undo job decision", description: "Undo a decision by its idempotency key.", inputSchema: z.object({ action_id: z.string().uuid() }), outputSchema: looseOutput,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }, _meta: appMeta(["app"]),
  }, async ({ action_id }) => { requireScope(principal, "jobfeed:write"); return result(await undoDecision(env.JOB_FEED_DB, principal.sub, action_id)); });

  registerAppTool(server, "list_saved_jobs", {
    title: "List saved jobs", description: "List interested and applied jobs.", inputSchema: z.object({ page: z.number().int().min(1).default(1), page_size: z.number().int().min(1).max(100).default(50) }),
    outputSchema: looseOutput, annotations: { readOnlyHint: true, destructiveHint: false }, _meta: appMeta(),
  }, async ({ page, page_size }) => { requireScope(principal, "jobfeed:read"); return result(await listSavedJobs(env.JOB_FEED_DB, principal.sub, page, page_size)); });

  registerAppTool(server, "update_job_status", {
    title: "Update job status", description: "Set a job to undecided, interested, applied, or not interested and optionally save notes.",
    inputSchema: z.object({ job_id: z.string().min(1), status: z.enum(["undecided","interested","applied","not_interested"]), notes: z.string().max(2000).optional(), action_id: z.string().uuid() }), outputSchema: looseOutput,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }, _meta: appMeta(["app"]),
  }, async ({ job_id, status, notes, action_id }) => { requireScope(principal, "jobfeed:write"); return result(await updateJobStatus(env.JOB_FEED_DB, principal.sub, job_id, status, notes, action_id)); });

  registerAppTool(server, "update_preferences", {
    title: "Update job preferences", description: "Set blocked companies and explicit role or skill preferences.",
    inputSchema: z.object({ blocked_companies: z.array(z.string()).max(100), explicit_preferences: z.array(z.string()).max(50) }), outputSchema: looseOutput,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }, _meta: appMeta(["app"]),
  }, async ({ blocked_companies, explicit_preferences }) => { requireScope(principal, "jobfeed:write"); return result(await updatePreferences(env.JOB_FEED_DB, principal.sub, blocked_companies, explicit_preferences)); });

  registerAppTool(server, "export_saved_csv", {
    title: "Export job history CSV", description: "Export interested, applied, and rejected job state with official links.", inputSchema: z.object({}), outputSchema: looseOutput,
    annotations: { readOnlyHint: true, destructiveHint: false }, _meta: appMeta(),
  }, async () => { requireScope(principal, "jobfeed:read"); return result(await exportSavedCsv(env.JOB_FEED_DB, principal.sub), "CSV export is ready."); });

  return server;
}
