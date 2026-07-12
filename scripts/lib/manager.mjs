import { homedir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { lstat, realpath, cp, rename, rm, mkdir, access, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { parse } from "yaml";

import {
  readRegistry,
  writeRegistryUnlocked,
  withRegistryLock,
} from "./registry.mjs";
import { appendHistoryEvent, appendHistoryEvents, readHistory } from "./history.mjs";
import { scanSkillEnvironment } from "./scanner.mjs";
import { checkSkillUpdate, mergeUpdateResult } from "./update-checker.mjs";
import {
  resolveInstalledVersion,
  resolveSourceMetadata,
  resolveSkillFacts,
  computeDirectoryDigest,
} from "./source.mjs";
import { REGISTRY_PATH, HISTORY_PATH, AGENTS_CONFIG_DIR, SKILL_HUB_CONFIG_PATH, TRASH_DIR } from "./constants.mjs";
import {
  assertSafeSkillName,
  assertCanonicalPathForScope,
  assertSupportedAgent,
  resolveInsideRoot,
  stableSkillId,
} from "./path-safety.mjs";
import { runMutationTransaction } from "./mutation-transaction.mjs";
import {
  applyRoutePlan,
  getAgentRouteRoots,
  migrateDirectoryRoute,
  planRouteRemoval,
  planRoutesForSkill,
} from "./routes.mjs";
import { stageMoveAcrossFilesystems } from "./fs-move.mjs";
import { countDiagnostics } from "./diagnostics.mjs";
import { resolveScanRoots } from "./project-discovery.mjs";
export { reconcileCurrentFacts as reconcile } from "./reconcile.mjs";

export function getDefaultRoots(options = {}) {
  let hubRoot = options.hubRoot || process.env.SKILL_CONTROL_PANEL_HUB_ROOT || null;
  if (!hubRoot) {
    try {
      const config = parse(readFileSync(SKILL_HUB_CONFIG_PATH, "utf8"));
      if (config?.schemaVersion === 1 && typeof config.hubRoot === "string" && config.hubRoot.startsWith("/")) hubRoot = config.hubRoot;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const publicPath =
    options.publicRoot ||
    process.env.SKILL_CONTROL_PANEL_PUBLIC_ROOT ||
    (hubRoot ? join(hubRoot, "skills", "public") : join(homedir(), ".agents", "skills"));
  const agentSkillsDir =
    options.agentSkillsDir ||
    process.env.SKILL_CONTROL_PANEL_AGENT_SKILLS_DIR ||
    (hubRoot ? join(hubRoot, "skills", "agents") : join(AGENTS_CONFIG_DIR, "agent-skills"));

  const roots = {
    public: [
      {
        path: publicPath,
        agents: [],
        ownership: "managed",
      },
      ...(hubRoot ? [{ path: join(hubRoot, "skills", "collections", "superpowers"), agents: [], ownership: "managed" }] : []),
    ],
    agent: [
      { path: join(agentSkillsDir, "codex"), agent: "codex", ownership: "managed" },
      { path: join(agentSkillsDir, "claude"), agent: "claude", ownership: "managed" },
      { path: join(agentSkillsDir, "antigravity"), agent: "antigravity", ownership: "managed" },
      { path: join(agentSkillsDir, "opencode"), agent: "opencode", ownership: "managed" },
    ],
    project: [],
    system: [],
    plugin: [],
  };

  const projectRoot =
    options.projectRoot || process.env.SKILL_CONTROL_PANEL_PROJECT_ROOT || process.cwd();
  if (projectRoot) {
    roots.project.push({
      path: join(projectRoot, ".agents", "skills"),
      projectRoot,
      agents: [],
      ownership: "managed",
    });
  }

  return roots;
}

async function validateSourceDirectory(source) {
  const sourceInfo = await lstat(source);
  if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) {
    throw new Error("Source must be a real directory, not a symbolic link");
  }
  const skillDocumentInfo = await lstat(join(source, "SKILL.md"));
  if (!skillDocumentInfo.isFile() || skillDocumentInfo.isSymbolicLink()) {
    throw new Error("Source SKILL.md must be a regular file, not a symbolic link");
  }
}

async function validateMutableCanonical(skill, options) {
  const defaults = getDefaultRoots(options);
  const canonicalScopeRoot = assertCanonicalPathForScope(skill, {
    publicRoot: options.publicRoot || defaults.public[0].path,
    agentSkillsDir: options.agentSkillsDir || join(AGENTS_CONFIG_DIR, "agent-skills"),
  });
  const canonicalInfo = await lstat(skill.install.canonical_path);
  if (!canonicalInfo.isDirectory() || canonicalInfo.isSymbolicLink()) {
    throw new Error("Registry canonical path must be a real directory");
  }
  const documentInfo = await lstat(skill.install.skill_md_path);
  if (!documentInfo.isFile() || documentInfo.isSymbolicLink()) {
    throw new Error("Registry SKILL.md path must be a regular file");
  }
  const [canonicalRealPath, scopeRootRealPath, documentRealPath] = await Promise.all([
    realpath(skill.install.canonical_path),
    realpath(canonicalScopeRoot),
    realpath(skill.install.skill_md_path),
  ]);
  if (dirname(canonicalRealPath) !== scopeRootRealPath) {
    throw new Error("Registry canonical path does not match its scope");
  }
  if (documentRealPath !== join(canonicalRealPath, "SKILL.md")) {
    throw new Error("Registry SKILL.md path does not match its canonical path");
  }
  return skill.install.canonical_path;
}

export async function getAgentVersions(options = {}) {
  const versions = { claude: null, codex: null, antigravity: null, opencode: null };
  try {
    const output = execSync("claude --version", {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    const match = output.match(/(\d+\.\d+\.\d+)/);
    if (match) {
      versions.claude = match[1];
    }
  } catch {
    // ignore
  }
  return versions;
}

export async function scan(options = {}) {
  const registry = await readRegistry(options);
  const baseRoots = options.roots || getDefaultRoots(options);
  const discoverProjects = options.discoverProjects ?? options.roots === undefined;
  const resolved = discoverProjects
    ? await resolveScanRoots(baseRoots, options)
    : { roots: baseRoots, diagnostics: [] };
  const agentVersions = options.agentVersions || (await getAgentVersions(options));
  const result = await scanSkillEnvironment({
    registry,
    roots: resolved.roots,
    agentVersions,
    now: options.now,
  });
  if (resolved.diagnostics.length === 0) return result;
  result.diagnostics = [...result.diagnostics, ...resolved.diagnostics]
    .sort((left, right) => left.code.localeCompare(right.code) || (left.path || "").localeCompare(right.path || ""));
  result.summary = { ...result.summary, diagnostics: countDiagnostics(result.diagnostics) };
  return result;
}

function splitFrontmatter(content) {
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) {
    return { frontmatter: {}, body: content };
  }
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return { frontmatter: {}, body: content };
  try {
    const frontmatter = parse(match[1]);
    return { frontmatter: frontmatter || {}, body: content.slice(match[0].length) };
  } catch {
    return { frontmatter: {}, body: content.slice(match[0].length) };
  }
}

function fallbackCapability(frontmatter, body) {
  const description = frontmatter?.description ? String(frontmatter.description).trim() : "";
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  let paragraph = [];
  let inFence = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence || /^#{1,6}\s/.test(trimmed) || /^<!--/.test(trimmed)) continue;
    if (trimmed === "") {
      if (paragraph.length > 0) break;
      continue;
    }
    if (/^(?:[-*+] |\d+[.)] )/.test(trimmed)) {
      if (paragraph.length > 0) break;
      continue;
    }
    paragraph.push(trimmed);
  }
  const paraStr = paragraph.join(" ").trim();
  if (!description) return paraStr;
  if (!paraStr || paraStr === description) return description;
  return `${description} ${paraStr}`;
}

function resetUpdateForSource(source) {
  return {
    status: ["github", "git"].includes(source?.type) ? "unknown" : "not_checkable",
    latest: null,
    checked_at: null,
    error: null,
  };
}

function retainRemoteSource(previous, resolved) {
  if (["github", "git"].includes(previous?.type) && ["local", "unknown"].includes(resolved?.type)) {
    return { ...previous, content_digest: resolved.content_digest };
  }
  return resolved;
}

// Helper to check path exists
async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function upsertRegistrySnapshot(registry, skill, now, previousId = skill.id) {
  const index = registry.skills.findIndex((item) => item.id === previousId);
  const skills = [...registry.skills];
  if (index === -1) skills.push(skill);
  else skills[index] = skill;
  return { ...registry, updatedAt: now, skills };
}

async function lockedMutation(options, work) {
  try {
    return await withRegistryLock(options, async () => runMutationTransaction(work));
  } catch (error) {
    return { ok: false, error: error.message, rolledBack: false, rollbackErrors: [] };
  }
}

export async function adopt(options = {}) {
  const scanResult = await scan(options);
  const now = options.now || new Date().toISOString();
  let candidates;
  if (options.all) {
    candidates = scanResult.skills.filter((skill) => skill.ownership === "unmanaged");
  } else {
    const skillPath = await realpath(resolve(options.path));
    const documentInfo = await lstat(join(skillPath, "SKILL.md"));
    if (!documentInfo.isFile() || documentInfo.isSymbolicLink()) {
      throw new Error(`Directory ${skillPath} is not a valid skill (SKILL.md must be a regular file)`);
    }
    const matched = scanResult.skills.find((skill) => skill.realPath === skillPath);
    if (!matched) throw new Error(`Skill path is outside the configured scan roots: ${skillPath}`);
    candidates = matched.ownership === "unmanaged" ? [matched] : [];
  }

  const records = candidates.map((skill) => ({
    id: skill.id,
    name: assertSafeSkillName(skill.name),
    lifecycle: "active",
    ownership: "adopted",
    capability_summary: skill.capabilitySummary || "",
    scope: {
      level: skill.scope.level,
      agent: skill.scope.agent || null,
      project_root: skill.scope.project_root || null,
    },
    install: {
      canonical_path: skill.realPath,
      skill_md_path: skill.skillMdPath,
      routes: skill.routes || [],
    },
    source: {
      type: skill.source.type || "unknown",
      url: skill.source.url || null,
      repository: skill.source.repository || null,
      subpath: skill.source.subpath || null,
      ref: skill.source.ref || null,
      revision: skill.source.revision || null,
      content_digest: skill.source.content_digest || null,
    },
    version: {
      current: skill.version.current || null,
      kind: skill.version.kind || "unknown",
      basis: skill.version.basis || "unknown",
    },
    update: resetUpdateForSource(skill.source),
    installed_at: now,
    updated_at: now,
  }));

  if (records.length === 0) return { ok: true, adopted: [] };
  return lockedMutation(options, async ({ onRollback }) => {
    const registry = await readRegistry(options);
    const adopted = records.filter((record) => !registry.skills.some(
      (skill) => skill.id === record.id || (skill.lifecycle === "active" && skill.name === record.name),
    ));
    if (adopted.length === 0) return { ok: true, adopted: [] };
    const updatedRegistry = { ...registry, updatedAt: now, skills: [...registry.skills, ...adopted] };
    await writeRegistryUnlocked(updatedRegistry, options);
    onRollback(() => writeRegistryUnlocked(registry, options));
    await appendHistoryEvents(adopted.map((record) => ({
      action: "adopt_existing",
      skillId: record.id,
      skillName: record.name,
      before: null,
      after: record,
      affectedPaths: [record.install.canonical_path],
      result: "success",
      timestamp: now,
      actor: options.actor || null,
    })), options);
    return { ok: true, adopted, rolledBack: false };
  });
}

export async function checkUpdates(options = {}) {
  const snapshot = await readRegistry(options);
  const now = options.now || new Date().toISOString();
  const targets = snapshot.skills.filter((skill) =>
    skill.lifecycle === "active" && (!options.skillId || skill.id === options.skillId));
  if (options.skillId && targets.length === 0) throw new Error(`Skill ${options.skillId} not found in registry`);
  const checkedById = new Map();
  const fingerprintById = new Map();
  for (const skill of targets) checkedById.set(skill.id, await checkSkillUpdate(skill, { ...options, now }));
  for (const skill of targets) fingerprintById.set(skill.id, JSON.stringify({
    canonicalPath: skill.install.canonical_path,
    source: skill.source,
    version: skill.version,
  }));

  return lockedMutation(options, async ({ onRollback }) => {
    const registry = await readRegistry(options);
    const events = [];
    const results = [];
    const skills = registry.skills.map((skill) => {
      const checked = checkedById.get(skill.id);
      if (!checked || skill.lifecycle !== "active") return skill;
      const currentFingerprint = JSON.stringify({
        canonicalPath: skill.install.canonical_path,
        source: skill.source,
        version: skill.version,
      });
      if (currentFingerprint !== fingerprintById.get(skill.id)) return skill;
      const update = mergeUpdateResult(skill.update, checked);
      results.push(update);
      events.push({
        action: "update_check",
        skillId: skill.id,
        skillName: skill.name,
        before: skill.update ? { ...skill.update } : null,
        after: update,
        result: checked.status,
        timestamp: now,
        actor: options.actor || null,
      });
      return { ...skill, update };
    });
    if (events.length === 0) return { ok: true, results: [], events: [], rolledBack: false };
    const updatedRegistry = { ...registry, updatedAt: now, skills };
    await writeRegistryUnlocked(updatedRegistry, options);
    onRollback(() => writeRegistryUnlocked(registry, options));
    const savedEvents = await appendHistoryEvents(events, options);
    return { ok: true, results, events: savedEvents, rolledBack: false };
  });
}

export async function validate(options = {}) {
  const scanResult = await scan(options);
  const skillId = options.skillId;

  let diagnostics = scanResult.diagnostics;
  if (skillId) {
    diagnostics = diagnostics.filter((d) => d.skillId === skillId);
  }

  const hasErrors = diagnostics.some((d) => d.severity === "error");
  return {
    ok: !hasErrors,
    diagnostics,
  };
}

// ── install ────────────────────────────────────────────────────────

export async function install(params, options = {}) {
  const { source, scope, agent, projectRoot: requestedProjectRoot, vetted } = params;
  const now = options.now || new Date().toISOString();

  if (!vetted) {
    return { ok: false, error: "External install must be vetted with --vetted", rolledBack: false };
  }

  try {
    await validateSourceDirectory(source);
  } catch (error) {
    return { ok: false, error: `Source directory is not a valid skill: ${error.message}`, rolledBack: false };
  }

  // Resolve source details
  const version = await resolveInstalledVersion(source);
  const sourceMeta = await resolveSourceMetadata(source);

  // Read and parse frontmatter for name and capability summary directly
  let name = basename(source);
  let capabilitySummary = "";
  try {
    const content = await readFile(join(source, "SKILL.md"), "utf8");
    const parsed = splitFrontmatter(content);
    if (parsed.frontmatter?.name) {
      name = String(parsed.frontmatter.name).trim();
    }
    capabilitySummary = fallbackCapability(parsed.frontmatter, parsed.body);
  } catch {
    // Ignore, fallback to defaults
  }
  try {
    name = assertSafeSkillName(name);
  } catch (error) {
    return { ok: false, error: error.message, rolledBack: false };
  }

  const defaultRoots = getDefaultRoots(options);
  let canonicalPath = "";
  let skillScope = {};

  if (scope === "public") {
    const publicRoot = options.publicRoot || (defaultRoots.public[0]?.path);
    canonicalPath = resolveInsideRoot(publicRoot, name);
    skillScope = { level: "public", agent: null, project_root: null };
  } else if (scope === "agent") {
    const agName = agent || "claude";
    try {
      assertSupportedAgent(agName);
    } catch (error) {
      return { ok: false, error: error.message, rolledBack: false };
    }
    const agentSkillsDir = options.agentSkillsDir || join(AGENTS_CONFIG_DIR, "agent-skills");
    canonicalPath = resolveInsideRoot(join(agentSkillsDir, agName), name);
    skillScope = { level: "agent", agent: agName, project_root: null };
  } else if (scope === "project") {
    const projectRoot = requestedProjectRoot || options.projectRoot || process.cwd();
    canonicalPath = resolveInsideRoot(join(projectRoot, ".agents", "skills"), name);
    skillScope = { level: "project", agent: null, project_root: projectRoot };
  } else {
    return { ok: false, error: `Invalid scope: ${scope}`, rolledBack: false };
  }

  const tempStagingPath = join(dirname(canonicalPath), `.${name}.${Date.now()}.${randomUUID()}.tmp`);

  return lockedMutation(options, async ({ onRollback, onCommitCleanup }) => {
    const registry = await readRegistry(options);
    if (registry.skills.some((skill) => skill.name === name && skill.lifecycle === "active")) {
      throw new Error(`Duplicate skill name: ${name}`);
    }
    if (await exists(canonicalPath)) throw new Error(`Target path already exists: ${canonicalPath}`);

    await mkdir(dirname(canonicalPath), { recursive: true });
    onRollback(() => rm(tempStagingPath, { recursive: true, force: true }));
    onCommitCleanup(() => rm(tempStagingPath, { recursive: true, force: true }));
    await cp(source, tempStagingPath, { recursive: true });
    await rename(tempStagingPath, canonicalPath);
    onRollback(() => rm(canonicalPath, { recursive: true, force: true }));

    sourceMeta.content_digest = await computeDirectoryDigest(canonicalPath);
    const draftRecord = {
      id: stableSkillId(canonicalPath),
      name,
      lifecycle: "active",
      ownership: "managed",
      capability_summary: capabilitySummary,
      scope: skillScope,
      install: { canonical_path: canonicalPath, skill_md_path: join(canonicalPath, "SKILL.md"), routes: [] },
      source: sourceMeta,
      version,
      update: resetUpdateForSource(sourceMeta),
      installed_at: now,
      updated_at: now,
    };
    const appliedRoutes = await applyRoutePlan(
      await planRoutesForSkill(draftRecord, getAgentRouteRoots(options)),
    );
    onRollback(() => appliedRoutes.rollback());
    onCommitCleanup(() => appliedRoutes.cleanup());
    const record = {
      ...draftRecord,
      install: { ...draftRecord.install, routes: appliedRoutes.routes },
    };

    await writeRegistryUnlocked(upsertRegistrySnapshot(registry, record, now), options);
    onRollback(() => writeRegistryUnlocked(registry, options));
    await appendHistoryEvent({
      action: "install", skillId: record.id, skillName: record.name, before: null, after: record,
      affectedPaths: [canonicalPath], result: "success", timestamp: now,
    }, options);

    return { ok: true, action: "install", skill: record, affectedPaths: [canonicalPath], rolledBack: false };
  });
}

// ── update ─────────────────────────────────────────────────────────

export async function update(params, options = {}) {
  const { skillId, source, vetted } = params;
  const now = options.now || new Date().toISOString();

  if (!vetted) {
    return { ok: false, error: "External update must be vetted with --vetted", rolledBack: false };
  }

  try {
    await validateSourceDirectory(source);
  } catch (error) {
    return { ok: false, error: `Source directory is not a valid skill: ${error.message}`, rolledBack: false };
  }

  return lockedMutation(options, async ({ onRollback, onCommitCleanup }) => {
    const registry = await readRegistry(options);
    const skill = registry.skills.find((item) => item.id === skillId && item.lifecycle === "active");
    if (!skill) throw new Error(`Skill ${skillId} not found in registry`);

    const canonicalPath = await validateMutableCanonical(skill, options);
    const name = skill.name;
    const backupPath = join(dirname(canonicalPath), `.${name}.backup.${Date.now()}.${randomUUID()}.tmp`);
    const tempStagingPath = join(dirname(canonicalPath), `.${name}.update.${Date.now()}.${randomUUID()}.tmp`);
    onRollback(() => rm(tempStagingPath, { recursive: true, force: true }));
    onCommitCleanup(() => rm(tempStagingPath, { recursive: true, force: true }));
    await cp(source, tempStagingPath, { recursive: true });
    if (!(await lstat(join(tempStagingPath, "SKILL.md"))).isFile()) throw new Error("Staged SKILL.md is not a regular file");
    const stagedDocument = splitFrontmatter(await readFile(join(tempStagingPath, "SKILL.md"), "utf8"));
    if (stagedDocument.frontmatter?.name && String(stagedDocument.frontmatter.name).trim() !== name) {
      throw new Error(`Staged Skill name does not match registry identity: ${name}`);
    }

    await rename(canonicalPath, backupPath);
    onRollback(() => rename(backupPath, canonicalPath));
    onCommitCleanup(() => rm(backupPath, { recursive: true, force: true }));
    await rename(tempStagingPath, canonicalPath);
    onRollback(() => rm(canonicalPath, { recursive: true, force: true }));

    const facts = await resolveSkillFacts(canonicalPath);
    const sourceFacts = retainRemoteSource(skill.source, facts.source);
    const updatedRecord = {
      ...skill,
      capability_summary: facts.capabilitySummary || skill.capability_summary,
      version: facts.version,
      source: sourceFacts,
      update: resetUpdateForSource(sourceFacts),
      updated_at: now,
    };

    await writeRegistryUnlocked(upsertRegistrySnapshot(registry, updatedRecord, now), options);
    onRollback(() => writeRegistryUnlocked(registry, options));
    await appendHistoryEvent({
      action: "update", skillId: skill.id, skillName: skill.name, before: skill, after: updatedRecord,
      affectedPaths: [canonicalPath], result: "success", timestamp: now,
    }, options);

    return { ok: true, action: "update", skill: updatedRecord, affectedPaths: [canonicalPath], rolledBack: false };
  });
}

// ── move ───────────────────────────────────────────────────────────

export async function move(params, options = {}) {
  const { skillId, scope, agent, projectRoot: requestedProjectRoot, confirmed } = params;
  const now = options.now || new Date().toISOString();

  if (!confirmed) {
    return { ok: false, error: "Scope move must be confirmed with --confirmed", rolledBack: false };
  }

  return lockedMutation(options, async ({ onRollback, onCommitCleanup }) => {
    const registry = await readRegistry(options);
    const skill = registry.skills.find((item) => item.id === skillId && item.lifecycle === "active");
    if (!skill) throw new Error(`Skill ${skillId} not found`);
    const oldCanonicalPath = await validateMutableCanonical(skill, options);
    const name = assertSafeSkillName(skill.name);
    const defaultRoots = getDefaultRoots(options);
    let newCanonicalPath;
    let newScope;
    if (scope === "public") {
      const publicRoot = options.publicRoot || defaultRoots.public[0].path;
      newCanonicalPath = resolveInsideRoot(publicRoot, name);
      newScope = { level: "public", agent: null, project_root: null };
    } else if (scope === "agent") {
      const agName = assertSupportedAgent(agent || "claude");
      const agentSkillsDir = options.agentSkillsDir || join(AGENTS_CONFIG_DIR, "agent-skills");
      newCanonicalPath = resolveInsideRoot(join(agentSkillsDir, agName), name);
      newScope = { level: "agent", agent: agName, project_root: null };
    } else if (scope === "project") {
      const projectRoot = requestedProjectRoot || options.projectRoot || process.cwd();
      newCanonicalPath = resolveInsideRoot(join(projectRoot, ".agents", "skills"), name);
      newScope = { level: "project", agent: null, project_root: projectRoot };
    } else {
      throw new Error(`Invalid scope: ${scope}`);
    }
    if (oldCanonicalPath === newCanonicalPath) {
      return { ok: true, action: "move", skill, affectedPaths: [], rolledBack: false };
    }
    if (await exists(newCanonicalPath)) throw new Error(`Target path already exists: ${newCanonicalPath}`);
    const stagedMove = await stageMoveAcrossFilesystems(oldCanonicalPath, newCanonicalPath, options.fsMoveOptions);
    onRollback(() => stagedMove.rollback());
    onCommitCleanup(() => stagedMove.cleanup());
    const draftRecord = {
      ...skill,
      id: stableSkillId(newCanonicalPath),
      scope: newScope,
      install: { ...skill.install, canonical_path: newCanonicalPath, skill_md_path: join(newCanonicalPath, "SKILL.md") },
      updated_at: now,
    };
    const appliedRoutes = await applyRoutePlan(
      await planRoutesForSkill(draftRecord, getAgentRouteRoots(options), {
        previousCanonicalPath: oldCanonicalPath,
      }),
    );
    onRollback(() => appliedRoutes.rollback());
    onCommitCleanup(() => appliedRoutes.cleanup());
    const updatedRecord = {
      ...draftRecord,
      install: { ...draftRecord.install, routes: appliedRoutes.routes },
    };
    await writeRegistryUnlocked(upsertRegistrySnapshot(registry, updatedRecord, now, skill.id), options);
    onRollback(() => writeRegistryUnlocked(registry, options));
    await appendHistoryEvent({
      action: "scope_change", skillId: updatedRecord.id, skillName: skill.name, before: skill, after: updatedRecord,
      affectedPaths: [oldCanonicalPath, newCanonicalPath], result: "success", timestamp: now,
    }, options);
    return { ok: true, action: "move", skill: updatedRecord, affectedPaths: [oldCanonicalPath, newCanonicalPath], rolledBack: false };
  });
}

// ── uninstall ──────────────────────────────────────────────────────

export async function uninstall(params, options = {}) {
  const { skillId, confirmed } = params;
  const now = options.now || new Date().toISOString();

  if (!confirmed) {
    return { ok: false, error: "Uninstall must be confirmed with --confirmed", rolledBack: false };
  }

  return lockedMutation(options, async ({ onRollback, onCommitCleanup }) => {
    const registry = await readRegistry(options);
    const skill = registry.skills.find((item) => item.id === skillId && item.lifecycle === "active");
    if (!skill) throw new Error(`Skill ${skillId} not found`);
    const canonicalPath = await validateMutableCanonical(skill, options);
    const name = assertSafeSkillName(skill.name);
    const trashDir = options.trashDir || TRASH_DIR;
    const timestampTrashDir = resolveInsideRoot(trashDir, `${Date.now()}`);
    const targetTrashPath = resolveInsideRoot(timestampTrashDir, name);
    await mkdir(timestampTrashDir, { recursive: true });
    const stagedMove = await stageMoveAcrossFilesystems(canonicalPath, targetTrashPath, options.fsMoveOptions);
    onRollback(() => stagedMove.rollback());
    onCommitCleanup(() => stagedMove.cleanup());
    const appliedRoutes = await applyRoutePlan(planRouteRemoval(skill, getAgentRouteRoots(options)));
    onRollback(() => appliedRoutes.rollback());
    onCommitCleanup(() => appliedRoutes.cleanup());
    const updatedRecord = {
      ...skill,
      lifecycle: "removed",
      install: { ...skill.install, routes: [] },
      updated_at: now,
    };
    await writeRegistryUnlocked(upsertRegistrySnapshot(registry, updatedRecord, now), options);
    onRollback(() => writeRegistryUnlocked(registry, options));
    await appendHistoryEvent({
      action: "uninstall", skillId: skill.id, skillName: skill.name, before: skill, after: updatedRecord,
      affectedPaths: [canonicalPath, targetTrashPath], result: "success", timestamp: now,
    }, options);
    return { ok: true, action: "uninstall", skill: updatedRecord, affectedPaths: [canonicalPath, targetTrashPath], rolledBack: false };
  });
}

export async function migrateRoutes(params, options = {}) {
  const { agent, confirmed } = params;
  if (!confirmed) return { ok: false, error: "Route migration must be confirmed with --confirmed", rolledBack: false };
  try {
    assertSupportedAgent(agent);
  } catch (error) {
    return { ok: false, error: error.message, rolledBack: false };
  }
  const now = options.now || new Date().toISOString();
  return lockedMutation(options, async ({ onRollback }) => {
    const registry = await readRegistry(options);
    const publicSkills = registry.skills.filter(
      (skill) => skill.lifecycle === "active" && skill.scope.level === "public" && ["managed", "adopted"].includes(skill.ownership),
    );
    const routablePublicSkills = [];
    for (const skill of publicSkills) {
      try {
        await validateMutableCanonical(skill, options);
        routablePublicSkills.push(skill);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    const routeRoot = getAgentRouteRoots(options)[agent];
    if (!routeRoot) throw new Error(`Route root is not configured for ${agent}`);
    const backupRoot = options.routeBackupRoot || join(options.trashDir || TRASH_DIR, "route-migrations");
    const agentVersions = options.agentVersions || await getAgentVersions(options);
    const migration = await migrateDirectoryRoute({
      agent,
      routeRoot,
      backupRoot,
      confirmed,
      agentVersions,
      skills: routablePublicSkills,
    });
    onRollback(() => migration.rollback());

    const updatedSkills = registry.skills.map((skill) => {
      if (!routablePublicSkills.some((item) => item.id === skill.id)) return skill;
      const route = resolveInsideRoot(routeRoot, assertSafeSkillName(skill.name));
      return {
        ...skill,
        install: { ...skill.install, routes: [...new Set([...(skill.install.routes || []), route])].sort() },
        updated_at: now,
      };
    });
    const updatedRegistry = { ...registry, updatedAt: now, skills: updatedSkills };
    await writeRegistryUnlocked(updatedRegistry, options);
    onRollback(() => writeRegistryUnlocked(registry, options));
    await appendHistoryEvents(
      routablePublicSkills.map((before) => ({
        action: "route_change",
        skillId: before.id,
        skillName: before.name,
        before,
        after: updatedSkills.find((skill) => skill.id === before.id),
        affectedPaths: [routeRoot, migration.backupPath],
        result: "success",
        timestamp: now,
      })),
      options,
    );
    return {
      ok: true,
      action: "migrate-routes",
      agent,
      routeRoot,
      backupPath: migration.backupPath,
      migratedSkills: routablePublicSkills.length,
      rolledBack: false,
    };
  });
}
