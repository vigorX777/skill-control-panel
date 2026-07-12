import { createHash } from "node:crypto";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export const SUPPORTED_AGENTS = new Set(["codex", "claude", "antigravity", "opencode"]);

export class PathSafetyError extends Error {
  constructor(message) {
    super(message);
    this.name = "PathSafetyError";
    this.code = "PATH_SAFETY_ERROR";
  }
}

export function assertSafeSkillName(name) {
  if (
    typeof name !== "string" ||
    !name ||
    name.trim() !== name ||
    name === "." ||
    name === ".." ||
    /[\\/\0]/.test(name)
  ) {
    throw new PathSafetyError("Skill name must be a safe basename");
  }
  return name;
}

export function assertSupportedAgent(agent) {
  if (!SUPPORTED_AGENTS.has(agent)) {
    throw new PathSafetyError(`Unsupported agent: ${agent ?? "null"}`);
  }
  return agent;
}

export function resolveInsideRoot(root, ...segments) {
  const resolvedRoot = resolve(root);
  const target = resolve(resolvedRoot, ...segments);
  const rel = relative(resolvedRoot, target);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new PathSafetyError("Target is outside managed root");
  }
  return target;
}

export function stableSkillId(canonicalPath) {
  return `skill-${createHash("sha256").update(resolve(canonicalPath)).digest("hex").slice(0, 16)}`;
}

export function assertCanonicalPathForScope(skill, roots) {
  if (!skill || !skill.install || !skill.scope) throw new PathSafetyError("Skill record is incomplete");
  if (!["managed", "adopted"].includes(skill.ownership)) {
    throw new PathSafetyError(`Skill ownership is not mutable: ${skill.ownership}`);
  }
  assertSafeSkillName(skill.name);
  let root;
  if (skill.scope.level === "public") {
    root = roots.publicRoot;
  } else if (skill.scope.level === "agent") {
    const agent = assertSupportedAgent(skill.scope.agent);
    root = join(roots.agentSkillsDir, agent);
  } else if (skill.scope.level === "project") {
    if (!isAbsolute(skill.scope.project_root || "")) {
      throw new PathSafetyError("Project scope requires an absolute project root");
    }
    root = join(skill.scope.project_root, ".agents", "skills");
  } else {
    throw new PathSafetyError(`Unsupported scope: ${skill.scope.level}`);
  }

  if (skill.id !== stableSkillId(skill.install.canonical_path)) {
    throw new PathSafetyError("Registry skill id does not match its stable canonical-path id");
  }
  return resolve(root);
}
