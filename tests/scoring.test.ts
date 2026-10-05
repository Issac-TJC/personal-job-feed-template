import { describe, expect, it } from "vitest";
import { applyFeedback, canShow, decayWeights, finalScore, preferenceScore, selectFeed } from "../src/scoring";
import type { RankedJob } from "../src/types";

function job(id: string, companyId: number, risk: "low" | "medium" | "high", score: number, base = score): RankedJob {
  return { id, company: `C${companyId}`, companyId, title: "SWE", location: "New York, NY", directionTags: ["backend_distributed"], eligibilityBasis: "May 2027", sponsorshipRisk: risk, sponsorshipBasis: "test", matchPoints: [], resumeFocus: "SDE", applicationUrl: `https://jobs.example.com/${id}`, baseMatchScore: base, preferenceScore: score, freshnessScore: score, finalScore: score, firstSeenAt: "2026-10-05", lastVerifiedAt: "2026-10-05", status: "undecided", impressionCount: 0 };
}

describe("ranking", () => {
  it("weights match, preference, and freshness at 65/25/10", () => {
    expect(finalScore(80, 60, 100)).toBe(77);
  });

  it("sorts sponsorship risk before a higher match score", () => {
    const result = selectFeed([job("high", 1, "high", 99), job("low", 2, "low", 61)], 2);
    expect(result.map((item) => item.id)).toEqual(["low", "high"]);
  });

  it("enforces threshold, total cap, and two jobs per company", () => {
    const jobs = [job("too-low", 9, "low", 99, 59), ...Array.from({ length: 20 }, (_, index) => job(`j${index}`, Math.floor(index / 3), "medium", 90 - index))];
    const result = selectFeed(jobs, 15);
    expect(result).toHaveLength(14);
    expect(result.some((item) => item.id === "too-low")).toBe(false);
    for (const companyId of new Set(result.map((item) => item.companyId))) expect(result.filter((item) => item.companyId === companyId).length).toBeLessThanOrEqual(2);
  });

  it("never exceeds 15 when enough companies qualify", () => {
    const result = selectFeed(Array.from({ length: 30 }, (_, index) => job(`unique-${index}`, index, "medium", 95 - index / 2)), 15);
    expect(result).toHaveLength(15);
  });
});

describe("feedback and repeat rules", () => {
  it("does not reshow a decided job and waits three days for undecided", () => {
    const now = new Date("2026-10-05T20:00:00-04:00");
    expect(canShow("interested", undefined, now)).toBe(false);
    expect(canShow("undecided", "2026-10-03T20:01:00-04:00", now)).toBe(false);
    expect(canShow("undecided", "2026-10-02T19:59:00-04:00", now)).toBe(true);
  });

  it("applies feedback with caps and monthly decay", () => {
    expect(applyFeedback({ x: 4 }, ["x"], 2).x).toBe(5);
    expect(applyFeedback({ x: -5 }, ["x"], -1).x).toBe(-5);
    expect(decayWeights({ x: 4 }).x).toBe(3.8);
    expect(preferenceScore(["x"], { x: 5 })).toBe(100);
  });
});
