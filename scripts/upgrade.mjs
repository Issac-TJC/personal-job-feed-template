import { assertNode22, configPath, run } from "./lib.mjs";
import { access } from "node:fs/promises";

assertNode22();
await access(configPath);
run("npm", ["run", "check"]);
run("npm", ["run", "db:migrate:remote"]);
run("npm", ["run", "deploy"]);
run("npm", ["run", "package:plugin"]);
console.log("Upgrade complete. Reconnect the plugin only if its OAuth scopes or MCP URL changed.");
