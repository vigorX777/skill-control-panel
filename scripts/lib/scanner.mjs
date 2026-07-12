import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import { parse } from "yaml";

import { countDiagnostics, createDiagnostic } from "./diagnostics.mjs";
import { SUPPORTED_AGENTS, stableSkillId } from "./path-safety.mjs";
import { resolveSkillFacts } from "./source.mjs";

const ROOT_TYPES = ["public", "agent", "project", "system", "plugin"];
const ROOT_TYPE_SET = new Set(ROOT_TYPES);
const DEFAULT_MAX_SKILL_DOCUMENT_BYTES = 2 * 1024 * 1024;
const CLAUDE_MINIMUM_ROUTE_VERSION = "2.1.203";
const IGNORED_INFRASTRUCTURE_DIRS = new Set([
  ".codex-system",
  ".governance",
  ".omo",
  ".sisyphus",
  ".system",
]);

const EMPTY_SOURCE = Object.freeze({
  type: "unknown",
  url: null,
  repository: null,
  subpath: null,
  ref: null,
  revision: null,
  content_digest: null,
});
const EMPTY_VERSION = Object.freeze({ current: null, kind: "unknown", basis: "unknown" });
const EMPTY_UPDATE = Object.freeze({
  status: "unknown",
  latest: null,
  checked_at: null,
  error: null,
});

export class SkillDocumentTooLargeError extends Error {
  constructor(path, byteSize, maxBytes) {
    super(`SKILL.md is ${byteSize} bytes; the maximum is ${maxBytes} bytes`);
    this.name = "SkillDocumentTooLargeError";
    this.code = "SKILL_DOCUMENT_TOO_LARGE";
    this.path = path;
    this.byteSize = byteSize;
    this.maxBytes = maxBytes;
  }
}

function resolveNow(now) {
  const value = typeof now === "function" ? now() : now;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  return new Date().toISOString();
}

function emptySource() {
  return { ...EMPTY_SOURCE };
}

function emptyVersion() {
  return { ...EMPTY_VERSION };
}

function emptyUpdate() {
  return { ...EMPTY_UPDATE };
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function hasSource(source) {
  return (
    source &&
    (source.type !== "unknown" ||
      ["url", "repository", "subpath", "ref", "revision", "content_digest"].some(
        (key) => source[key] !== null && source[key] !== undefined,
      ))
  );
}

function inferSourceType(url, repository) {
  const value = `${url || ""} ${repository || ""}`.toLowerCase();
  if (value.includes("github.com")) return "github";
  if (value.trim()) return "git";
  return "unknown";
}

function normalizeFrontmatterSource(frontmatter, candidate) {
  const rawSource = frontmatter?.source ?? frontmatter?.repository ?? null;
  if (rawSource === null && candidate.pluginName) {
    return { ...emptySource(), type: "plugin", subpath: candidate.pluginName };
  }

  if (isNonEmptyString(rawSource)) {
    const value = rawSource.trim();
    const repository = frontmatter?.repository && frontmatter.repository !== rawSource
      ? String(frontmatter.repository).trim()
      : null;
    return {
      ...emptySource(),
      type: inferSourceType(value, repository),
      url: value,
      repository,
    };
  }

  if (rawSource && typeof rawSource === "object" && !Array.isArray(rawSource)) {
    const source = emptySource();
    for (const key of ["url", "repository", "subpath", "ref", "revision", "content_digest"]) {
      if (isNonEmptyString(rawSource[key])) source[key] = rawSource[key].trim();
    }
    source.type = isNonEmptyString(rawSource.type)
      ? rawSource.type.trim()
      : inferSourceType(source.url, source.repository);
    return source;
  }

  return emptySource();
}

function normalizeFrontmatterVersion(frontmatter) {
  const rawVersion = frontmatter?.version;
  if ((typeof rawVersion !== "string" && typeof rawVersion !== "number") ||
      String(rawVersion).trim() === "") {
    return emptyVersion();
  }

  const current = String(rawVersion).trim();
  const semver = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(current);
  return { current, kind: semver ? "semver" : "tag", basis: "frontmatter" };
}

function splitFrontmatter(content) {
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) {
    return { frontmatter: {}, body: content, error: null };
  }

  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) {
    return { frontmatter: {}, body: content, error: new Error("Unterminated frontmatter") };
  }

  try {
    const frontmatter = parse(match[1]);
    if (frontmatter === null) {
      return { frontmatter: {}, body: content.slice(match[0].length), error: null };
    }
    if (typeof frontmatter !== "object" || Array.isArray(frontmatter)) {
      throw new TypeError("Frontmatter must be a mapping");
    }
    return { frontmatter, body: content.slice(match[0].length), error: null };
  } catch (error) {
    return { frontmatter: {}, body: content.slice(match[0].length), error };
  }
}

