import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";

export const root = path.resolve(import.meta.dirname, "..");
export const stateDir = path.join(root, ".jobfeed");
export const statePath = path.join(stateDir, "setup-state.json");
export const configPath = path.join(stateDir, "wrangler.generated.jsonc");

export async function readJson(file, fallback = {}) {
  try { return JSON.parse(await readFile(file, "utf8")); } catch { return fallback; }
}

export async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", stdio: options.capture ? "pipe" : "inherit", input: options.input });
  if (options.capture && result.stdout) process.stdout.write(result.stdout);
  if (options.capture && result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}`);
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
}

export function assertNode22() {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 22) throw new Error(`Node.js 22+ is required; current version is ${process.versions.node}.`);
}

export function normalizeIssuer(value) { return value.endsWith("/") ? value : `${value}/`; }

export function buildWranglerConfig({ workerName, databaseName, databaseId, bucketName, issuer, audience }) {
  return {
    $schema: "../node_modules/wrangler/config-schema.json",
    name: workerName,
    main: "../src/index.ts",
    compatibility_date: "2026-10-05",
    compatibility_flags: ["nodejs_compat"],
    workers_dev: true,
    rules: [{ type: "Text", globs: ["**/*.html"], fallthrough: true }],
    d1_databases: [{ binding: "JOB_FEED_DB", database_name: databaseName, database_id: databaseId, migrations_dir: "../migrations" }],
    r2_buckets: [{ binding: "JOB_FEED_RESUMES", bucket_name: bucketName }],
    vars: { ENVIRONMENT: "production", AUTH0_ISSUER: normalizeIssuer(issuer), AUTH0_AUDIENCE: audience },
  };
}

export function extractWorkerUrl(output) {
  return output.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/i)?.[0];
}
