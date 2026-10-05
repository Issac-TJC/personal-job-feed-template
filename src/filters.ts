import type { CandidateInput, ClassificationInput, SearchConstraints } from "./types";

const US_HINTS = /\b(united states|u\.?s\.?|remote[- ]us|ca\b|ny\b|wa\b|tx\b|ma\b|il\b|pa\b|virginia|california|new york|seattle|austin|chicago|sunnyvale|mountain view|san francisco|palo alto|redwood city)\b/i;
const INTERNSHIP = /\b(intern(ship)?|co-?op)\b/i;
const NON_FULL_TIME = /\b(part[- ]time|temporary|contractor|seasonal)\b/i;
const EXPERIENCE = /\b(?:[2-9]|[1-9]\d)\+?\s*(?:years?|yrs?)\b/i;
const IMMEDIATE = /\b(start immediately|immediate start|available immediately|2026 start)\b/i;
const RESTRICTED_AUTH = /\b(us citizens? only|u\.?s\.? citizenship required|must be a us citizen|security clearance|top secret|secret clearance|itar|u\.?s\.? person|permanent work authorization|without (?:current or future )?sponsorship|no (?:visa )?sponsorship|cannot sponsor|will not sponsor|not eligible for sponsorship)\b/i;
const NEW_GRAD_2027 = /\b(2027|new grad|university grad|early career|entry[- ]level|campus)\b/i;

export interface FilterResult {
  eligible: boolean;
  reasons: string[];
}

const INVALID_URL_REASON = "not_specific_https_application_url";

export function isSafePublicHttps(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password) return false;
    const host = url.hostname.toLowerCase();
    if (host === "localhost" || host.endsWith(".localhost") || host === "0.0.0.0" || host === "127.0.0.1" || host === "::1") return false;
    if (/^(10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) return false;
    return true;
  } catch { return false; }
}

export function hardFilter(candidate: Pick<CandidateInput, "title" | "location" | "description_excerpt" | "country" | "employment_type" | "application_url">): FilterResult {
  const text = `${candidate.title} ${candidate.location} ${candidate.description_excerpt ?? ""}`;
  const reasons: string[] = [];
  if ((candidate.country && candidate.country !== "US") || !US_HINTS.test(`${candidate.location} ${candidate.country ?? ""}`)) reasons.push("not_us");
  if (INTERNSHIP.test(text)) reasons.push("internship");
  if (NON_FULL_TIME.test(text) || (candidate.employment_type && candidate.employment_type !== "full_time")) reasons.push("not_full_time");
  if (EXPERIENCE.test(text)) reasons.push("material_experience_required");
  if (IMMEDIATE.test(text)) reasons.push("immediate_start");
  if (RESTRICTED_AUTH.test(text)) reasons.push("work_authorization_restriction");
  if (!NEW_GRAD_2027.test(text)) reasons.push("2027_eligibility_unclear");
  try {
    const url = new URL(candidate.application_url);
    if (!isSafePublicHttps(candidate.application_url) || !url.pathname || url.pathname === "/") reasons.push("not_specific_https_application_url");
  } catch {
    reasons.push("invalid_application_url");
  }
  return { eligible: reasons.length === 0, reasons };
}

/**
 * Deterministic filtering for the reusable edition. It only rejects facts that can
 * be established without guessing; semantic fit remains a batched model decision.
 */
export function genericHardFilter(
  candidate: Pick<CandidateInput, "title" | "location" | "description_excerpt" | "country" | "employment_type" | "application_url">,
  constraints: SearchConstraints,
): FilterResult {
  const reasons: string[] = [];
  if (!isSafePublicHttps(candidate.application_url)) reasons.push(INVALID_URL_REASON);
  else {
    const url = new URL(candidate.application_url);
    if (!url.pathname || url.pathname === "/") reasons.push(INVALID_URL_REASON);
  }
  if (constraints.countries.length && candidate.country) {
    const wanted = constraints.countries.map((value) => value.toLowerCase());
    if (!wanted.includes(candidate.country.toLowerCase())) reasons.push("country_mismatch");
  }
  if (constraints.employment_types.length && candidate.employment_type) {
    const wanted = constraints.employment_types.map((value) => value.toLowerCase());
    if (!wanted.includes(candidate.employment_type.toLowerCase())) reasons.push("employment_type_mismatch");
  }
  return { eligible: reasons.length === 0, reasons };
}

export function validateClassification(value: ClassificationInput, constraints?: SearchConstraints, qualityThreshold = 60): FilterResult {
  const hard = constraints ? genericHardFilter(value, constraints) : { eligible: true, reasons: [] };
  const reasons = [...hard.reasons];
  if (!value.eligible) reasons.push(value.exclusion_reason || "model_excluded");
  if (value.sponsorship_risk === "excluded") reasons.push("sponsorship_excluded");
  if (value.resume_match_score < qualityThreshold) reasons.push("below_quality_threshold");
  return { eligible: reasons.length === 0, reasons: [...new Set(reasons)] };
}

export function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/\b(2027|new grads?|university grads?|entry[- ]level|early career)\b/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

export function normalizeCompany(company: string): string {
  return company.toLowerCase().replace(/[^a-z0-9]+/g, "").trim();
}

export async function sha256(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function jobFingerprint(candidate: CandidateInput): Promise<string> {
  if (candidate.source_job_id) return sha256(`${normalizeCompany(candidate.company)}:${candidate.source_job_id}`);
  return sha256([normalizeCompany(candidate.company), normalizeTitle(candidate.title), candidate.location.toLowerCase().trim(), candidate.application_url].join("|"));
}
