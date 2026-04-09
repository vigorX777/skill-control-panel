#!/usr/bin/env node

import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_PORT,
  SERVER_LOG_PATH,
  SERVER_STATE_PATH,
} from "./lib/constants.mjs";
import { readJsonFile, writeJsonFile } from "./lib/metadata.mjs";

const skillRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const serverEntry = resolve(skillRoot, "scripts/server.mjs");

async function canConnect(url) {
  try {
    const response = await fetch(`${url}/api/summary`);
    return response.ok || response.status === 503;
  } catch {
    return false;
  }
}

async function resolveExistingUrl() {
  const state = await readJsonFile(SERVER_STATE_PATH, null);
  if (!state?.port) {
    return null;
  }
  const url = `http://127.0.0.1:${state.port}`;
  return (await canConnect(url)) ? url : null;
}

function openBrowser(url) {
  if (process.env.NO_OPEN === "1") {
    return;
  }

  spawn("open", [url], {
    detached: true,
    stdio: "ignore",
  }).unref();
}

async function waitForServer(url) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await canConnect(url)) {
      return true;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  return false;
}

async function ensureServer() {
  const existingUrl = await resolveExistingUrl();
  if (existingUrl) {
    openBrowser(existingUrl);
    console.log(`skill-control-panel already running at ${existingUrl}`);
    return;
  }

  const port = Number.parseInt(process.env.SKILL_CONTROL_PANEL_PORT || `${DEFAULT_PORT}`, 10);
  const child = spawn(process.execPath, [resolve("scripts/server.mjs"), "--port", `${port}`], {
    cwd: skillRoot,
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
    env: process.env,
  });
  child.unref();

  await writeJsonFile(SERVER_LOG_PATH.replace(/\.log$/, ".bootstrap.json"), {
    pid: child.pid,
    port,
    launchedAt: new Date().toISOString(),
  });

  const url = `http://127.0.0.1:${port}`;
  const ready = await waitForServer(url);

  if (!ready) {
    throw new Error(`skill-control-panel failed to start on ${url}`);
  }

  openBrowser(url);
  console.log(`skill-control-panel launched at ${url}`);
}

await access(serverEntry);
await ensureServer();
