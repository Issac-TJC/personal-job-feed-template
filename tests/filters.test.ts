import { describe, expect, it } from "vitest";
import { hardFilter, jobFingerprint, normalizeTitle, validateClassification } from "../src/filters";

const base = {
  company: "Example AI",
  title: "Software Engineer, New Grad 2027",
  location: "New York, NY",
  application_url: "https://jobs.example.com/roles/123/apply",
  description_excerpt: "Full-time role for Spring 2027 BS or MS graduates.",
  country: "US",
  employment_type: "full_time",
};

describe("hard eligibility filters", () => {
  it("keeps a US 2027 full-time new-grad role", () => {
    expect(hardFilter(base)).toEqual({ eligible: true, reasons: [] });
  });

  it.each([
    ["internship", { ...base, title: "Software Engineer Intern 2027" }],
    ["work_authorization_restriction", { ...base, description_excerpt: "Must be a US citizen and eligible for a security clearance." }],
    ["work_authorization_restriction", { ...base, description_excerpt: "We cannot sponsor now or in the future." }],
    ["material_experience_required", { ...base, description_excerpt: "Requires 4+ years of professional experience." }],
    ["not_us", { ...base, location: "Toronto, Canada", country: "CA" }],
  ])("excludes %s", (reason, candidate) => {
    expect(hardFilter(candidate).reasons).toContain(reason);
  });

  it("requires a specific HTTPS application URL", () => {
    expect(hardFilter({ ...base, application_url: "https://jobs.example.com/" }).reasons).toContain("not_specific_https_application_url");
  });

  it("rejects a model-approved role below quality 60", () => {
    const result = validateClassification({ ...base, eligible: true, eligibility_basis: "May 2027 MS", sponsorship_risk: "medium", sponsorship_basis: "Recent LCA history", direction_tags: ["backend_distributed"], resume_match_score: 59, match_points: [], resume_focus: "SDE", verified_at: "2026-10-05" });
    expect(result.reasons).toContain("below_quality_threshold");
  });
});

describe("deduplication", () => {
  it("normalizes new-grad title decorations", () => {
    expect(normalizeTitle("Software Engineer, New Grad 2027")).toBe("software engineer");
  });

  it("uses requisition IDs when available", async () => {
    const one = await jobFingerprint({ ...base, source_job_id: "REQ-1" });
    const moved = await jobFingerprint({ ...base, location: "Seattle, WA", application_url: "https://jobs.example.com/roles/different", source_job_id: "REQ-1" });
    expect(one).toBe(moved);
  });
});
