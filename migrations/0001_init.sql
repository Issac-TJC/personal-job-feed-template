PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  normalized_name TEXT NOT NULL UNIQUE,
  careers_url TEXT,
  sponsorship_risk TEXT NOT NULL DEFAULT 'high' CHECK (sponsorship_risk IN ('low','medium','high')),
  sponsorship_basis TEXT NOT NULL DEFAULT 'No current company-level evidence.',
  evidence_url TEXT,
  evidence_checked_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('greenhouse','lever','ashby','smartrecruiters','workday','official')),
  board_url TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  last_scanned_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  source_id INTEGER REFERENCES sources(id),
  source_job_id TEXT,
  fingerprint TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  normalized_title TEXT NOT NULL,
  location TEXT NOT NULL,
  country TEXT NOT NULL DEFAULT 'US',
  employment_type TEXT NOT NULL DEFAULT 'full_time',
  direction_tags TEXT NOT NULL DEFAULT '[]',
  graduation_eligibility TEXT NOT NULL,
  sponsorship_risk TEXT NOT NULL CHECK (sponsorship_risk IN ('low','medium','high','excluded')),
  sponsorship_basis TEXT NOT NULL,
  match_points TEXT NOT NULL DEFAULT '[]',
  resume_variant TEXT NOT NULL CHECK (resume_variant IN ('SDE','LiDAR/ML','hybrid')),
  application_url TEXT NOT NULL,
  description_excerpt TEXT NOT NULL DEFAULT '',
  content_hash TEXT NOT NULL,
  base_match_score REAL NOT NULL DEFAULT 0 CHECK (base_match_score BETWEEN 0 AND 100),
  published_at TEXT,
  first_seen_at TEXT NOT NULL,
  last_verified_at TEXT NOT NULL,
  closed_at TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','review')),
  model_reviewed_at TEXT,
  raw_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE(company_id, source_job_id)
);

CREATE INDEX IF NOT EXISTS idx_jobs_open_risk ON jobs(status, sponsorship_risk, base_match_score DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_company_title ON jobs(company_id, normalized_title);

CREATE TABLE IF NOT EXISTS user_profile (
  user_id TEXT PRIMARY KEY,
  graduation_date TEXT NOT NULL DEFAULT '2027-05-31',
  profile_summary TEXT NOT NULL,
  tag_weights TEXT NOT NULL,
  explicit_preferences TEXT NOT NULL DEFAULT '[]',
  blocked_companies TEXT NOT NULL DEFAULT '[]',
  last_decay_month TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS user_job_state (
  user_id TEXT NOT NULL,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'undecided' CHECK (status IN ('undecided','interested','applied','not_interested')),
  last_shown_at TEXT,
  impression_count INTEGER NOT NULL DEFAULT 0,
  decided_at TEXT,
  applied_at TEXT,
  notes TEXT NOT NULL DEFAULT '',
  last_action_id TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, job_id)
);

CREATE INDEX IF NOT EXISTS idx_user_job_state_status ON user_job_state(user_id, status, last_shown_at);

CREATE TABLE IF NOT EXISTS daily_feeds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  feed_date TEXT NOT NULL,
  job_ids TEXT NOT NULL DEFAULT '[]',
  generated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, feed_date)
);

CREATE TABLE IF NOT EXISTS action_log (
  action_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  action TEXT NOT NULL,
  before_state TEXT NOT NULL,
  after_state TEXT NOT NULL,
  undone_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sponsorship_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  risk TEXT NOT NULL CHECK (risk IN ('low','medium','high')),
  basis TEXT NOT NULL,
  evidence_url TEXT,
  checked_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  UNIQUE(company_id, evidence_url)
);

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  run_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('daily','source_discovery','sponsorship_refresh')),
  status TEXT NOT NULL CHECK (status IN ('started','prepared','committed','rendered','failed')),
  candidate_count INTEGER NOT NULL DEFAULT 0,
  feed_count INTEGER NOT NULL DEFAULT 0,
  cursor_json TEXT NOT NULL DEFAULT '{}',
  error TEXT,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

