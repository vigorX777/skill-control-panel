import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { parse, stringify } from "yaml";
import { PROJECT_ROOTS_PATH } from "./constants.mjs";
import { withFileLock } from "./file-lock.mjs";
import { appendHistoryEvent } from "./history.mjs";

const empty = () => ({ schemaVersion: 1, updatedAt: null, roots: [] });
const SCAN_MODES = new Set(["standard", "direct-skill-folders"]);
export const projectRootId = (path) => `project-root-${createHash("sha256").update(resolve(path)).digest("hex").slice(0, 16)}`;

function sameKeys(value, expected) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join("|") === [...expected].sort().join("|");
}

function validTimestamp(value) {
  return value === null || (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) && !Number.isNaN(Date.parse(value)));
}

function validRootKeys(item) {
  return sameKeys(item, ["id", "path", "label", "addedAt"])
    || sameKeys(item, ["id", "path", "label", "addedAt", "scanMode"]);
}

function normalizeRoot(item) {
  return { ...item, scanMode: item.scanMode || "standard" };
}

function validateConfig(value) {
  if (!sameKeys(value, ["schemaVersion", "updatedAt", "roots"]) || value.schemaVersion !== 1 || !validTimestamp(value.updatedAt) || !Array.isArray(value.roots)) throw new Error("Invalid project roots schema");
  const paths = new Set(), ids = new Set();
  for (const item of value.roots) {
    if (!validRootKeys(item) || !isAbsolute(item.path) || resolve(item.path) !== item.path || item.id !== projectRootId(item.path) || typeof item.label !== "string" || !item.label.trim() || !validTimestamp(item.addedAt) || item.addedAt === null || (item.scanMode !== undefined && !SCAN_MODES.has(item.scanMode)) || paths.has(item.path) || ids.has(item.id)) throw new Error("Invalid project root record: path must be canonical and id must match");
    paths.add(item.path); ids.add(item.id);
  }
}

export async function listProjectRoots(options = {}) {
  const configPath = options.configPath || options.projectRootsPath || PROJECT_ROOTS_PATH;
  try {
    const value = parse(await readFile(configPath, "utf8"));
    validateConfig(value);
    return { ...value, roots: value.roots.map(normalizeRoot) };
  } catch (error) { if (error.code === "ENOENT") return empty(); throw error; }
}

async function writeConfig(value, configPath) {
  await mkdir(dirname(configPath), { recursive: true });
  const tmp = `${configPath}.${randomUUID()}.tmp`;
  await writeFile(tmp, stringify(value), { mode: 0o600 });
  try { await rename(tmp, configPath); } finally { await rm(tmp, { force: true }); }
}

export async function addProjectRoot(params, options = {}) {
  if (!params.confirmed) throw new Error("project-path-add requires --confirmed");
  if (!isAbsolute(params.path)) throw new Error("Project root must be absolute");
  if (params.label !== undefined && !params.label.trim()) throw new Error("Project root label must not be blank");
  const scanMode = params.scanMode || "standard";
  if (!SCAN_MODES.has(scanMode)) throw new Error("Project root scan mode must be standard or direct-skill-folders");
  const path = resolve(params.path), configPath = options.configPath || PROJECT_ROOTS_PATH;
  return withFileLock(`${configPath}.lock`, options, async () => {
    const before = await listProjectRoots({ configPath });
    const existing = before.roots.find((item) => item.path === path);
    if (existing) return { ok: true, root: existing, changed: false };
    const now = options.now || new Date().toISOString();
    const root = { id: projectRootId(path), path, label: params.label?.trim() || basename(path) || path, addedAt: now, scanMode };
    const after = { ...before, updatedAt: now, roots: [...before.roots, root].sort((a, b) => a.path.localeCompare(b.path)) };
    validateConfig(after);
    await writeConfig(after, configPath);
    try { await appendHistoryEvent({ action: "project_path_add", affectedPaths: [path], before: null, after: { id: root.id, path, label: root.label, scanMode }, result: "success" }, options); }
    catch (error) { await writeConfig(before, configPath); throw error; }
    return { ok: true, root, changed: true };
  });
}

export async function updateProjectRoot(params, options = {}) {
  if (!params.confirmed) throw new Error("project-path-update requires --confirmed");
  if (!SCAN_MODES.has(params.scanMode)) throw new Error("Project root scan mode must be standard or direct-skill-folders");
  const configPath = options.configPath || PROJECT_ROOTS_PATH;
  return withFileLock(`${configPath}.lock`, options, async () => {
    const before = await listProjectRoots({ configPath });
    const found = before.roots.find((item) => item.id === params.id || item.path === resolve(params.path || "/"));
    if (!found) return { ok: true, root: null, changed: false };
    if (found.scanMode === params.scanMode) return { ok: true, root: found, changed: false };
    const now = options.now || new Date().toISOString();
    const root = { ...found, scanMode: params.scanMode };
    const after = { ...before, updatedAt: now, roots: before.roots.map((item) => item.id === found.id ? root : item) };
    validateConfig(after);
    await writeConfig(after, configPath);
    try { await appendHistoryEvent({ action: "project_path_update", affectedPaths: [found.path], before: { id: found.id, scanMode: found.scanMode }, after: { id: root.id, scanMode: root.scanMode }, result: "success" }, options); }
    catch (error) { await writeConfig(before, configPath); throw error; }
    return { ok: true, root, changed: true };
  });
}

export async function removeProjectRoot(params, options = {}) {
  if (!params.confirmed) throw new Error("project-path-remove requires --confirmed");
  const configPath = options.configPath || PROJECT_ROOTS_PATH;
  return withFileLock(`${configPath}.lock`, options, async () => {
    const before = await listProjectRoots({ configPath });
    const found = before.roots.find((item) => item.id === params.id || item.path === resolve(params.path || "/"));
    if (!found) return { ok: true, removed: null, changed: false };
    const after = { ...before, updatedAt: options.now || new Date().toISOString(), roots: before.roots.filter((item) => item.id !== found.id) };
    await writeConfig(after, configPath);
    try { await appendHistoryEvent({ action: "project_path_remove", affectedPaths: [found.path], before: found, after: null, result: "success" }, options); }
    catch (error) { await writeConfig(before, configPath); throw error; }
    return { ok: true, removed: found, changed: true };
  });
}
