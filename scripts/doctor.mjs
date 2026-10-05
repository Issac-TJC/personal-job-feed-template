import { access, readFile } from "node:fs/promises";
import { assertNode22, configPath, normalizeIssuer, readJson, run, statePath } from "./lib.mjs";

const checks = [];
function ok(name, detail = "") { checks.push({ ok: true, name, detail }); }
function fail(name, error) { checks.push({ ok: false, name, detail: error instanceof Error ? error.message : String(error) }); }
try { assertNode22(); ok("Node.js", process.versions.node); } catch (error) { fail("Node.js", error); }
try { await access(configPath); ok("Generated config"); } catch (error) { fail("Generated config", error); }
try { run("npx", ["wrangler", "whoami"]); ok("Cloudflare login"); } catch (error) { fail("Cloudflare login", error); }
const state = await readJson(statePath, {});
if (state.workerUrl) {
  try { const health = await fetch(`${state.workerUrl}/health`); if (!health.ok) throw new Error(`HTTP ${health.status}`); ok("Worker health", state.workerUrl); } catch (error) { fail("Worker health", error); }
  try { const metadata = await fetch(`${state.workerUrl}/.well-known/oauth-protected-resource/mcp`); const body = await metadata.json(); if (body.resource !== state.mcpUrl) throw new Error("OAuth resource does not match MCP URL"); ok("OAuth resource metadata"); } catch (error) { fail("OAuth resource metadata", error); }
}
if (state.issuer) {
  try { const discovery = await fetch(`${normalizeIssuer(state.issuer)}.well-known/openid-configuration`); if (!discovery.ok) throw new Error(`HTTP ${discovery.status}`); ok("Auth0 discovery", state.issuer); } catch (error) { fail("Auth0 discovery", error); }
}
try { JSON.parse(await readFile(configPath, "utf8")); ok("Config JSON"); } catch (error) { fail("Config JSON", error); }
for (const check of checks) console.log(`${check.ok ? "✓" : "✗"} ${check.name}${check.detail ? ` — ${check.detail}` : ""}`);
if (checks.some((check) => !check.ok)) process.exitCode = 1;
