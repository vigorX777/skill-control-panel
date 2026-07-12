import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

import { computeDirectoryDigest } from "./source.mjs";
import { resolveInsideRoot } from "./path-safety.mjs";

const execFileAsync = promisify(execFile);

// ── helpers ──────────────────────────────────────────────────────────

const CHECKABLE_SOURCE_TYPES = new Set(["github", "git"]);

function resolveNow(now) {
  const value = typeof now === "function" ? now() : now;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  return new Date().toISOString();
}

async function defaultRunGit(args, options = {}) {
  const { stdout } = await execFileAsync("git", args, {
    encoding: "utf8",
    timeout: 60_000,
    ...options,
  });
  return stdout;
}

function getCloneUrl(skill) {
  const source = skill.source;
  if (source.repository) return source.repository;
  if (source.url) return source.url;
  return null;
}

function assertSafeCloneUrl(value) {
  if (
    typeof value !== "string" ||
    value.startsWith("-") ||
    !(/^(?:https?|ssh|git):\/\//i.test(value) || /^git@[A-Za-z0-9._-]+:[^\s]+$/.test(value))
  ) {
    throw new Error("Git source URL uses an unsupported or unsafe scheme");
  }
  return value;
}

function getRef(skill) {
  return skill.source?.ref || "HEAD";
}

export function mergeUpdateResult(previous, checked) {
  if (checked.status === "error" && ["up_to_date", "update_available"].includes(previous?.status)) {
    return {
      status: previous.status,
      latest: previous.latest,
      checked_at: checked.checked_at,
      error: checked.error,
    };
  }
  return checked;
}

// ── checkSkillUpdate ─────────────────────────────────────────────────

export async function checkSkillUpdate(skill, options = {}) {
  const now = resolveNow(options.now);
  const sourceType = skill.source?.type;

  if (!CHECKABLE_SOURCE_TYPES.has(sourceType)) {
    return {
      status: "not_checkable",
      latest: null,
      checked_at: now,
      error: null,
    };
  }

  const cloneUrl = getCloneUrl(skill);
  if (!cloneUrl) {
    return {
      status: "not_checkable",
      latest: null,
      checked_at: now,
      error: null,
    };
  }

  const runGit = options.runGit || defaultRunGit;
  const tempRoot = options.tempRoot || tmpdir();
  const checkDir = join(tempRoot, `scp-update-${randomUUID()}`);

  try {
    assertSafeCloneUrl(cloneUrl);
    const compareDir = skill.source?.subpath
      ? resolveInsideRoot(checkDir, skill.source.subpath)
      : checkDir;
    await mkdir(checkDir, { recursive: true });

    const ref = getRef(skill);

    // Clone the remote repository (shallow)
    const cloneArgs = [
      "clone",
      "--depth", "1",
      "--single-branch",
    ];
    if (ref !== "HEAD") {
      cloneArgs.push("--branch", ref);
    }
    cloneArgs.push("--", cloneUrl, checkDir);

    await runGit(cloneArgs);
    const remoteRevision = (await runGit(["rev-parse", "HEAD"], { cwd: checkDir })).trim();

    const remoteDigest = await computeDirectoryDigest(compareDir);

    // The Registry digest is historical metadata. Always hash the current files.
    const localDigest = await computeDirectoryDigest(skill.install.canonical_path);

    if (remoteDigest === localDigest) {
      return {
        status: "up_to_date",
        latest: null,
        checked_at: now,
        error: null,
      };
    }

    return {
      status: "update_available",
      latest: remoteRevision || remoteDigest,
      checked_at: now,
      error: null,
    };
  } catch (error) {
    return {
      status: "error",
      latest: null,
      checked_at: now,
      error: error.message,
    };
  } finally {
    try {
      await rm(checkDir, { recursive: true, force: true });
    } catch {
      // Best effort cleanup
    }
  }
}

// ── checkRegistryUpdates ─────────────────────────────────────────────

export async function checkRegistryUpdates(registry, options = {}) {
  const now = resolveNow(options.now);
  const events = [];
  const updatedSkills = [];

  for (const skill of registry.skills) {
    if (skill.lifecycle !== "active") {
      updatedSkills.push(skill);
      continue;
    }

    const checkedResult = await checkSkillUpdate(skill, { ...options, now });
    const updateResult = mergeUpdateResult(skill.update, checkedResult);

    updatedSkills.push({
      ...skill,
      update: updateResult,
    });

    events.push({
      skillId: skill.id,
      skillName: skill.name,
      action: "update_check",
      before: skill.update ? { ...skill.update } : null,
      after: updateResult,
      result: updateResult.status,
      timestamp: now,
    });
  }

  return {
    registry: {
      ...registry,
      updatedAt: now,
      skills: updatedSkills,
    },
    events,
  };
}
