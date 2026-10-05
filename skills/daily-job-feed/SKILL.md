---
name: daily-job-feed
description: Create and manage a private resume-aware job feed using the connected Personal Job Feed MCP tools. Use for onboarding from a resume, scheduled official-job discovery, feed rendering, schedule synchronization, and saved or applied roles. Do not auto-apply.
---

# Personal Job Feed

Treat the MCP server as the durable source of truth. Do not infer application state or schedule synchronization from chat history.

## Resume onboarding

1. When the user supplies or stages a resume, call `stage_resume` if needed, then call `get_staged_resume_text` once.
2. Create a concise 300–500 token summary plus the complete structured profile accepted by `save_profile_draft`. Use short stable skill tags and weights from -5 to 5.
3. Never invent work authorization, salary, location, or role constraints. Use conservative empty/any defaults when the resume does not establish them and tell the user to review the draft.
4. Call `save_profile_draft`, open `get_onboarding_state`, and wait for the user to confirm in the app. Never call `confirm_profile` on the user's behalf.

## Scheduled feed

1. Call `get_job_profile` and `get_schedule_settings`. Stop silently if recommendations are paused. Use the current slot's ID, count, timezone-local date, and schedule version.
2. Search briefly using the profile's target roles, locations, seniority, employment types, and constraints. Accept only concrete company Careers or official Greenhouse, Lever, Ashby, SmartRecruiters, or Workday job URLs.
3. Call `prepare_feed`. Review only `requires_model_review` in one batch. Return public job facts and user-specific eligibility/match fields. Never resend the resume; use the returned profile summary and structured profile.
4. Treat explicit conflicts with the user's hard constraints as ineligible. Use `not_applicable` sponsorship when the user does not need it; otherwise use low, medium, high, or excluded with a concise evidence basis.
5. Call `commit_feed` once. If its count is zero, stop without a user-facing message. If nonzero, call `render_feed` with the returned feed key.
6. On a weekly discovery run, pass newly verified ATS sources. Refresh company sponsorship evidence monthly only when the profile requires sponsorship.

## Schedule synchronization

When the user asks to apply a schedule, create, update, or remove one stable Scheduled Task per slot. Use the stable name `Personal Job Feed · <slot_id>`. Each task must call this skill and the connected plugin with that slot. Only after every task succeeds, call `mark_schedule_synced` with the exact current version.

## Decisions

Left swipe means `interested`; right swipe means `not_interested`. Never auto-apply. Mark a role `applied` only when the user directly requests it.
