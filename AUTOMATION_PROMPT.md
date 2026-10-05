# Scheduled Task Prompt Template

Use the connected `Personal Job Feed` plugin and `$daily-job-feed` skill. This task represents slot `<slot_id>`.

Call `get_job_profile` and `get_schedule_settings`. Use the configured timezone to calculate `run_at` and `local_date`, and use the current schedule version and this slot's `max_jobs`. If the profile is not active, the schedule is paused, this weekday is disabled, or this slot no longer exists, stop without a user-facing message.

Perform concise profile-driven discovery using only concrete company Careers pages and official Greenhouse, Lever, Ashby, SmartRecruiters, or Workday URLs. Call `prepare_feed`; batch-review only the returned `requires_model_review`, using the returned structured profile rather than the original resume. Call `commit_feed` once. If count is zero, stop silently. If count is greater than zero, call `render_feed` with its `feed_key`.

Once per week, include newly verified ATS sources. Once per month, refresh only requested sponsorship evidence and only when the profile requires future sponsorship. Never call a paid API and never auto-apply.
