PRAGMA foreign_keys = ON;

ALTER TABLE user_profile ADD COLUMN profile_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE user_profile ADD COLUMN profile_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE user_profile ADD COLUMN profile_status TEXT NOT NULL DEFAULT 'needs_resume';
ALTER TABLE user_profile ADD COLUMN active_resume_id TEXT;
ALTER TABLE user_profile ADD COLUMN draft_resume_id TEXT;
ALTER TABLE user_profile ADD COLUMN draft_profile_json TEXT;
ALTER TABLE user_profile ADD COLUMN draft_summary TEXT;
ALTER TABLE user_profile ADD COLUMN draft_tag_weights TEXT;

UPDATE user_profile
SET profile_status = 'active',
    profile_json = json_object(
      'education', json_array('CMU MS ECE, expected May 2027'),
      'experience', json_array(),
      'projects', json_array(),
      'skills', json_array('Python','C++','FastAPI','PyTorch','Transformers','Docker','SQL','NoSQL','observability'),
      'skill_tags', json_array('agentic_rag','backend_distributed','ai_infra','retrieval_recsys','vlm_cv','lidar_autonomy','generic_sde_fullstack'),
      'constraints', json_object(
        'target_roles', json_array('SDE','MLE'),
        'target_industries', json_array(),
        'seniority_levels', json_array('new_grad','early_career'),
        'countries', json_array('US'),
        'locations', json_array(),
        'remote_preference', 'any',
        'employment_types', json_array('full_time'),
        'available_from', '2027-05-01',
        'current_work_authorization', 'F-1 OPT/STEM OPT',
        'future_sponsorship_required', json('true'),
        'excluded_companies', json_array(),
        'excluded_industries', json_array()
      )
    )
WHERE length(trim(profile_summary)) > 0;

CREATE TABLE IF NOT EXISTS resume_assets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  file_id TEXT,
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size > 0 AND byte_size <= 10485760),
  sha256 TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('staged','active')),
  extracted_text TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  activated_at TEXT,
  expires_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_resume_assets_user_status ON resume_assets(user_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS user_job_match (
  user_id TEXT NOT NULL,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  profile_version INTEGER NOT NULL,
  eligible INTEGER NOT NULL CHECK (eligible IN (0,1)),
  eligibility_basis TEXT NOT NULL DEFAULT '',
  sponsorship_risk TEXT NOT NULL CHECK (sponsorship_risk IN ('low','medium','high','excluded','not_applicable')),
  sponsorship_basis TEXT NOT NULL DEFAULT '',
  match_score REAL NOT NULL CHECK (match_score BETWEEN 0 AND 100),
  match_points TEXT NOT NULL DEFAULT '[]',
  resume_focus TEXT NOT NULL DEFAULT 'primary resume',
  matched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, job_id, profile_version)
);

CREATE INDEX IF NOT EXISTS idx_user_job_match_rank ON user_job_match(user_id, profile_version, eligible, sponsorship_risk, match_score DESC);

INSERT OR IGNORE INTO user_job_match (
  user_id, job_id, profile_version, eligible, eligibility_basis, sponsorship_risk,
  sponsorship_basis, match_score, match_points, resume_focus, matched_at
)
SELECT p.user_id, j.id, p.profile_version,
       CASE WHEN j.status = 'open' AND j.sponsorship_risk != 'excluded' AND j.base_match_score >= 60 THEN 1 ELSE 0 END,
       j.graduation_eligibility,
       j.sponsorship_risk,
       j.sponsorship_basis,
       j.base_match_score,
       j.match_points,
       j.resume_variant,
       COALESCE(j.model_reviewed_at, j.last_verified_at)
FROM user_profile p CROSS JOIN jobs j;

CREATE TABLE IF NOT EXISTS schedule_settings (
  user_id TEXT PRIMARY KEY,
  timezone TEXT NOT NULL DEFAULT 'America/New_York',
  weekdays TEXT NOT NULL DEFAULT '[1,2,3,4,5,6,7]',
  slots TEXT NOT NULL DEFAULT '[{"id":"evening","time":"20:00","max_jobs":15}]',
  paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0,1)),
  version INTEGER NOT NULL DEFAULT 1,
  synced_version INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO schedule_settings (user_id) SELECT user_id FROM user_profile;

CREATE TABLE IF NOT EXISTS feeds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  feed_key TEXT NOT NULL,
  local_date TEXT NOT NULL,
  slot_id TEXT NOT NULL,
  schedule_version INTEGER NOT NULL DEFAULT 1,
  profile_version INTEGER NOT NULL DEFAULT 1,
  max_jobs INTEGER NOT NULL DEFAULT 15 CHECK (max_jobs BETWEEN 1 AND 30),
  job_ids TEXT NOT NULL DEFAULT '[]',
  generated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, feed_key)
);

CREATE INDEX IF NOT EXISTS idx_feeds_user_date ON feeds(user_id, local_date, generated_at DESC);

INSERT OR IGNORE INTO feeds (user_id, feed_key, local_date, slot_id, schedule_version, profile_version, max_jobs, job_ids, generated_at, updated_at)
SELECT d.user_id, d.feed_date || ':legacy:v1', d.feed_date, 'legacy', 1, COALESCE(p.profile_version,1), 15, d.job_ids, d.generated_at, d.updated_at
FROM daily_feeds d LEFT JOIN user_profile p ON p.user_id = d.user_id;

ALTER TABLE jobs ADD COLUMN eligibility_facts TEXT NOT NULL DEFAULT '{}';
ALTER TABLE jobs ADD COLUMN work_authorization_facts TEXT NOT NULL DEFAULT '';
ALTER TABLE jobs ADD COLUMN seniority TEXT NOT NULL DEFAULT '';

ALTER TABLE runs ADD COLUMN feed_key TEXT;
ALTER TABLE runs ADD COLUMN slot_id TEXT;
ALTER TABLE runs ADD COLUMN profile_version INTEGER;
ALTER TABLE runs ADD COLUMN run_at TEXT;
