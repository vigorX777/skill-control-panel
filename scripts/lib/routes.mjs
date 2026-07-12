import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readlink, rename, rm, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { PathSafetyError, assertSafeSkillName, assertSupportedAgent, resolveInsideRoot } from "./path-safety.mjs";

export class DirectoryRouteMigrationRequiredError extends Error {
  constructor(agent, path) {
    super(`Agent ${agent} requires explicit directory route migration before private skills can be exposed: ${path}`);
    this.name = "DirectoryRouteMigrationRequiredError";
    this.code = "DIRECTORY_ROUTE_MIGRATION_REQUIRED";
  }
}

export function getAgentRouteRoots(options = {}) {
  return options.agentRouteRoots || {
    shared: join(homedir(), ".agents", "skills"),
    codex: join(homedir(), ".codex", "skills"),
    claude: join(homedir(), ".claude", "skills"),
    opencode: join(homedir(), ".config", "opencode", "skills"),
    antigravity: join(homedir(), ".gemini", "skills"),
  };
}

function compareVersions(left, right) {
  const parse = (value) => String(value ?? "").match(/^(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number);
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index] - b[index];
  return 0;
}

export function validateRouteMigration(agent, agentVersions = {}) {
  assertSupportedAgent(agent);
  const comparison = compareVersions(agentVersions.claude, "2.1.203");
  if (agent === "claude" && (comparison === null || comparison < 0)) {
    throw new Error("Claude Code version could not be detected or is older than 2.1.203");
  }
}

function validatePersistedRoutes(skill, routeRoots) {
  const name = assertSafeSkillName(skill.name);
  const allowed = new Set(
    Object.values(routeRoots)
      .filter(Boolean)
      .map((root) => resolveInsideRoot(root, name)),
  );
  for (const route of skill.install.routes || []) {
    if (!allowed.has(resolve(route))) {
      throw new PathSafetyError(`Persisted route is outside managed agent roots: ${route}`);
    }
  }
}

function resolvedLinkTarget(path, target) {
  return resolve(dirname(path), target);
}

async function routeResolvesTo(path, expectedTarget) {
  const expected = resolve(expectedTarget);
  let current = path;
  const seen = new Set();
  for (let depth = 0; depth < 16; depth += 1) {
    if (seen.has(current)) return false;
    seen.add(current);
    const stat = await lstat(current).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
    if (!stat?.isSymbolicLink()) return false;
    current = resolvedLinkTarget(current, await readlink(current));
    if (current === expected) return true;
  }
  return false;
}

export async function planRoutesForSkill(skill, routeRoots, context = {}) {
  validatePersistedRoutes(skill, routeRoots);
  const desired = [];
  if (skill.scope.level === "agent") {
    const agent = assertSupportedAgent(skill.scope.agent);
    const routeRoot = routeRoots[agent];
    if (!routeRoot) throw new Error(`Route root is not configured for ${agent}`);
    const rootStat = await lstat(routeRoot).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (rootStat?.isSymbolicLink()) throw new DirectoryRouteMigrationRequiredError(agent, routeRoot);
    if (rootStat && !rootStat.isDirectory()) throw new Error(`Route root is not a directory: ${routeRoot}`);
    if (!rootStat) await mkdir(routeRoot, { recursive: true });
    desired.push(resolveInsideRoot(routeRoot, assertSafeSkillName(skill.name)));
  } else if (skill.scope.level === "public") {
    for (const routeRoot of Object.values(routeRoots).filter(Boolean)) {
      const rootStat = await lstat(routeRoot).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (rootStat?.isDirectory() && !rootStat.isSymbolicLink()) {
        desired.push(resolveInsideRoot(routeRoot, assertSafeSkillName(skill.name)));
      }
    }
  }

  const existing = skill.install.routes || [];
  const operations = [];
  const previousTarget = context.previousCanonicalPath || skill.install.canonical_path;
  for (const path of [...existing].reverse()) {
    if (!desired.includes(path)) operations.push({ type: "remove", path, expectedTarget: previousTarget });
  }
  for (const path of desired) {
    if (!existing.includes(path)) {
      operations.push({ type: "create", path, target: skill.install.canonical_path });
      continue;
    }
    const current = await lstat(path).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
    if (!current) {
      operations.push({ type: "create", path, target: skill.install.canonical_path });
      continue;
    }
    if (!current.isSymbolicLink()) throw new Error(`Route path is not a symbolic link: ${path}`);
    const currentTarget = resolvedLinkTarget(path, await readlink(path));
    if (currentTarget !== resolve(skill.install.canonical_path)) {
      if (currentTarget !== resolve(previousTarget) && !(await routeResolvesTo(path, previousTarget))) {
        throw new Error(`Route path already exists with a different target: ${path}`);
      }
      operations.push({ type: "replace", path, target: skill.install.canonical_path, expectedTarget: previousTarget });
    }
  }
  return { operations, routes: [...new Set(desired)].sort() };
}

