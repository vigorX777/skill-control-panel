import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";

import { parse, stringify } from "yaml";

import { REGISTRY_PATH } from "./constants.mjs";
import { withFileLock } from "./file-lock.mjs";

const LIFECYCLES = new Set(["active", "removed"]);
const OWNERSHIPS = new Set(["managed", "adopted", "plugin", "system", "unmanaged"]);
const SCOPE_LEVELS = new Set(["public", "agent", "project"]);
const SOURCE_TYPES = new Set(["github", "git", "plugin", "local", "unknown"]);
const VERSION_KINDS = new Set(["semver", "tag", "commit", "unknown"]);
const VERSION_BASES = new Set([
  "frontmatter",
  "manifest",
  "git_tag",
  "git_commit",
  "directory",
  "unknown",
]);
const UPDATE_STATUSES = new Set([
  "up_to_date",
  "update_available",
  "not_checkable",
  "unknown",
  "error",
]);
const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

const EMPTY_REGISTRY = Object.freeze({
  schemaVersion: 1,
  updatedAt: null,
  skills: Object.freeze([]),
});

export class RegistryValidationError extends Error {
  constructor(message, issues = []) {
    super(message);
    this.name = "RegistryValidationError";
    this.issues = issues;
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isNullableString(value) {
  return value === null || typeof value === "string";
}

function isNullableTrimmedString(value) {
  return value === null || (isNonEmptyString(value) && value === value.trim());
}

function isNullableTimestamp(value) {
  return (
    value === null ||
    (isNonEmptyString(value) &&
      ISO_TIMESTAMP_PATTERN.test(value) &&
      !Number.isNaN(Date.parse(value)))
  );
}

function validateExactKeys(value, keys, path, issues) {
  if (!isObject(value)) {
    issues.push(`${path} must be an object`);
    return false;
  }

  for (const key of keys) {
    if (!hasOwn(value, key)) {
      issues.push(`${path}.${key} is required`);
    }
  }
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) {
      issues.push(`${path}.${key} is not allowed`);
    }
  }

  return true;
}

function validateSkill(skill, index, issues) {
  const path = `skills[${index}]`;
  const required = [
    "id",
    "name",
    "lifecycle",
    "ownership",
    "capability_summary",
    "scope",
    "install",
    "source",
    "version",
    "update",
    "installed_at",
    "updated_at",
  ];

  if (!validateExactKeys(skill, required, path, issues)) {
    return;
  }

  if (!isNonEmptyString(skill.id)) issues.push(`${path}.id must be a non-empty string`);
  if (!isNonEmptyString(skill.name)) issues.push(`${path}.name must be a non-empty string`);
  if (!LIFECYCLES.has(skill.lifecycle)) issues.push(`${path}.lifecycle is invalid`);
  if (!OWNERSHIPS.has(skill.ownership)) issues.push(`${path}.ownership is invalid`);
  if (typeof skill.capability_summary !== "string") {
    issues.push(`${path}.capability_summary must be a string`);
  }

  if (
    validateExactKeys(
      skill.scope,
      ["level", "agent", "project_root"],
      `${path}.scope`,
      issues,
    )
  ) {
    if (!SCOPE_LEVELS.has(skill.scope.level)) issues.push(`${path}.scope.level is invalid`);
    if (!isNullableString(skill.scope.agent)) issues.push(`${path}.scope.agent must be a string or null`);
    if (!isNullableString(skill.scope.project_root)) {
      issues.push(`${path}.scope.project_root must be a string or null`);
    }
    if (skill.scope.level === "public" && (skill.scope.agent !== null || skill.scope.project_root !== null)) {
      issues.push(`${path}.scope public details must be null`);
    }
    if (skill.scope.level === "agent" && (!isNonEmptyString(skill.scope.agent) || skill.scope.project_root !== null)) {
      issues.push(`${path}.scope agent requires agent and no project_root`);
    }
    if (
      skill.scope.level === "project" &&
      (!isNonEmptyString(skill.scope.project_root) || !isAbsolute(skill.scope.project_root) || skill.scope.agent !== null)
    ) {
      issues.push(`${path}.scope project requires an absolute project_root and no agent`);
    }
  }

  if (
    validateExactKeys(
      skill.install,
      ["canonical_path", "skill_md_path", "routes"],
      `${path}.install`,
      issues,
    )
  ) {
    for (const key of ["canonical_path", "skill_md_path"]) {
      if (!isNonEmptyString(skill.install[key]) || !isAbsolute(skill.install[key])) {
        issues.push(`${path}.install.${key} must be an absolute path`);
      }
    }
    if (!Array.isArray(skill.install.routes)) {
      issues.push(`${path}.install.routes must be an array`);
    } else {
      const routeSet = new Set();
      for (const [routeIndex, route] of skill.install.routes.entries()) {
        if (!isNonEmptyString(route) || !isAbsolute(route)) {
          issues.push(`${path}.install.routes[${routeIndex}] must be an absolute path`);
        } else if (routeSet.has(route)) {
          issues.push(`${path}.install.routes[${routeIndex}] must be unique`);
        }
        routeSet.add(route);
      }
    }
  }

  if (
    validateExactKeys(
      skill.source,
      ["type", "url", "repository", "subpath", "ref", "revision", "content_digest"],
      `${path}.source`,
      issues,
    )
  ) {
    if (!SOURCE_TYPES.has(skill.source.type)) issues.push(`${path}.source.type is invalid`);
    for (const key of ["url", "repository", "subpath", "ref", "revision", "content_digest"]) {
      if (!isNullableString(skill.source[key])) {
        issues.push(`${path}.source.${key} must be a string or null`);
      }
    }
  }

  if (
    validateExactKeys(
      skill.version,
      ["current", "kind", "basis"],
      `${path}.version`,
      issues,
    )
  ) {
    if (!isNullableTrimmedString(skill.version.current)) {
      issues.push(`${path}.version.current must be a non-empty trimmed string or null`);
    }
    if (!VERSION_KINDS.has(skill.version.kind)) issues.push(`${path}.version.kind is invalid`);
    if (!VERSION_BASES.has(skill.version.basis)) issues.push(`${path}.version.basis is invalid`);
    if (
      skill.version.current === null &&
      (skill.version.kind !== "unknown" || skill.version.basis !== "unknown")
    ) {
      issues.push(`${path}.version missing value must use unknown kind and basis`);
    }
  }

  if (
    validateExactKeys(
      skill.update,
      ["status", "latest", "checked_at", "error"],
      `${path}.update`,
      issues,
    )
  ) {
    if (!UPDATE_STATUSES.has(skill.update.status)) issues.push(`${path}.update.status is invalid`);
    if (!isNullableString(skill.update.latest)) issues.push(`${path}.update.latest must be a string or null`);
    if (!isNullableTimestamp(skill.update.checked_at)) {
      issues.push(`${path}.update.checked_at must be an ISO timestamp or null`);
    }
    if (!isNullableString(skill.update.error)) issues.push(`${path}.update.error must be a string or null`);
  }

  if (!isNullableTimestamp(skill.installed_at)) {
    issues.push(`${path}.installed_at must be an ISO timestamp or null`);
  }
  if (!isNullableTimestamp(skill.updated_at)) {
    issues.push(`${path}.updated_at must be an ISO timestamp or null`);
  }
}

