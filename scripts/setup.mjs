import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { assertNode22, buildWranglerConfig, configPath, extractWorkerUrl, readJson, run, statePath, writeJson } from "./lib.mjs";

assertNode22();
const rl = createInterface({ input, output });
const state = await readJson(statePath, {});
const defaultName = state.workerName ?? `personal-job-feed-${Math.random().toString(36).slice(2, 8)}`;
const workerName = (await rl.question(`Worker name [${defaultName}]: `)).trim() || defaultName;
const issuer = (await rl.question(`Auth0 issuer${state.issuer ? ` [${state.issuer}]` : " (for example https://tenant.us.auth0.com/)"}: `)).trim() || state.issuer;
if (!issuer) throw new Error("Auth0 issuer is required.");

run("npx", ["wrangler", "whoami"]);
let databaseId = state.databaseId;
const databaseName = state.databaseName ?? workerName;
if (!databaseId) {
  const created = run("npx", ["wrangler", "d1", "create", databaseName], { capture: true });
  databaseId = created.match(/[0-9a-f]{8}-[0-9a-f-]{27,}/i)?.[0];
  if (!databaseId) throw new Error("Could not parse the D1 database ID. Re-run setup; the created database can be reused.");
}
const bucketName = state.bucketName ?? `${workerName}-resumes`;
const bucketList = run("npx", ["wrangler", "r2", "bucket", "list"], { capture: true });
if (!bucketList.includes(bucketName)) run("npx", ["wrangler", "r2", "bucket", "create", bucketName]);

await writeJson(configPath, buildWranglerConfig({ workerName, databaseName, databaseId, bucketName, issuer, audience: "https://pending.invalid/mcp" }));
const provisional = run("npx", ["wrangler", "deploy", "--config", configPath], { capture: true });
const workerUrl = extractWorkerUrl(provisional) ?? state.workerUrl;
if (!workerUrl) throw new Error("Could not determine the workers.dev URL from deployment output.");
const mcpUrl = `${workerUrl}/mcp`;
await writeJson(configPath, buildWranglerConfig({ workerName, databaseName, databaseId, bucketName, issuer, audience: mcpUrl }));
await writeJson(statePath, { workerName, databaseName, databaseId, bucketName, issuer, workerUrl, mcpUrl });

output.write(`\nConfigure Auth0 before continuing:\n- API Identifier: ${mcpUrl}\n- Signing algorithm: RS256\n- Permissions: jobfeed:read, jobfeed:write, jobfeed:resume\n- Copy ChatGPT's OAuth callback URL into the Auth0 application.\n`);
await rl.question("Press Enter after Auth0 is configured...");
const ownerSub = (await rl.question("Auth0 owner user_id (sub): ")).trim();
if (!ownerSub) throw new Error("Owner subject is required.");
rl.close();

run("npx", ["wrangler", "secret", "put", "ALLOWED_USER_SUB", "--config", configPath], { input: `${ownerSub}\n` });
run("npx", ["wrangler", "d1", "migrations", "apply", "JOB_FEED_DB", "--remote", "--config", configPath]);
run("npm", ["run", "check"]);
run("npm", ["run", "deploy"]);
run("npm", ["run", "package:plugin"]);
output.write(`\nReady. Connect ${mcpUrl} in ChatGPT, request scopes jobfeed:read jobfeed:write jobfeed:resume, then ask the plugin to open onboarding.\n`);