function firstProseParagraph(body) {
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

  return paragraph.join(" ").trim();
}

function fallbackCapability(frontmatter, body) {
  const description = isNonEmptyString(frontmatter?.description)
    ? frontmatter.description.trim()
    : "";
  const paragraph = firstProseParagraph(body);
  if (!description) return paragraph;
  if (!paragraph || paragraph === description) return description;
  return `${description} ${paragraph}`;
}

function normalizeRoots(roots) {
  if (roots === null || typeof roots !== "object" || Array.isArray(roots)) {
    throw new TypeError("roots must be a classified object");
  }
  for (const key of Object.keys(roots)) {
    if (!ROOT_TYPE_SET.has(key)) throw new TypeError(`Unsupported root category: ${key}`);
  }

  const normalized = [];
  for (const type of ROOT_TYPES) {
    const descriptors = roots[type];
    if (!Array.isArray(descriptors)) throw new TypeError(`roots.${type} must be an array`);
    for (const descriptor of descriptors) {
      if (!descriptor || typeof descriptor !== "object" || !isNonEmptyString(descriptor.path)) {
        throw new TypeError(`roots.${type} entries require a path`);
      }
      if (!isNonEmptyString(descriptor.ownership)) {
        throw new TypeError(`roots.${type} entries require ownership`);
      }
      if (type === "public" || type === "project") {
        if (!Array.isArray(descriptor.agents) || descriptor.agents.some((agent) => !SUPPORTED_AGENTS.has(agent))) {
          throw new TypeError(`roots.${type} entries require a supported agents array`);
        }
      } else if (!SUPPORTED_AGENTS.has(descriptor.agent)) {
        throw new TypeError(`roots.${type} entries require a supported agent`);
      }
      if (type === "project" && !isNonEmptyString(descriptor.projectRoot)) {
        throw new TypeError("roots.project entries require projectRoot");
      }
      if (type === "plugin" && !isNonEmptyString(descriptor.pluginName)) {
        throw new TypeError("roots.plugin entries require pluginName");
      }
      const scope = type === "public"
        ? { level: "public", agent: null, project_root: null }
        : type === "project"
          ? { level: "project", agent: null, project_root: descriptor.projectRoot }
          : { level: "agent", agent: descriptor.agent, project_root: null };
      const agents = type === "public" || type === "project"
        ? descriptor.agents ?? []
        : descriptor.agent ? [descriptor.agent] : [];
      normalized.push({
        ...descriptor,
        type,
        path: resolve(descriptor.path),
        agents,
        scope,
      });
    }
  }
  return normalized;
}

function scopePriority(scope) {
  return { public: 3, project: 2, agent: 1 }[scope.level] ?? 0;
}

