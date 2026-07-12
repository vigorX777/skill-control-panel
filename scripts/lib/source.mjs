import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { execSync } from "node:child_process";

import { parse } from "yaml";

// ── constants ────────────────────────────────────────────────────────

const SEMVER_PATTERN = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

const IGNORED_ENTRIES = new Set([
  ".git",
  ".DS_Store",
  "node_modules",
  "__pycache__",
  ".superpowers",
  "coverage",
  ".tmp",
]);

const GITHUB_HTTPS_PATTERN = /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/.*)?$/;
const GITHUB_SSH_PATTERN = /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/;

// ── frontmatter parsing ──────────────────────────────────────────────

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

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

// ── GitHub URL normalization ─────────────────────────────────────────

function normalizeGitHubUrl(url) {
  if (!url) return null;
  const str = String(url).trim();

  const httpsMatch = str.match(GITHUB_HTTPS_PATTERN);
  if (httpsMatch) {
    const repository = httpsMatch[2].split(/[?#]/, 1)[0].replace(/\.git$/, "");
    return `https://github.com/${httpsMatch[1]}/${repository}`;
  }

  const sshMatch = str.match(GITHUB_SSH_PATTERN);
  if (sshMatch) return `https://github.com/${sshMatch[1]}/${sshMatch[2]}`;

  return null;
}

function normalizeGitUrl(url) {
  if (!url) return null;
  const str = String(url).trim().replace(/\.git$/, "");
  return str || null;
}

function isGitHubUrl(url) {
  if (!url) return false;
  const str = String(url).toLowerCase();
  return str.includes("github.com");
}

// ── resolveInstalledVersion ──────────────────────────────────────────

async function readSkillFrontmatter(skillDir) {
  try {
    const content = await readFile(join(skillDir, "SKILL.md"), "utf8");
    return splitFrontmatter(content).frontmatter;
  } catch {
    return {};
  }
}

async function readPackageVersion(skillDir) {
  try {
    const content = await readFile(join(skillDir, "package.json"), "utf8");
    const pkg = JSON.parse(content);
    return isNonEmptyString(pkg?.version) ? String(pkg.version).trim() : null;
  } catch {
    return null;
  }
}

function getGitTag(skillDir) {
  try {
    const tag = execSync("git describe --tags --exact-match HEAD 2>/dev/null", {
      cwd: skillDir,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return tag || null;
  } catch {
    return null;
  }
}

function getGitCommit(skillDir) {
  try {
    return execSync("git rev-parse HEAD", {
      cwd: skillDir,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim() || null;
  } catch {
    return null;
  }
}

function classifyVersion(value) {
  if (!value) return { current: null, kind: "unknown", basis: "unknown" };
  return SEMVER_PATTERN.test(value) ? "semver" : "tag";
}

export async function resolveInstalledVersion(skillDir) {
  // Priority 1: SKILL.md frontmatter
  const frontmatter = await readSkillFrontmatter(skillDir);
  const rawVersion = frontmatter?.version;
  if (rawVersion !== undefined && rawVersion !== null && String(rawVersion).trim() !== "") {
    const current = String(rawVersion).trim();
    const kind = SEMVER_PATTERN.test(current) ? "semver" : "tag";
    return { current, kind, basis: "frontmatter" };
  }

  // Priority 2: package.json / manifest
  const pkgVersion = await readPackageVersion(skillDir);
  if (pkgVersion) {
    const kind = SEMVER_PATTERN.test(pkgVersion) ? "semver" : "tag";
    return { current: pkgVersion, kind, basis: "manifest" };
  }

  // Priority 3: Git tag
  const tag = getGitTag(skillDir);
  if (tag) {
    const kind = SEMVER_PATTERN.test(tag) ? "semver" : "tag";
    return { current: tag, kind, basis: "git_tag" };
  }

  // Priority 4: Git commit SHA
  const commit = getGitCommit(skillDir);
  if (commit) {
    return { current: commit, kind: "commit", basis: "git_commit" };
  }

  // Priority 5: Unknown
  return { current: null, kind: "unknown", basis: "unknown" };
}

// ── resolveSourceMetadata ────────────────────────────────────────────

function emptySource() {
  return {
    type: "unknown",
    url: null,
    repository: null,
    subpath: null,
    ref: null,
    revision: null,
    content_digest: null,
  };
}

function getGitRemoteOrigin(skillDir) {
  try {
    return execSync("git remote get-url origin", {
      cwd: skillDir,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim() || null;
  } catch {
    return null;
  }
}

function getGitRoot(skillDir) {
  try {
    return execSync("git rev-parse --show-toplevel", {
      cwd: skillDir,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim() || null;
  } catch {
    return null;
  }
}

function hasGitDir(skillDir) {
  try {
    execSync("git rev-parse --git-dir", {
      cwd: skillDir,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

async function readPackageRepository(skillDir) {
  try {
    const content = await readFile(join(skillDir, "package.json"), "utf8");
    const pkg = JSON.parse(content);
    const repo = pkg?.repository;
    if (typeof repo === "string" && repo.trim()) return repo.trim();
    if (repo && typeof repo === "object" && typeof repo.url === "string" && repo.url.trim()) {
      return repo.url.trim();
    }
    return null;
  } catch {
    return null;
  }
}

function buildSourceFromUrl(rawUrl) {
  const source = emptySource();
  const ghUrl = normalizeGitHubUrl(rawUrl);
  if (ghUrl) {
    source.type = "github";
    source.url = ghUrl;
    return source;
  }
  const gitUrl = normalizeGitUrl(rawUrl);
  if (gitUrl) {
    source.type = "git";
    source.url = gitUrl;
    return source;
  }
  return source;
}

export async function resolveSourceMetadata(skillDir) {
  // Priority 1: SKILL.md frontmatter source
  const frontmatter = await readSkillFrontmatter(skillDir);

  const rawSource = frontmatter?.source ?? frontmatter?.repository ??
    frontmatter?.metadata?.openclaw?.homepage ?? frontmatter?.metadata?.clawdbot?.homepage ?? null;

  if (rawSource !== null && rawSource !== undefined) {
    if (typeof rawSource === "string" && rawSource.trim()) {
      const source = buildSourceFromUrl(rawSource.trim());
      return source;
    }

    if (rawSource && typeof rawSource === "object" && !Array.isArray(rawSource)) {
      const source = emptySource();
      const rawUrl = rawSource.url ?? rawSource.repository ?? null;
      if (isNonEmptyString(rawUrl)) {
        const ghUrl = normalizeGitHubUrl(rawUrl);
        source.url = isNonEmptyString(rawSource.url) && isNonEmptyString(rawSource.repository)
          ? normalizeGitUrl(rawSource.url)
          : ghUrl || normalizeGitUrl(rawUrl) || rawUrl.trim();
        source.type = ghUrl ? "github" : isGitHubUrl(rawUrl) ? "github" : "git";
      }
      if (isNonEmptyString(rawSource.subpath)) source.subpath = rawSource.subpath.trim();
      if (isNonEmptyString(rawSource.ref)) source.ref = rawSource.ref.trim();
      if (isNonEmptyString(rawSource.revision)) source.revision = rawSource.revision.trim();
      if (isNonEmptyString(rawSource.content_digest)) source.content_digest = rawSource.content_digest.trim();
      if (isNonEmptyString(rawSource.repository)) source.repository = rawSource.repository.trim();
      return source;
    }
  }

  // Priority 2: git remote origin
  const remoteUrl = getGitRemoteOrigin(skillDir);
  if (remoteUrl) {
    const source = buildSourceFromUrl(remoteUrl);
    const gitRoot = getGitRoot(skillDir);
    const canonicalSkillDir = await realpath(skillDir);
    const subpath = gitRoot ? relative(gitRoot, canonicalSkillDir).replaceAll("\\", "/") : "";
    source.repository = source.url;
    source.subpath = subpath || null;
    source.revision = getGitCommit(skillDir);
    return source;
  }

  // Priority 3: package.json repository
  const pkgRepo = await readPackageRepository(skillDir);
  if (pkgRepo) {
    return buildSourceFromUrl(pkgRepo);
  }

  // If has a SKILL.md but no source info -> local
  try {
    await stat(join(skillDir, "SKILL.md"));
    const source = emptySource();
    source.type = "local";
    return source;
  } catch {
    // No SKILL.md -> unknown
    return emptySource();
  }
}

function firstProseParagraph(body) {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const paragraph = [];
  let inFence = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) { inFence = !inFence; continue; }
    if (inFence || /^#{1,6}\s/.test(trimmed) || /^<!--/.test(trimmed)) continue;
    if (!trimmed) { if (paragraph.length > 0) break; continue; }
    if (/^(?:[-*+] |\d+[.)] )/.test(trimmed)) { if (paragraph.length > 0) break; continue; }
    paragraph.push(trimmed);
  }
  return paragraph.join(" ").trim();
}

export async function resolveCapabilitySummary(skillDir) {
  try {
    const content = await readFile(join(skillDir, "SKILL.md"), "utf8");
    const { frontmatter, body } = splitFrontmatter(content);
    const description = isNonEmptyString(frontmatter?.description) ? frontmatter.description.trim() : "";
    const paragraph = firstProseParagraph(body);
    if (!description) return paragraph;
    if (!paragraph || paragraph === description) return description;
    return `${description} ${paragraph}`;
  } catch {
    return "";
  }
}

export async function resolveSkillFacts(skillDir) {
  const directoryInfo = await lstat(skillDir);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
    throw new Error(`Skill path is not a real directory: ${skillDir}`);
  }
  const documentInfo = await lstat(join(skillDir, "SKILL.md"));
  if (!documentInfo.isFile() || documentInfo.isSymbolicLink()) {
    throw new Error(`SKILL.md must be a regular file, not a symbolic link: ${skillDir}`);
  }
  const [version, source, capabilitySummary] = await Promise.all([
    resolveInstalledVersion(skillDir),
    resolveSourceMetadata(skillDir),
    resolveCapabilitySummary(skillDir),
  ]);
  source.content_digest = await computeDirectoryDigest(skillDir);
  return { version, source, capabilitySummary };
}

// ── computeDirectoryDigest ───────────────────────────────────────────

async function collectFiles(dirPath, prefix = "") {
  const entries = await readdir(dirPath, { withFileTypes: true });
  const files = [];

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (IGNORED_ENTRIES.has(entry.name)) continue;
    if (entry.name.startsWith(".") && entry.name.endsWith(".tmp")) continue;

    const fullPath = join(dirPath, entry.name);
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      files.push(...(await collectFiles(fullPath, relativePath)));
    } else if (entry.isFile() && !entry.name.endsWith(".pyc")) {
      files.push({ path: relativePath, fullPath });
    }
  }

  return files;
}

export async function computeDirectoryDigest(dirPath, options = {}) {
  const files = await collectFiles(dirPath);
  const hash = createHash("sha256");

  for (const file of files) {
    hash.update(`FILE:${file.path}\n`);
    const content = await readFile(file.fullPath);
    hash.update(content);
    hash.update("\n");
  }

  return hash.digest("hex");
}
