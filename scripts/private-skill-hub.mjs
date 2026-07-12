#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, readlink, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { parse, stringify } from "yaml";

import { AGENTS_CONFIG_DIR, HISTORY_PATH, REGISTRY_PATH, TRASH_DIR } from "./lib/constants.mjs";
import { appendHistoryEvents } from "./lib/history.mjs";
import { readRegistry, withRegistryLock, writeRegistryUnlocked } from "./lib/registry.mjs";
import { stableSkillId } from "./lib/path-safety.mjs";
import { resolveSkillFacts } from "./lib/source.mjs";

const HOME = homedir();
const HUB = join(HOME, "Vibecoding", "skill-hub");
const CONFIG = join(AGENTS_CONFIG_DIR, "skill-hub.yaml");
const MANIFEST = join(HUB, "skill-hub.yaml");
const PUBLIC = join(HOME, ".agents", "skills");
const TRIAL = join(HOME, "Documents", "Skill试用");
const PRIVATE = join(AGENTS_CONFIG_DIR, "agent-skills", "codex", "hatch-pet");
const AGENT_ROOTS = {
  codex: join(HOME, ".codex", "skills"),
  claude: join(HOME, ".claude", "skills"),
  antigravity: join(HOME, ".gemini", "skills"),
  opencode: join(HOME, ".config", "opencode", "skills"),
};
const SUPERPOWERS = new Set([
  "brainstorming", "dispatching-parallel-agents", "executing-plans", "finishing-a-development-branch",
  "receiving-code-review", "requesting-code-review", "subagent-driven-development", "systematic-debugging",
  "test-driven-development", "using-git-worktrees", "using-superpowers", "verification-before-completion",
  "writing-plans", "writing-skills",
]);

const args = new Set(process.argv.slice(2));
const confirmed = args.has("--confirmed");
const applyOnly = args.has("--apply");
if (![...args].every((arg) => ["--confirmed", "--apply"].includes(arg))) throw new Error("Usage: private-skill-hub.mjs [--apply] [--confirmed]");

