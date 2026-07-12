import { createHash } from "node:crypto";

const SCOPE_ORDER = new Map([["public", 0], ["agent", 1], ["project", 2]]);
const AGENT_ORDER = new Map([["codex", 0], ["claude", 1], ["antigravity", 2], ["opencode", 3]]);
const UPDATE_PRIORITY = ["update_available", "error", "unknown", "up_to_date", "not_checkable"];

function unique(values) {
  return [...new Set(values.filter((value) => value !== null && value !== undefined && value !== ""))];
}

function sourceHref(source) {
  return source?.url || source?.repository || null;
}

function aggregateUpdate(instances) {
  for (const status of UPDATE_PRIORITY) {
    const matched = instances.find((item) => item.update?.status === status || (status === "error" && item.update?.error));
    if (matched) return { ...matched.update, status };
  }
  return { status: "unknown", latest: null, checked_at: null, error: null };
}

function logicalId(name) {
  return `logical-${createHash("sha256").update(name).digest("hex").slice(0, 16)}`;
}

function createLogicalSkill(name, sourceInstances) {
  const instances = [...sourceInstances].sort((left, right) =>
    (SCOPE_ORDER.get(left.scope?.level) ?? 99) - (SCOPE_ORDER.get(right.scope?.level) ?? 99)
      || left.realPath.localeCompare(right.realPath));
  const primary = instances[0];
  const scopeLevels = unique(instances.map((item) => item.scope?.level))
    .sort((left, right) => (SCOPE_ORDER.get(left) ?? 99) - (SCOPE_ORDER.get(right) ?? 99));
  const agents = unique(instances.flatMap((item) => item.agents || []))
    .sort((left, right) => (AGENT_ORDER.get(left) ?? 99) - (AGENT_ORDER.get(right) ?? 99));
  const versions = unique(instances.map((item) => item.version?.current)).sort();
  const sources = unique(instances.map((item) => sourceHref(item.source))).sort();
  const digests = unique(instances.map((item) => item.source?.content_digest)).sort();
  const agentSkillKinds = unique(instances.map((item) => item.agentSkillKind)).sort();
  return {
    ...primary,
    id: logicalId(name),
    name,
    scopeLevels,
    agents,
    versions,
    sources,
    agentSkillKinds,
    hasSharedAvailability: instances.some((item) => ["public", "project"].includes(item.scope?.level)),
    ownerships: unique(instances.map((item) => item.ownership)).sort(),
    instanceCount: instances.length,
    hasInstanceDifferences: versions.length > 1 || sources.length > 1 || digests.length > 1,
    update: aggregateUpdate(instances),
    instances,
  };
}

export function aggregateSkillInstances(instances) {
  const groups = new Map();
  for (const item of instances) {
    const group = groups.get(item.name) || [];
    group.push(item);
    groups.set(item.name, group);
  }
  return [...groups.entries()].map(([name, group]) => createLogicalSkill(name, group))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function summarizeLogicalSkills(skills, diagnostics = { error: 0, warning: 0, info: 0 }) {
  return {
    totalSkills: skills.length,
    updateAvailable: skills.filter((skill) => skill.update?.status === "update_available").length,
    managedSkills: skills.filter((skill) => skill.ownerships.some((value) => value !== "unmanaged")).length,
    unmanagedSkills: skills.filter((skill) => skill.ownerships.includes("unmanaged")).length,
    byAvailability: {
      shared: skills.filter((skill) => skill.hasSharedAvailability).length,
      codex: skills.filter((skill) => skill.agents.includes("codex")).length,
      claude: skills.filter((skill) => skill.agents.includes("claude")).length,
      antigravity: skills.filter((skill) => skill.agents.includes("antigravity")).length,
      opencode: skills.filter((skill) => skill.agents.includes("opencode")).length,
    },
    diagnostics,
  };
}