export function planRouteRemoval(skill, routeRoots = getAgentRouteRoots()) {
  validatePersistedRoutes(skill, routeRoots);
  return {
    operations: [...(skill.install.routes || [])].reverse().map((path) => ({
      type: "remove", path, expectedTarget: skill.install.canonical_path,
    })),
    routes: [],
  };
}

export async function applyRoutePlan(plan) {
  const rollbacks = [];
  const cleanups = [];
  try {
    for (const operation of plan.operations) {
      if (operation.type === "create") {
        await mkdir(dirname(operation.path), { recursive: true });
        const current = await lstat(operation.path).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
        if (current) {
          const target = current.isSymbolicLink()
            ? resolvedLinkTarget(operation.path, await readlink(operation.path))
            : null;
          if (!current.isSymbolicLink() || target !== resolve(operation.target)) {
            throw new Error(`Route path already exists with a different target: ${operation.path}`);
          }
          continue;
        }
        const temp = `${operation.path}.${randomUUID()}.tmp`;
        await symlink(operation.target, temp);
        await rename(temp, operation.path);
        rollbacks.push(() => rm(operation.path, { force: true }));
        cleanups.push(() => rm(temp, { force: true }));
      } else if (operation.type === "remove") {
        const current = await lstat(operation.path).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
        if (!current) continue;
        if (!current.isSymbolicLink()) throw new Error(`Refusing to remove a non-symlink route: ${operation.path}`);
        const target = resolvedLinkTarget(operation.path, await readlink(operation.path));
        if (target !== resolve(operation.expectedTarget) && !(await routeResolvesTo(operation.path, operation.expectedTarget))) {
          throw new Error(`Refusing to remove a route with a different target: ${operation.path}`);
        }
        const backup = `${operation.path}.${randomUUID()}.route-backup`;
        await rename(operation.path, backup);
        rollbacks.push(() => rename(backup, operation.path));
        cleanups.push(() => rm(backup, { force: true }));
      } else if (operation.type === "replace") {
        const current = await lstat(operation.path).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
        if (!current?.isSymbolicLink()) throw new Error(`Refusing to replace a non-symlink route: ${operation.path}`);
        const currentTarget = resolvedLinkTarget(operation.path, await readlink(operation.path));
        if (currentTarget !== resolve(operation.expectedTarget) && !(await routeResolvesTo(operation.path, operation.expectedTarget))) {
          throw new Error(`Refusing to replace a route with a different target: ${operation.path}`);
        }
        const backup = `${operation.path}.${randomUUID()}.route-backup`;
        const temp = `${operation.path}.${randomUUID()}.tmp`;
        await rename(operation.path, backup);
        try {
          await symlink(operation.target, temp);
          await rename(temp, operation.path);
        } catch (error) {
          await rm(temp, { force: true });
          await rename(backup, operation.path);
          throw error;
        }
        rollbacks.push(async () => {
          await rm(operation.path, { force: true });
          await rename(backup, operation.path);
        });
        cleanups.push(() => rm(backup, { force: true }));
        cleanups.push(() => rm(temp, { force: true }));
      }
    }
  } catch (error) {
    for (const rollback of rollbacks.reverse()) await rollback().catch(() => {});
    throw error;
  }
  return {
    routes: plan.routes,
    async rollback() {
      for (const rollback of rollbacks.reverse()) await rollback();
    },
    async cleanup() {
      for (const cleanup of cleanups) await cleanup();
    },
  };
}

export async function migrateDirectoryRoute({
  agent,
  routeRoot,
  backupRoot,
  confirmed,
  agentVersions = {},
  skills = [],
}) {
  if (!confirmed) throw new Error("Directory route migration must be confirmed");
  validateRouteMigration(agent, agentVersions);
  const current = await lstat(routeRoot);
  if (!current.isSymbolicLink()) throw new Error(`Route root is not a directory symlink: ${routeRoot}`);
  const sourceRoot = resolvedLinkTarget(routeRoot, await readlink(routeRoot));
  const sourceEntries = await readdir(sourceRoot, { withFileTypes: true });
  await mkdir(backupRoot, { recursive: true });
  const backupPath = join(backupRoot, `${agent}-${basename(routeRoot)}-${Date.now()}-${randomUUID()}`);
  await rename(routeRoot, backupPath);
  let migrated = false;
  try {
    await mkdir(routeRoot, { recursive: true });
    for (const entry of sourceEntries) {
      if (entry.name.startsWith(".")) continue;
      await symlink(join(sourceRoot, entry.name), resolveInsideRoot(routeRoot, entry.name));
    }
    for (const skill of skills) {
      const name = assertSafeSkillName(skill.name);
      const route = resolveInsideRoot(routeRoot, name);
      if (!(await lstat(route).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error)))) await symlink(skill.install.canonical_path, route);
    }
    migrated = true;
  } finally {
    if (!migrated) {
      await rm(routeRoot, { recursive: true, force: true });
      await rename(backupPath, routeRoot);
    }
  }
  return {
    backupPath,
    async rollback() {
      await rm(routeRoot, { recursive: true, force: true });
      await rename(backupPath, routeRoot);
    },
  };
}