async function exists(path) { return lstat(path).then(() => true).catch((error) => error.code === "ENOENT" ? false : Promise.reject(error)); }
async function realTarget(path) {
  try { return await realpath(path); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    return resolve(dirname(path), await readlink(path));
  }
}
async function skillDirectories(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const found = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory() && await exists(join(path, "SKILL.md"))) found.push(path);
  }
  return found.sort();
}
async function skillName(path) {
  const content = await readFile(join(path, "SKILL.md"), "utf8");
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  const frontmatter = match ? parse(match[1]) : {};
  return typeof frontmatter?.name === "string" && frontmatter.name.trim() ? frontmatter.name.trim() : basename(path);
}
function routesFor(item) {
  if (item.kind === "public") return [PUBLIC, ...Object.values(AGENT_ROOTS)].map((root) => join(root, item.slug));
  if (item.kind === "agent") return [join(AGENT_ROOTS.codex, item.slug)];
  return [
    ...(item.slug === "brainstorming" ? [join(AGENT_ROOTS.codex, item.slug)] : []),
    join(AGENT_ROOTS.claude, item.slug),
    join(AGENT_ROOTS.antigravity, item.slug),
  ];
}
async function readManifest() {
  const source = parse(await readFile(MANIFEST, "utf8"));
  if (source?.schemaVersion !== 1 || !Array.isArray(source.skills)) throw new Error(`Invalid Hub manifest: ${MANIFEST}`);
  return source;
}
async function ensureRouteRoot(root) {
  const stat = await lstat(root).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
  if (!stat) return mkdir(root, { recursive: true });
  if (!stat.isSymbolicLink()) {
    if (!stat.isDirectory()) throw new Error(`Route root is not a directory: ${root}`);
    return;
  }
  const source = await realTarget(root);
  const backup = join(TRASH_DIR, "route-migrations", `${basename(root)}-${Date.now()}-${randomUUID()}`);
  await mkdir(dirname(backup), { recursive: true });
  await rename(root, backup);
  await mkdir(root, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (!entry.name.startsWith(".")) await symlink(join(source, entry.name), join(root, entry.name));
  }
}
async function link(route, target) {
  await mkdir(dirname(route), { recursive: true });
  const stat = await lstat(route).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
  if (stat) {
    if (!stat.isSymbolicLink()) throw new Error(`Refusing to replace non-link route: ${route}`);
    if (await realTarget(route) === resolve(target)) return;
    const current = await realTarget(route);
    if (await exists(current)) throw new Error(`Route already targets a live external path: ${route}`);
    await rm(route);
  }
  await symlink(target, route);
}
async function apply(manifest) {
  for (const root of Object.values(AGENT_ROOTS)) await ensureRouteRoot(root);
  await mkdir(PUBLIC, { recursive: true });
  for (const item of manifest.skills) {
    const target = join(HUB, item.path);
    if (!await exists(join(target, "SKILL.md"))) throw new Error(`Hub entity missing SKILL.md: ${target}`);
    for (const route of routesFor(item)) await link(route, target);
  }
  for (const root of [PUBLIC, ...Object.values(AGENT_ROOTS)]) {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isSymbolicLink()) continue;
      const path = join(root, entry.name);
      if (!await exists(await realTarget(path))) await rm(path);
    }
  }
}
async function updateRegistry(manifest) {
  const now = new Date().toISOString();
  await withRegistryLock({}, async () => {
    const registry = await readRegistry();
    const updated = [];
    const events = [];
    for (const item of manifest.skills) {
      const canonical = join(HUB, item.path);
      const facts = await resolveSkillFacts(canonical);
      const prior = registry.skills.find((skill) => skill.name === item.name && skill.lifecycle === "active") || null;
      const record = {
        id: stableSkillId(canonical), name: item.name, lifecycle: "active", ownership: "managed",
        capability_summary: facts.capabilitySummary || prior?.capability_summary || "",
        scope: item.kind === "agent" ? { level: "agent", agent: "codex", project_root: null } : { level: "public", agent: null, project_root: null },
        install: { canonical_path: canonical, skill_md_path: join(canonical, "SKILL.md"), routes: (await Promise.all(routesFor(item).map(async (path) => (await exists(path)) ? path : null))).filter(Boolean) },
        source: facts.source, version: facts.version,
        update: { status: ["github", "git"].includes(facts.source.type) ? "unknown" : "not_checkable", latest: null, checked_at: null, error: null },
        installed_at: prior?.installed_at || now, updated_at: now,
      };
      updated.push(record);
      events.push({ action: "hub_migrate", skillId: record.id, skillName: record.name, before: prior, after: record, affectedPaths: [canonical, ...record.install.routes], result: "success", timestamp: now });
    }
    const names = new Set(manifest.skills.map((item) => item.name));
    const retained = registry.skills.filter((skill) => !names.has(skill.name));
    await writeRegistryUnlocked({ ...registry, updatedAt: now, skills: [...retained, ...updated] });
    await appendHistoryEvents(events, { historyPath: HISTORY_PATH });
  });
}
async function initialize() {
  const publicSkills = await skillDirectories(PUBLIC);
  const superpowers = (await skillDirectories(TRIAL)).filter((path) => SUPERPOWERS.has(basename(path)));
  const sources = [
    ...publicSkills.map((source) => ({ source, path: join("skills", "public", basename(source)), kind: "public" })),
    { source: PRIVATE, path: join("skills", "agents", "codex", "hatch-pet"), kind: "agent" },
    ...superpowers.map((source) => ({ source, path: join("skills", "collections", "superpowers", basename(source)), kind: "superpower" })),
  ];
  for (const item of sources) if (!await exists(join(item.source, "SKILL.md"))) throw new Error(`Missing migration source: ${item.source}`);
  const manifest = { schemaVersion: 1, skills: [] };
  for (const item of sources) {
    manifest.skills.push({ name: await skillName(item.source), slug: basename(item.source), kind: item.kind, path: item.path, agents: item.kind === "public" ? Object.keys(AGENT_ROOTS) : item.kind === "agent" ? ["codex"] : (basename(item.source) === "brainstorming" ? ["codex", "claude", "antigravity"] : ["claude", "antigravity"]) });
  }
  console.log(JSON.stringify({ hub: HUB, migrate: sources.map(({ source, path, kind }) => ({ source, destination: join(HUB, path), kind })), dryRun: !confirmed }, null, 2));
  if (!confirmed) return;
  if (await exists(HUB)) throw new Error(`Hub already exists: ${HUB}`);
  await mkdir(HUB, { recursive: true });
  for (const item of sources) {
    const destination = join(HUB, item.path);
    await mkdir(dirname(destination), { recursive: true });
    await rename(item.source, destination);
    if (await exists(join(destination, ".git"))) await rm(join(destination, ".git"), { recursive: true, force: true });
  }
  await writeFile(MANIFEST, stringify(manifest), "utf8");
  await writeFile(join(HUB, ".gitignore"), ".DS_Store\nnode_modules/\n", "utf8");
  await writeFile(join(HUB, "README.md"), "# Personal Skill Hub\n\nPrivate canonical source for long-lived personal skills. Apply routes with the Skill Control Panel Hub command after cloning or pulling.\n", "utf8");
  await mkdir(dirname(CONFIG), { recursive: true });
  await writeFile(CONFIG, stringify({ schemaVersion: 1, hubRoot: HUB }), { mode: 0o600 });
  await apply(manifest);
  await updateRegistry(manifest);
  execFileSync("git", ["init", "-b", "main"], { cwd: HUB, stdio: "inherit" });
  execFileSync("git", ["add", "."], { cwd: HUB, stdio: "inherit" });
  execFileSync("git", ["commit", "-m", "Initialize private Skill Hub"], { cwd: HUB, stdio: "inherit" });
  execFileSync("gh", ["repo", "create", "vigorX777/skill-hub", "--private", "--source", HUB, "--remote", "origin", "--push"], { cwd: HUB, stdio: "inherit" });
}

if (applyOnly) {
  const manifest = await readManifest();
  if (!confirmed) console.log(JSON.stringify({ hub: HUB, skills: manifest.skills.length, apply: true, dryRun: true }, null, 2));
  else { await apply(manifest); await updateRegistry(manifest); }
} else await initialize();
