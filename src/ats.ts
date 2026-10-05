import type { CandidateInput } from "./types";

export type SourceKind = "greenhouse" | "lever" | "ashby" | "smartrecruiters" | "workday" | "official";

export interface SourceRecord {
  id: number;
  company: string;
  kind: SourceKind;
  board_url: string;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : "";
}

function absUrl(url: string): string {
  return url.startsWith("http://") ? url.replace("http://", "https://") : url;
}

export async function scanSource(source: SourceRecord, fetcher: typeof fetch = fetch): Promise<CandidateInput[]> {
  const response = await fetcher(source.board_url, { headers: { accept: "application/json,text/html", "user-agent": "PersonalJobFeed/1.0" }, redirect: "follow" });
  if (!response.ok) throw new Error(`${source.kind} returned ${response.status}`);
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("json")) return [];
  const body = await response.json() as Record<string, unknown> | unknown[];

  if (source.kind === "greenhouse") {
    const jobs = Array.isArray((body as Record<string, unknown>).jobs) ? (body as { jobs: Record<string, unknown>[] }).jobs : [];
    return jobs.map((job) => ({
      company: source.company,
      title: text(job.title),
      location: text((job.location as Record<string, unknown> | undefined)?.name),
      application_url: absUrl(text(job.absolute_url)),
      source_job_id: String(job.id ?? ""),
      description_excerpt: text(job.content).slice(0, 3000),
      country: "",
      employment_type: text(job.content).toLowerCase().includes("intern") ? "internship" : "full_time",
      published_at: text(job.updated_at) || undefined,
    }));
  }

  if (source.kind === "lever") {
    const jobs = Array.isArray(body) ? body as Record<string, unknown>[] : [];
    return jobs.map((job) => ({
      company: source.company,
      title: text(job.text),
      location: text((job.categories as Record<string, unknown> | undefined)?.location),
      application_url: absUrl(text(job.applyUrl) || text(job.hostedUrl)),
      source_job_id: text(job.id),
      description_excerpt: `${text(job.descriptionPlain)} ${text(job.additionalPlain)}`.slice(0, 3000),
      country: "",
      employment_type: `${text(job.text)} ${text(job.descriptionPlain)}`.toLowerCase().includes("intern") ? "internship" : "full_time",
      published_at: typeof job.createdAt === "number" ? new Date(job.createdAt).toISOString() : undefined,
    }));
  }

  if (source.kind === "ashby") {
    const jobs = Array.isArray((body as Record<string, unknown>).jobs) ? (body as { jobs: Record<string, unknown>[] }).jobs : [];
    return jobs.map((job) => ({
      company: source.company,
      title: text(job.title),
      location: text(job.location),
      application_url: absUrl(text(job.applyUrl) || text(job.jobUrl)),
      source_job_id: text(job.id) || text(job.jobUrl).split("/").pop(),
      description_excerpt: text(job.descriptionPlain).slice(0, 3000),
      country: "",
      employment_type: text(job.employmentType).toLowerCase().includes("intern") ? "internship" : "full_time",
      published_at: text(job.publishedAt) || undefined,
    }));
  }

  if (source.kind === "smartrecruiters") {
    const jobs = Array.isArray((body as Record<string, unknown>).content) ? (body as { content: Record<string, unknown>[] }).content : [];
    return jobs.map((job) => {
      const location = job.location as Record<string, unknown> | undefined;
      return {
        company: source.company,
        title: text(job.name),
        location: [text(location?.city), text(location?.region), text(location?.country)].filter(Boolean).join(", "),
        application_url: absUrl(text(job.ref) || text(job.applyUrl)),
        source_job_id: text(job.id),
        description_excerpt: text(job.jobAd).slice(0, 3000),
        country: text(location?.country).toUpperCase().includes("UNITED STATES") ? "US" : text(location?.country),
        employment_type: "full_time",
        published_at: text(job.releasedDate) || undefined,
      };
    });
  }
  return [];
}

export async function verifyApplicationUrl(url: string, fetcher: typeof fetch = fetch): Promise<{ open: boolean; finalUrl: string; contentHash: string; excerpt: string }> {
  const response = await fetcher(url, { redirect: "follow", headers: { accept: "text/html", "user-agent": "PersonalJobFeed/1.0" } });
  const html = await response.text();
  const lowered = html.toLowerCase();
  const closed = /job (?:is )?no longer available|position has been filled|job not found|page not found|no longer accepting applications/.test(lowered);
  const hasApply = /apply|submit application|apply for this job/.test(lowered);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(html));
  const contentHash = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  return { open: response.ok && !closed && hasApply, finalUrl: response.url || url, contentHash, excerpt: text(html).slice(0, 3000) };
}