function mergeCandidate(target, incoming) {
  for (const agent of incoming.agents) target.agents.add(agent);
  for (const route of incoming.routes) target.routes.add(route);
  if (scopePriority(incoming.scope) > scopePriority(target.scope)) target.scope = incoming.scope;
  if (!target.pluginName && incoming.pluginName) target.pluginName = incoming.pluginName;
  if (!target.agentSkillKind && incoming.agentSkillKind) target.agentSkillKind = incoming.agentSkillKind;
  if (!target.provider && incoming.provider) target.provider = incoming.provider;
  if (!target.enabledBasis && incoming.enabledBasis) target.enabledBasis = incoming.enabledBasis;
  if (target.rootOwnership !== "plugin" && incoming.rootOwnership === "plugin") {
    target.rootOwnership = "plugin";
  } else if (target.rootOwnership !== "system" && incoming.rootOwnership === "system") {
    target.rootOwnership = "system";
  }
}

function diagnosticSort(left, right) {
  return (
    left.code.localeCompare(right.code) ||
    (left.path || "").localeCompare(right.path || "") ||
    (left.skillId || "").localeCompare(right.skillId || "")
  );
}

async function canonicalRegistryEntries(registry, diagnostics) {
  const entries = new Map();
  for (const skill of registry?.skills ?? []) {
    if (skill.lifecycle !== "active") continue;
    const canonicalPath = skill.install.canonical_path;
    let realPath;
    try {
      realPath = await realpath(canonicalPath);
      const canonicalStat = await stat(realPath);
      const skillDocument = join(realPath, "SKILL.md");
      const documentStat = await lstat(skillDocument);
      if (!canonicalStat.isDirectory() || !documentStat.isFile() || documentStat.isSymbolicLink()) {
        throw Object.assign(new Error("SKILL.md must be a regular file, not a symbolic link"), { code: "EINVAL" });
      }
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") {
        diagnostics.push(createDiagnostic({
          code: "skill_access_error",
          severity: "error",
          message: `Unable to inspect registered Skill "${skill.name}": ${error.message}`,
          skillId: skill.id,
          path: canonicalPath,
          details: { code: error.code ?? null },
        }));
        continue;
      }
      diagnostics.push(createDiagnostic({
        code: "stale_registry",
        severity: "warning",
        message: `Registry skill "${skill.name}" is missing from disk`,
        skillId: skill.id,
        path: canonicalPath,
      }));
      continue;
    }

    if (!entries.has(realPath)) entries.set(realPath, skill);
    for (const route of skill.install.routes) {
      let actualRealPath;
      try {
        const routeStat = await lstat(route);
        if (routeStat.isSymbolicLink()) actualRealPath = await realpath(route);
      } catch (error) {
        if (error.code !== "ENOENT" && error.code !== "ENOTDIR") {
          diagnostics.push(createDiagnostic({
            code: "route_access_error",
            severity: "error",
            message: `Unable to inspect route "${route}": ${error.message}`,
            skillId: skill.id,
            path: route,
            details: { code: error.code ?? null },
          }));
          continue;
        }
      }
      if (actualRealPath !== realPath) {
        diagnostics.push(createDiagnostic({
          code: "broken_route",
          severity: "error",
          message: `Route for "${skill.name}" does not resolve to its canonical path`,
          skillId: skill.id,
          path: route,
          details: { expectedRealPath: realPath, actualRealPath: actualRealPath ?? null },
        }));
      }
    }
  }
  return entries;
}

