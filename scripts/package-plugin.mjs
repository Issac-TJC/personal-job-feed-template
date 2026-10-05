import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { strToU8, zipSync } from "fflate";
import { readJson, root, statePath } from "./lib.mjs";

const state = await readJson(statePath, {});
if (!state.mcpUrl) throw new Error("Run npm run setup first; no deployed MCP URL was found.");
const files = {};
async function addFile(source, target) { files[target] = new Uint8Array(await readFile(source)); }
async function addTree(directory, prefix) {
  const { readdir } = await import("node:fs/promises");
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const source = path.join(directory, entry.name); const target = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) await addTree(source, target); else await addFile(source, target);
  }
}
const manifest = JSON.parse(await readFile(path.join(root, "plugin.json"), "utf8"));
if (state.pluginName) manifest.name = state.pluginName;
files["plugin.json"] = strToU8(`${JSON.stringify(manifest, null, 2)}\n`);
files["mcp.json"] = strToU8(`${JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json", mcpServers: { "job-feed": { type: "streamable-http", url: state.mcpUrl, oauth_resource: state.mcpUrl } } }, null, 2)}\n`);
await addTree(path.join(root, "skills"), "skills");
await mkdir(path.join(root, "dist"), { recursive: true });
await writeFile(path.join(root, "dist", "personal-job-feed-plugin.zip"), zipSync(files, { level: 9 }));
console.log(`Created dist/personal-job-feed-plugin.zip for ${state.mcpUrl}`);
