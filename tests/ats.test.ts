import { describe, expect, it } from "vitest";
import { scanSource, verifyApplicationUrl } from "../src/ats";

describe("ATS adapters", () => {
  it("extracts concise Lever candidates", async () => {
    const fetcher = async () => new Response(JSON.stringify([{ id: "abc", text: "Software Engineer, New Grad 2027", applyUrl: "https://jobs.lever.co/acme/abc/apply", categories: { location: "Seattle, WA" }, descriptionPlain: "Full-time new grad role" }]), { headers: { "content-type": "application/json" } });
    const jobs = await scanSource({ id: 1, company: "Acme", kind: "lever", board_url: "https://api.lever.co/acme" }, fetcher as typeof fetch);
    expect(jobs[0]).toMatchObject({ company: "Acme", source_job_id: "abc", location: "Seattle, WA" });
  });

  it("rejects closed pages and accepts a concrete apply page", async () => {
    const openFetch = async () => new Response("<html><button>Submit application</button></html>", { status: 200 });
    const closedFetch = async () => new Response("This job is no longer available", { status: 200 });
    expect((await verifyApplicationUrl("https://jobs.example.com/123", openFetch as typeof fetch)).open).toBe(true);
    expect((await verifyApplicationUrl("https://jobs.example.com/123", closedFetch as typeof fetch)).open).toBe(false);
  });
});

