#!/usr/bin/env node

import { once } from "node:events";

import { DEFAULT_PORT, HISTORY_PATH, REGISTRY_PATH, SERVER_STATE_PATH } from "./lib/constants.mjs";
import { writeJsonFile } from "./lib/metadata.mjs";
import { createSkillControlServer } from "./lib/server-app.mjs";
import { getDefaultRoots } from "./lib/manager.mjs";

function getPort() {
  const portArgIndex = process.argv.indexOf("--port");
  if (portArgIndex >= 0) {
    const value = Number.parseInt(process.argv[portArgIndex + 1], 10);
    if (Number.isFinite(value)) {
      return value;
    }
  }
  return DEFAULT_PORT;
}

const port = getPort();
const app = createSkillControlServer({
  registryPath: REGISTRY_PATH,
  historyPath: HISTORY_PATH,
  roots: getDefaultRoots(),
  discoverProjects: true,
});

await app.refreshSnapshot().catch((error) => {
  console.error(`[skill-control-panel] initial scan warning: ${error.message}`);
});

app.server.listen(port, "127.0.0.1");
await once(app.server, "listening");

await writeJsonFile(SERVER_STATE_PATH, {
  pid: process.pid,
  port,
  startedAt: new Date().toISOString(),
});

console.log(`skill-control-panel listening on http://127.0.0.1:${port}`);
