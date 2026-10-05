export type SponsorshipRisk = "low" | "medium" | "high" | "excluded" | "not_applicable";
export type JobStatus = "undecided" | "interested" | "applied" | "not_interested";
export type ProfileStatus = "needs_resume" | "draft" | "active";
export type ResumeAssetStatus = "staged" | "active";

export interface Env {
  JOB_FEED_DB: D1Database;
  JOB_FEED_RESUMES: R2Bucket;
  ENVIRONMENT: string;
  AUTH0_ISSUER: string;
  AUTH0_AUDIENCE: string;
  ALLOWED_USER_SUB: string;
  DEV_BYPASS_AUTH?: string;
}

export interface Principal {
  sub: string;
  scopes: string[];
  token: string;
  expiresAt?: number;
}

export interface OpenAIFileInput {
  download_url: string;
  file_id: string;
  mime_type?: string;
  file_name?: string;
}

export interface SearchConstraints {
  target_roles: string[];
  target_industries: string[];
  seniority_levels: string[];
  countries: string[];
  locations: string[];
  remote_preference: "any" | "remote" | "hybrid" | "onsite";
  employment_types: string[];
  available_from?: string;
  current_work_authorization?: string;
  future_sponsorship_required: boolean;
  salary_notes?: string;
  excluded_companies: string[];
  excluded_industries: string[];
}

export interface JobProfileData {
  education: string[];
  experience: string[];
  projects: string[];
  skills: string[];
  skill_tags: string[];
  constraints: SearchConstraints;
}

export interface JobProfile {
  status: ProfileStatus;
  summary: string;
  profileVersion: number;
  profile: JobProfileData;
  weights: Record<string, number>;
  preferences: string[];
  blockedCompanies: string[];
  activeResumeId?: string;
}

export interface ScheduleSlot {
  id: string;
  time: string;
  max_jobs: number;
}

export interface ScheduleSettings {
  timezone: string;
  weekdays: number[];
  slots: ScheduleSlot[];
  paused: boolean;
  version: number;
  syncedVersion: number;
}

export interface CandidateInput {
  company: string;
  title: string;
  location: string;
  application_url: string;
  source_job_id?: string;
  description_excerpt?: string;
  content_hash?: string;
  published_at?: string;
  country?: string;
  employment_type?: string;
}

/** Combined model result. Public job facts are stored separately from user-specific matching. */
export interface ClassificationInput extends CandidateInput {
  eligible: boolean;
  exclusion_reason?: string;
  eligibility_basis: string;
  sponsorship_risk: SponsorshipRisk;
  sponsorship_basis: string;
  direction_tags: string[];
  resume_match_score: number;
  match_points: string[];
  resume_focus: string;
  verified_at: string;
  seniority?: string;
  work_authorization_facts?: string;
}

export interface RankedJob {
  id: string;
  company: string;
  companyId: number;
  title: string;
  location: string;
  directionTags: string[];
  eligibilityBasis: string;
  sponsorshipRisk: Exclude<SponsorshipRisk, "excluded">;
  sponsorshipBasis: string;
  matchPoints: string[];
  resumeFocus: string;
  applicationUrl: string;
  baseMatchScore: number;
  preferenceScore: number;
  freshnessScore: number;
  finalScore: number;
  firstSeenAt: string;
  lastVerifiedAt: string;
  status: JobStatus;
  lastShownAt?: string;
  impressionCount: number;
  notes?: string;
  exploration?: boolean;
}

export const EMPTY_CONSTRAINTS: SearchConstraints = {
  target_roles: [],
  target_industries: [],
  seniority_levels: [],
  countries: [],
  locations: [],
  remote_preference: "any",
  employment_types: ["full_time"],
  future_sponsorship_required: false,
  excluded_companies: [],
  excluded_industries: [],
};

export const EMPTY_PROFILE: JobProfileData = {
  education: [],
  experience: [],
  projects: [],
  skills: [],
  skill_tags: [],
  constraints: EMPTY_CONSTRAINTS,
};

// Used only to migrate the original owner's live deployment. New users start in onboarding.
export const LEGACY_PROFILE_SUMMARY =
  "CMU MS ECE, May 2027. Strongest fit: Agentic RAG, backend/distributed systems, AI infrastructure, retrieval/ranking; secondary fit: VLM/CV, LiDAR/point cloud/autonomy. Python, C++, FastAPI, PyTorch, Transformers, Docker, SQL/NoSQL, observability. F-1 OPT/STEM OPT first, future employer sponsorship required.";

export const LEGACY_TAG_WEIGHTS: Record<string, number> = {
  agentic_rag: 5,
  backend_distributed: 5,
  ai_infra: 5,
  retrieval_recsys: 4,
  vlm_cv: 3,
  lidar_autonomy: 3,
  generic_sde_fullstack: 2,
};