function validateRegistry(registry) {
  const issues = [];

  if (!isObject(registry)) {
    throw new RegistryValidationError("Registry must be an object", ["registry must be an object"]);
  }
  validateExactKeys(registry, ["schemaVersion", "updatedAt", "skills"], "registry", issues);
  if (registry.schemaVersion !== 1) issues.push("schemaVersion must be 1");
  if (!hasOwn(registry, "updatedAt") || !isNullableTimestamp(registry.updatedAt)) {
    issues.push("updatedAt must be an ISO timestamp or null");
  }
  if (!Array.isArray(registry.skills)) {
    issues.push("skills must be an array");
  } else {
    registry.skills.forEach((skill, index) => validateSkill(skill, index, issues));
    const ids = registry.skills.map((skill) => skill?.id).filter(isNonEmptyString);
    if (new Set(ids).size !== ids.length) issues.push("skill ids must be unique");
  }

  if (issues.length > 0) {
    throw new RegistryValidationError(`Invalid registry: ${issues.join("; ")}`, issues);
  }

  return registry;
}

function resolveNow(now) {
  const value = typeof now === "function" ? now() : now;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  return new Date().toISOString();
}

export async function readRegistry(options = {}) {
  const registryPath = options.registryPath || REGISTRY_PATH;

  let source;
  try {
    source = await readFile(registryPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return {
        schemaVersion: EMPTY_REGISTRY.schemaVersion,
        updatedAt: EMPTY_REGISTRY.updatedAt,
        skills: [],
      };
    }
    throw error;
  }

  try {
    return validateRegistry(parse(source));
  } catch (error) {
    if (error instanceof RegistryValidationError) throw error;
    throw new RegistryValidationError(`Invalid registry YAML: ${error.message}`);
  }
}

export async function writeRegistryUnlocked(registry, options = {}) {
  const registryPath = options.registryPath || REGISTRY_PATH;
  validateRegistry(registry);
  await mkdir(dirname(registryPath), { recursive: true });

  const tempPath = join(
    dirname(registryPath),
    `.${basename(registryPath)}.${process.pid}.${randomUUID()}.tmp`,
  );

  try {
    await writeFile(tempPath, stringify(registry), { encoding: "utf8", mode: 0o600 });
    await rename(tempPath, registryPath);
  } finally {
    await rm(tempPath, { force: true });
  }

  return registry;
}

export async function withRegistryLock(options = {}, callback) {
  const registryPath = options.registryPath || REGISTRY_PATH;
  return withFileLock(`${registryPath}.lock`, options, callback);
}

export async function writeRegistry(registry, options = {}) {
  return withRegistryLock(options, () => writeRegistryUnlocked(registry, options));
}

export async function upsertRegistrySkill(skill, options = {}) {
  return withRegistryLock(options, async () => {
    const registry = await readRegistry(options);
    const skillIndex = registry.skills.findIndex((item) => item.id === skill.id);
    const skills = [...registry.skills];
    if (skillIndex === -1) skills.push(skill);
    else skills[skillIndex] = skill;
    const updatedRegistry = { ...registry, updatedAt: resolveNow(options.now), skills };
    await writeRegistryUnlocked(updatedRegistry, options);
    return updatedRegistry;
  });
}

export async function removeRegistrySkill(id, options = {}) {
  return withRegistryLock(options, async () => {
    const registry = await readRegistry(options);
    const updatedRegistry = {
      ...registry,
      updatedAt: resolveNow(options.now),
      skills: registry.skills.filter((skill) => skill.id !== id),
    };
    await writeRegistryUnlocked(updatedRegistry, options);
    return updatedRegistry;
  });
}
