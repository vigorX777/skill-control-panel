import { lstat, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { listProjectRoots } from "./project-roots.mjs";
import { discoverAgentSkillRoots } from "./agent-discovery.mjs";

const DEFAULT_IGNORED = new Set([".git", ".worktrees", "node_modules", "vendor", "dist", "build", ".cache"]);
const cache = new Map();
const pending = new Map();

function defaultWorkspaceRoots() {
  if (process.env.SKILL_CONTROL_PANEL_WORKSPACE_ROOTS) {
    return process.env.SKILL_CONTROL_PANEL_WORKSPACE_ROOTS.split(delimiter).filter(Boolean);
  }
  return [join(homedir(), "Documents"), join(homedir(), "Vibecoding")];
}

async function isRealDirectory(path) {
  try {
    const info = await lstat(path);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return false;
    throw error;
  }
}

async function walk(directory, roots, diagnostics, ignored) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    diagnostics.push({
      code: "project_discovery_error",
      severity: "warning",
      path: directory,
      message: `Unable to inspect project directory: ${error.message}`,
      details: { code: error.code ?? null },
    });
    return;
  }

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || ignored.has(entry.name)) continue;
    const child = join(directory, entry.name);
    if (entry.name === ".agents") {
      const skillsPath = join(child, "skills");
      let validSkillsRoot = false;
      try {
        validSkillsRoot = await isRealDirectory(skillsPath);
      } catch (error) {
        diagnostics.push({ code: "project_discovery_error", severity: "warning", path: skillsPath, message: `Unable to inspect project Skill root: ${error.message}`, details: { code: error.code ?? null } });
      }
      if (validSkillsRoot) {
        roots.push({
          path: resolve(skillsPath),
          projectRoot: resolve(directory),
          agents: [],
          ownership: "managed",
        });
      }
      continue;
    }
    await walk(child, roots, diagnostics, ignored);
  }
}

async function runDiscovery(options) {
  const workspaceRoots = options.workspaceRoots || defaultWorkspaceRoots();
  const ignored = new Set(options.ignoredDirectoryNames || DEFAULT_IGNORED);
  const roots = [];
  const diagnostics = [];
  for (const workspaceRoot of workspaceRoots.map((path) => resolve(path)).sort()) {
    try {
      if (await isRealDirectory(workspaceRoot)) await walk(workspaceRoot, roots, diagnostics, ignored);
    } catch (error) {
      diagnostics.push({ code: "project_discovery_error", severity: "warning", path: workspaceRoot, message: `Unable to inspect workspace root: ${error.message}`, details: { code: error.code ?? null } });
    }
  }
  const unique = new Map(roots.map((item) => [item.path, item]));
  return { roots: [...unique.values()].sort((left, right) => left.path.localeCompare(right.path)), diagnostics };
}

export async function discoverProjectSkillRoots(options = {}) {
  const workspaceRoots = (options.workspaceRoots || defaultWorkspaceRoots())
    .map((path) => resolve(path)).sort();
  const key = JSON.stringify({ workspaceRoots, ignored: [...(options.ignoredDirectoryNames || DEFAULT_IGNORED)].sort() });
  const ttl = options.projectDiscoveryTtlMs ?? 60_000;
  const cached = cache.get(key);
  if (!options.refreshProjectRoots && ttl > 0 && cached && Date.now() - cached.at <= ttl) return cached.value;
  if (pending.has(key)) return pending.get(key);
  const promise = runDiscovery({ ...options, workspaceRoots }).then((value) => {
    cache.set(key, { at: Date.now(), value });
    return value;
  }).finally(() => pending.delete(key));
  pending.set(key, promise);
  return promise;
}

export async function resolveScanRoots(baseRoots, options = {}) {
  const [discovered, agentDiscovered] = await Promise.all([discoverProjectSkillRoots(options), discoverAgentSkillRoots(options)]);
  const project = new Map((baseRoots.project || []).map((item) => [resolve(item.path), item]));
  for (const item of discovered.roots) project.set(resolve(item.path), item);
  const manual = await listProjectRoots({ configPath: options.projectRootsPath });
  for (const item of manual.roots) {
    const path = resolve(join(item.path, ".agents", "skills"));
    project.set(path, { path, projectRoot: item.path, agents: [], ownership: "managed", manualProjectRootId: item.id });
    if (item.scanMode === "direct-skill-folders") {
      const directPath = resolve(item.path);
      project.set(`direct:${directPath}`, { path: directPath, projectRoot: item.path, agents: [], ownership: "managed", manualProjectRootId: item.id, directSkillFolders: true, ignoreBrokenEntries: true });
    }
  }
  return {
    roots: {
      ...baseRoots,
      agent: [...(baseRoots.agent || []), ...agentDiscovered.roots.agent],
      system: [...(baseRoots.system || []), ...agentDiscovered.roots.system],
      plugin: [...(baseRoots.plugin || []), ...agentDiscovered.roots.plugin],
      project: [...project.values()].sort((left, right) => left.path.localeCompare(right.path)),
    },
    diagnostics: [...discovered.diagnostics, ...agentDiscovered.diagnostics],
  };
}