async function discoverRoot(descriptor, diagnostics) {
  let entries;
  try {
    entries = await readdir(descriptor.path, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return [];
    diagnostics.push(createDiagnostic({
      code: "root_access_error",
      severity: "error",
      message: `Unable to read Skill root "${descriptor.path}": ${error.message}`,
      path: descriptor.path,
      agent: descriptor.agent ?? null,
      details: { code: error.code ?? null },
    }));
    return [];
  }

  const candidates = [];
  for (const entry of entries) {
    if (IGNORED_INFRASTRUCTURE_DIRS.has(entry.name)) continue;
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const entryPath = join(descriptor.path, entry.name);
    const runtimeRoot = descriptor.type === "system" || descriptor.type === "plugin" || ["system", "plugin"].includes(descriptor.agentSkillKind);
    if (runtimeRoot && entry.isSymbolicLink()) {
      if (descriptor.ignoreBrokenEntries) continue;
      diagnostics.push(createDiagnostic({ code: "runtime_skill_symlink", severity: "warning", message: `Runtime Agent Skill entry must be a real directory: ${entryPath}`, path: entryPath, agent: descriptor.agent ?? null }));
      continue;
    }
    if (descriptor.type === "project" && entry.isSymbolicLink()) {
      diagnostics.push(createDiagnostic({ code: "project_skill_symlink", severity: "warning", message: `Project Skill entry must be a real directory: ${entryPath}`, path: entryPath }));
      continue;
    }
    let realPath;
    try {
      realPath = await realpath(entryPath);
      if (!(await stat(realPath)).isDirectory()) continue;
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") {
        diagnostics.push(createDiagnostic({
          code: "skill_access_error",
          severity: "error",
          message: `Unable to inspect Skill entry "${entryPath}": ${error.message}`,
          path: entryPath,
          agent: descriptor.agent ?? null,
          details: { code: error.code ?? null },
        }));
        continue;
      }
      if (entry.isSymbolicLink()) {
        if (descriptor.ignoreBrokenEntries) continue;
        diagnostics.push(createDiagnostic({
          code: "broken_route",
          severity: "error",
          message: `Route "${entryPath}" does not resolve to a skill`,
          path: entryPath,
          agent: descriptor.agent ?? null,
          details: { expectedRealPath: null, actualRealPath: null },
        }));
      }
      continue;
    }

    const skillMdPath = join(realPath, "SKILL.md");
    let skillMdStat = null;
    try {
      skillMdStat = await lstat(skillMdPath);
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") {
        diagnostics.push(createDiagnostic({
          code: "skill_access_error",
          severity: "error",
          message: `Unable to inspect SKILL.md at "${skillMdPath}": ${error.message}`,
          path: skillMdPath,
          agent: descriptor.agent ?? null,
          details: { code: error.code ?? null },
        }));
        continue;
      }
    }
    if (!skillMdStat?.isFile()) {
      if (descriptor.directSkillFolders || descriptor.ignoreBrokenEntries) continue;
      diagnostics.push(createDiagnostic({
        code: "missing_skill_md",
        severity: "error",
        message: `Skill directory "${entryPath}" has no SKILL.md`,
        path: entryPath,
        agent: descriptor.agent ?? null,
      }));
      continue;
    }

    candidates.push({
      realPath,
      skillMdPath,
      agents: new Set(descriptor.agents),
      routes: new Set(entry.isSymbolicLink() ? [entryPath] : []),
      scope: descriptor.scope,
      rootOwnership: descriptor.ownership,
      pluginName: descriptor.pluginName ?? null,
      agentSkillKind: descriptor.agentSkillKind ?? null,
      provider: descriptor.provider ?? null,
      enabledBasis: descriptor.enabledBasis ?? null,
    });
  }
  return candidates;
}

function compareVersions(left, right) {
  const parseVersion = (value) => {
    const match = String(value).match(/^(\d+)\.(\d+)\.(\d+)/);
    return match ? match.slice(1).map(Number) : null;
  };
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);
  if (!leftParts || !rightParts) return null;
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}

function addClaudeVersionDiagnostic(agentVersions, diagnostics) {
  const claudeVersion = agentVersions?.claude;
  if (!claudeVersion || compareVersions(claudeVersion, CLAUDE_MINIMUM_ROUTE_VERSION) >= 0) return;
  diagnostics.push(createDiagnostic({
    code: "agent_version_incompatible",
    severity: "warning",
    message: `Claude Code ${claudeVersion} does not support per-skill routes; ${CLAUDE_MINIMUM_ROUTE_VERSION} or newer is required`,
    agent: "claude",
    details: { currentVersion: claudeVersion, minimumVersion: CLAUDE_MINIMUM_ROUTE_VERSION },
  }));
}

