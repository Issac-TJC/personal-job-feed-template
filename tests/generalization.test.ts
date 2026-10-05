import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { genericHardFilter } from "../src/filters";
import { detectResumeKind, validateDocxContainer, validateSchedule } from "../src/profile";
import { EMPTY_CONSTRAINTS } from "../src/types";
import { selectFeed } from "../src/scoring";
import type { RankedJob } from "../src/types";

const base = { title: "Research Scientist", location: "London", application_url: "https://jobs.example.com/roles/42", description_excerpt: "PhD role", country: "GB", employment_type: "full_time" };

function job(id: string, risk: "low" | "high", score: number): RankedJob {
  return { id, company: id, companyId: id === "high" ? 1 : 2, title: "Role", location: "Anywhere", directionTags: ["research"], eligibilityBasis: "match", sponsorshipRisk: risk, sponsorshipBasis: "test", matchPoints: [], resumeFocus: "research", applicationUrl: `https://jobs.example.com/${id}`, baseMatchScore: score, preferenceScore: score, freshnessScore: score, finalScore: score, firstSeenAt: "2026-10-05", lastVerifiedAt: "2026-10-05", status: "undecided", impressionCount: 0 };
}

describe("generic job constraints", () => {
  it("supports non-US, non-new-grad roles", () => {
    expect(genericHardFilter(base, { ...EMPTY_CONSTRAINTS, countries: ["GB"] })).toEqual({ eligible: true, reasons: [] });
  });

  it("rejects explicit country and employment mismatches", () => {
    const result = genericHardFilter(base, { ...EMPTY_CONSTRAINTS, countries: ["US"], employment_types: ["internship"] });
    expect(result.reasons).toEqual(expect.arrayContaining(["country_mismatch", "employment_type_mismatch"]));
  });

  it("only prioritizes sponsorship risk when requested", () => {
    const jobs = [job("high", "high", 95), job("low", "low", 61)];
    expect(selectFeed(jobs, 2, true).map((item) => item.id)).toEqual(["low", "high"]);
    expect(selectFeed(jobs, 2, false).map((item) => item.id)).toEqual(["high", "low"]);
  });
});

describe("resume and schedule validation", () => {
  it("recognizes allowed file signatures", () => {
    expect(detectResumeKind(new TextEncoder().encode("%PDF-1.7"), { download_url: "https://files.example/a", file_id: "1", file_name: "resume.pdf" })).toBe("pdf");
    expect(detectResumeKind(new TextEncoder().encode("plain resume"), { download_url: "https://files.example/a", file_id: "2", mime_type: "text/plain", file_name: "resume.txt" })).toBe("txt");
    expect(() => detectResumeKind(new Uint8Array([0, 1, 2]), { download_url: "https://files.example/a", file_id: "3", file_name: "resume.pdf" })).toThrow("unsupported_or_mismatched_resume_file");
  });

  it("rejects malformed and compression-bomb DOCX containers", () => {
    expect(() => validateDocxContainer(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toThrow("invalid_docx_archive");
    const normal = zipSync({ "[Content_Types].xml": strToU8("<Types/>"), "word/document.xml": strToU8("<document>resume</document>") });
    expect(() => validateDocxContainer(normal)).not.toThrow();
    const bomb = zipSync({ "[Content_Types].xml": strToU8("<Types/>"), "word/document.xml": new Uint8Array(6 * 1024 * 1024) }, { level: 9 });
    expect(() => validateDocxContainer(bomb)).toThrow("unsafe_docx_archive");
  });

  it("accepts up to three unique slots and rejects invalid schedules", () => {
    expect(() => validateSchedule("America/New_York", [1, 3, 5], [{ id: "morning", time: "09:00", max_jobs: 10 }, { id: "evening", time: "20:00", max_jobs: 15 }])).not.toThrow();
    expect(() => validateSchedule("America/New_York", [1], [{ id: "a", time: "09:00", max_jobs: 15 }, { id: "b", time: "09:00", max_jobs: 15 }])).toThrow("invalid_or_duplicate_slot_time");
    expect(() => validateSchedule("Invalid/Timezone", [1], [{ id: "a", time: "09:00", max_jobs: 15 }])).toThrow("invalid_timezone");
  });
});
