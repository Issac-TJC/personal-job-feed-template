import type { JobStatus, RankedJob, SponsorshipRisk } from "./types";

const RISK_ORDER: Record<Exclude<SponsorshipRisk, "excluded">, number> = { low: 0, medium: 1, high: 2, not_applicable: 0 };

export function preferenceScore(tags: string[], weights: Record<string, number>): number {
  if (!tags.length) return 50;
  const avg = tags.reduce((sum, tag) => sum + (weights[tag] ?? 0), 0) / tags.length;
  return Math.max(0, Math.min(100, (avg + 5) * 10));
}

export function freshnessScore(firstSeenAt: string, now: Date): number {
  const ageDays = Math.max(0, (now.getTime() - new Date(firstSeenAt).getTime()) / 86_400_000);
  if (ageDays <= 3) return 100;
  return Math.max(0, Math.round(100 - (ageDays - 3) * 5));
}

export function finalScore(base: number, preference: number, freshness: number): number {
  return Math.round((0.65 * base + 0.25 * preference + 0.1 * freshness) * 10) / 10;
}

export function canShow(status: JobStatus, lastShownAt: string | undefined, now: Date): boolean {
  if (status !== "undecided") return false;
  if (!lastShownAt) return true;
  return now.getTime() - new Date(lastShownAt).getTime() >= 3 * 86_400_000;
}

export function applyFeedback(weights: Record<string, number>, tags: string[], delta: -1 | 1 | 2): Record<string, number> {
  const next = { ...weights };
  for (const tag of tags) next[tag] = Math.max(-5, Math.min(5, (next[tag] ?? 0) + delta));
  return next;
}

export function decayWeights(weights: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(weights).map(([key, value]) => [key, Math.round(value * 0.95 * 100) / 100]));
}

export function selectFeed(jobs: RankedJob[], maxJobs = 15, prioritizeSponsorship = true): RankedJob[] {
  const eligible = jobs.filter((job) => job.baseMatchScore >= 60);
  const compare = (a: RankedJob, b: RankedJob) =>
    (prioritizeSponsorship ? RISK_ORDER[a.sponsorshipRisk] - RISK_ORDER[b.sponsorshipRisk] : 0)
    || b.finalScore - a.finalScore
    || b.firstSeenAt.localeCompare(a.firstSeenAt);
  eligible.sort(compare);
  const selected: RankedJob[] = [];
  const perCompany = new Map<number, number>();
  const coreLimit = Math.max(0, maxJobs - Math.min(3, Math.floor(maxJobs / 5)));
  for (const job of eligible) {
    if ((perCompany.get(job.companyId) ?? 0) >= 2) continue;
    selected.push(job);
    perCompany.set(job.companyId, (perCompany.get(job.companyId) ?? 0) + 1);
    if (selected.length === coreLimit) break;
  }
  const selectedIds = new Set(selected.map((job) => job.id));
  const exploration = eligible.filter((job) => !selectedIds.has(job.id) && job.baseMatchScore >= 65)
    .sort((a, b) => (prioritizeSponsorship ? RISK_ORDER[a.sponsorshipRisk] - RISK_ORDER[b.sponsorshipRisk] : 0) || a.preferenceScore - b.preferenceScore || b.baseMatchScore - a.baseMatchScore);
  for (const job of exploration) {
    if ((perCompany.get(job.companyId) ?? 0) >= 2) continue;
    selected.push({ ...job, exploration: true });
    selectedIds.add(job.id);
    perCompany.set(job.companyId, (perCompany.get(job.companyId) ?? 0) + 1);
    if (selected.length === maxJobs) break;
  }
  for (const job of eligible) {
    if (selected.length >= maxJobs) break;
    if (selectedIds.has(job.id) || (perCompany.get(job.companyId) ?? 0) >= 2) continue;
    selected.push(job);
    perCompany.set(job.companyId, (perCompany.get(job.companyId) ?? 0) + 1);
  }
  return selected.sort(compare);
}
