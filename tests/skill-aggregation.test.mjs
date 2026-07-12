import test from "node:test";
import assert from "node:assert/strict";

import { aggregateSkillInstances, summarizeLogicalSkills } from "../scripts/lib/skill-aggregation.mjs";

function instance(name, level = "public", path = `/${level}/${name}`, overrides = {}) {
  const agent = level === "agent" ? (overrides.scopeAgent || "claude") : null;
  const projectRoot = level === "project" ? (overrides.projectRoot || "/project") : null;
  const version = overrides.version ?? "1.0.0";
  const sourceUrl = overrides.sourceUrl ?? "https://github.com/example/repo";
  return {
    id: `${level}-${path}`,
    name,
    realPath: path,
    skillMdPath: `${path}/SKILL.md`,
    capabilitySummary: overrides.capabilitySummary || `${name} capability`,
    scope: { level, agent, project_root: projectRoot },
    agents: overrides.agents || (agent ? [agent] : ["codex"]),
    ownership: overrides.ownership || "managed",
    version: { current: version, kind: "semver", basis: "frontmatter" },
    source: { type: "github", url: sourceUrl, repository: sourceUrl, content_digest: overrides.digest || "same" },
    update: { status: overrides.update || "up_to_date", latest: null, checked_at: null, error: null },
    routes: [],
  };
}

test("aggregates exact-name instances across public agent and project scopes", () => {
  const [logical] = aggregateSkillInstances([
    instance("shared", "public", "/public/shared", { agents: ["codex", "claude"] }),
    instance("shared", "agent", "/agent/shared", { scopeAgent: "claude", agents: ["claude"] }),
    instance("shared", "project", "/project/.agents/skills/shared", { projectRoot: "/project", agents: ["codex"] }),
  ]);
  assert.deepEqual(logical.scopeLevels, ["public", "agent", "project"]);
  assert.deepEqual(logical.agents, ["codex", "claude"]);
  assert.equal(logical.instanceCount, 3);
  assert.equal(logical.instances.length, 3);
});

test("does not merge names that differ by case", () => {
  assert.equal(aggregateSkillInstances([instance("Code"), instance("code")]).length, 2);
});

test("marks differences and gives update_available highest priority", () => {
  const [logical] = aggregateSkillInstances([
    instance("same", "public", "/a", { version: "1.0.0", update: "up_to_date", digest: "a" }),
    instance("same", "project", "/b", { version: "2.0.0", update: "update_available", digest: "b" }),
  ]);
  assert.equal(logical.hasInstanceDifferences, true);
  assert.deepEqual(logical.versions, ["1.0.0", "2.0.0"]);
  assert.equal(logical.update.status, "update_available");
  assert.equal(summarizeLogicalSkills([logical], { error: 1, warning: 2, info: 3 }).totalSkills, 1);
});

test("aggregates shared and agent availability independently", () => {
  const shared = instance("same", "public", "/shared");
  shared.agents = [];
  const agent = instance("same", "agent", "/plugin");
  agent.scope.agent = "codex"; agent.agents = ["codex"]; agent.agentSkillKind = "plugin";
  const [logical] = aggregateSkillInstances([shared, agent]);
  assert.deepEqual(logical.agentSkillKinds, ["plugin"]);
  assert.equal(logical.hasSharedAvailability, true);
  assert.deepEqual(logical.agents, ["codex"]);
  assert.deepEqual(summarizeLogicalSkills([logical]).byAvailability, { shared: 1, codex: 1, claude: 0, antigravity: 0, opencode: 0 });
});