export async function readSkillDocument(skill, options = {}) {
  const skillMdPath = skill.skillMdPath ?? skill.skill_md_path ?? skill.install?.skill_md_path;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_SKILL_DOCUMENT_BYTES;
  const documentStat = await lstat(skillMdPath);
  if (!documentStat.isFile() || documentStat.isSymbolicLink()) {
    throw new Error(`SKILL.md must be a regular file, not a symbolic link: ${skillMdPath}`);
  }
  if (documentStat.size > maxBytes) {
    throw new SkillDocumentTooLargeError(skillMdPath, documentStat.size, maxBytes);
  }
  const content = await readFile(skillMdPath, "utf8");
  const byteSize = Buffer.byteLength(content);
  if (byteSize > maxBytes) throw new SkillDocumentTooLargeError(skillMdPath, byteSize, maxBytes);
  return { content, byteSize };
}

export async function scanSkillEnvironment({
  registry = { skills: [] },
  roots = {},
  agentVersions = {},
  now,
} = {}) {
  const diagnostics = [];
  const descriptors = normalizeRoots(roots);
  const registryByRealPath = await canonicalRegistryEntries(registry, diagnostics);
  const candidatesByRealPath = new Map();

  for (const [realPath, registrySkill] of registryByRealPath) {
    candidatesByRealPath.set(realPath, {
      realPath,
      skillMdPath: join(realPath, "SKILL.md"),
      agents: new Set(registrySkill.scope.agent ? [registrySkill.scope.agent] : []),
      routes: new Set(),
      scope: registrySkill.scope,
      rootOwnership: registrySkill.ownership,
      pluginName: null,
      agentSkillKind: registrySkill.scope.level === "agent" ? "private" : null,
      provider: registrySkill.scope.agent ?? null,
      enabledBasis: registrySkill.scope.level === "agent" ? "managed_private" : null,
    });
    for (const route of registrySkill.install.routes) {
      try {
        const routeStat = await lstat(route);
        if (routeStat.isSymbolicLink() && (await realpath(route)) === realPath) {
          candidatesByRealPath.get(realPath).routes.add(route);
        }
      } catch (error) {
        if (error.code !== "ENOENT" && error.code !== "ENOTDIR") {
          diagnostics.push(createDiagnostic({
            code: "route_access_error",
            severity: "error",
            message: `Unable to inspect route "${route}": ${error.message}`,
            skillId: registrySkill.id,
            path: route,
            details: { code: error.code ?? null },
          }));
        }
      }
    }
  }

  for (const descriptor of descriptors) {
    for (const candidate of await discoverRoot(descriptor, diagnostics)) {
      const existing = candidatesByRealPath.get(candidate.realPath);
      if (existing) mergeCandidate(existing, candidate);
      else candidatesByRealPath.set(candidate.realPath, candidate);
    }
  }

  const skills = [];
  for (const candidate of candidatesByRealPath.values()) {
    const registrySkill = registryByRealPath.get(candidate.realPath) ?? null;
    let document;
    try {
      document = await readSkillDocument({ skillMdPath: candidate.skillMdPath });
    } catch (error) {
      diagnostics.push(createDiagnostic({
        code: "skill_document_error",
        severity: "error",
        message: `Unable to read SKILL.md at "${candidate.skillMdPath}": ${error.message}`,
        path: candidate.skillMdPath,
        details: { code: error.code ?? null },
      }));
      continue;
    }
    const parsed = splitFrontmatter(document.content);
    const skillId = registrySkill?.id ?? stableSkillId(candidate.realPath);
    const skillName = registrySkill?.name ||
      (isNonEmptyString(parsed.frontmatter.name) ? parsed.frontmatter.name.trim() : basename(candidate.realPath));

    if (parsed.error) {
      diagnostics.push(createDiagnostic({
        code: "invalid_frontmatter",
        severity: "warning",
        message: `SKILL.md frontmatter for "${skillName}" is invalid`,
        skillId,
        path: candidate.skillMdPath,
        details: { error: parsed.error.message },
      }));
    }
    if (!registrySkill && !["plugin", "system"].includes(candidate.rootOwnership)) {
      diagnostics.push(createDiagnostic({
        code: "unmanaged_skill",
        severity: "warning",
        message: `Skill "${skillName}" is not present in the registry`,
        skillId,
        path: candidate.realPath,
      }));
    }

    let facts;
    try {
      facts = await resolveSkillFacts(candidate.realPath);
    } catch (error) {
      diagnostics.push(createDiagnostic({
        code: "skill_fact_error",
        severity: "error",
        message: `Unable to resolve facts for Skill "${skillName}": ${error.message}`,
        skillId,
        path: candidate.realPath,
        details: { code: error.code ?? null },
      }));
      continue;
    }
    const frontmatterVersion = facts.version.current ? facts.version : normalizeFrontmatterVersion(parsed.frontmatter);
    const parsedSource = normalizeFrontmatterSource(parsed.frontmatter, candidate);
    const frontmatterSource = candidate.pluginName && facts.source.type === "local"
      ? parsedSource
      : facts.source;
    const capabilitySummary = isNonEmptyString(registrySkill?.capability_summary)
      ? registrySkill.capability_summary.trim()
      : facts.capabilitySummary || fallbackCapability(parsed.frontmatter, parsed.body);

    skills.push({
      id: skillId,
      name: skillName,
      realPath: candidate.realPath,
      scope: registrySkill?.scope ?? candidate.scope,
      agents: [...candidate.agents].sort(),
      version: registrySkill?.version?.current ? { ...registrySkill.version } : frontmatterVersion,
      source: hasSource(registrySkill?.source) ? { ...registrySkill.source } : frontmatterSource,
      capabilitySummary,
      skillMdPath: candidate.skillMdPath,
      routes: [...candidate.routes].sort(),
      ownership: registrySkill?.ownership ??
        (["plugin", "system"].includes(candidate.rootOwnership) ? candidate.rootOwnership : "unmanaged"),
      agentSkillKind: candidate.agentSkillKind || (candidate.scope.level === "agent" ? "private" : null),
      provider: candidate.provider,
      enabledBasis: candidate.enabledBasis || (candidate.scope.level === "agent" ? "managed_private" : null),
      update: registrySkill?.update ? { ...registrySkill.update } : emptyUpdate(),
    });
  }

  skills.sort((left, right) => left.name.localeCompare(right.name) || left.realPath.localeCompare(right.realPath));
  const skillsByName = new Map();
  for (const skill of skills) {
    const named = skillsByName.get(skill.name) ?? [];
    named.push(skill);
    skillsByName.set(skill.name, named);
  }
  for (const [name, namedSkills] of skillsByName) {
    if (namedSkills.length < 2) continue;
    const versions = new Set(namedSkills.map((skill) => skill.version?.current).filter(Boolean));
    const sources = new Set(namedSkills.map((skill) => skill.source?.url || skill.source?.repository).filter(Boolean));
    const digests = new Set(namedSkills.map((skill) => skill.source?.content_digest).filter(Boolean));
    if (versions.size > 1 || sources.size > 1 || digests.size > 1) {
      diagnostics.push(createDiagnostic({
        code: "instance_difference",
        severity: "warning",
        message: `Skill "${name}" has differing installation instances`,
        details: { name, instanceIds: namedSkills.map((skill) => skill.id).sort() },
      }));
    }
  }

  addClaudeVersionDiagnostic(agentVersions, diagnostics);
  diagnostics.sort(diagnosticSort);
  return {
    scannedAt: resolveNow(now),
    skills,
    diagnostics,
    summary: {
      totalSkills: skills.length,
      updateAvailable: skills.filter((skill) => skill.update.status === "update_available").length,
      managedSkills: skills.filter((skill) => skill.ownership !== "unmanaged").length,
      unmanagedSkills: skills.filter((skill) => skill.ownership === "unmanaged").length,
      diagnostics: countDiagnostics(diagnostics),
    },
  };
}
