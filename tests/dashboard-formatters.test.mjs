import test from "node:test";
import assert from "node:assert/strict";

import { formatUpdateStatus, getLogicalSourceHref, getSourceHref, getUpdateInstances, matchesInventoryFilters, updateCommand } from "../src/dashboard/formatters.js";

test("transient update errors are not rendered as already current", () => {
  const status = formatUpdateStatus({ status: "up_to_date", error: "network unavailable" });
  assert.equal(status.label, "检查失败");
  assert.equal(status.tone, "danger");
  assert.equal(status.countsAsCurrent, false);
});

test("source links allow only http and https URLs", () => {
  assert.equal(getSourceHref({ url: "https://github.com/o/r" }), "https://github.com/o/r");
  assert.equal(getSourceHref({ repository: "http://git.example/r" }), "http://git.example/r");
  for (const source of [
    { url: "javascript:alert(document.domain)" },
    { url: "data:text/html,unsafe" },
    { repository: "file:///etc/passwd" },
    { url: "not a url" },
  ]) assert.equal(getSourceHref(source), null);
});

test("inventory search covers name capability source install path and project root", () => {
  const skill = {
    name: "impeccable",
    capabilitySummary: "Design quality checks",
    scopeLevels: ["public", "project"],
    agents: ["codex", "claude"],
    instances: [{
      realPath: "/workspace/project/.agents/skills/impeccable",
      scope: { level: "project", project_root: "/workspace/project" },
      source: { url: "https://github.com/example/impeccable" },
    }],
  };
  for (const query of ["impeccable", "quality", "github.com", ".agents/skills", "/workspace/project"]) {
    assert.equal(matchesInventoryFilters(skill, { query, scope: "all", agent: "all" }), true, query);
  }
});

test("inventory filters combine every scope and agent condition", () => {
  const skill = { name: "shared", capabilitySummary: "", scopeLevels: ["public", "project"], projectRoots: ["/project"], agents: ["codex", "claude"], instances: [] };
  assert.equal(matchesInventoryFilters(skill, { query: "", scope: "project", agent: "claude", project: "/project" }), true);
  assert.equal(matchesInventoryFilters(skill, { query: "", scope: "project", agent: "claude", project: "/other" }), false);
  assert.equal(matchesInventoryFilters(skill, { query: "", scope: "agent", agent: "claude" }), false);
  assert.equal(matchesInventoryFilters(skill, { query: "", scope: "project", agent: "opencode" }), false);
});

test("inventory layer filter accepts a derived Hub label without changing raw scope", () => {
  const skill = {
    scopeLevels: ["public"],
    governanceLevels: ["hub", "public"],
    agents: [],
    projectRoots: [],
    instances: [],
  };
  assert.equal(matchesInventoryFilters(skill, { scope: "hub" }), true);
  assert.equal(matchesInventoryFilters(skill, { scope: "public" }), true);
  assert.equal(matchesInventoryFilters(skill, { scope: "agent" }), false);
});

test("inventory type filter distinguishes shared system plugin and private instances", () => {
  const skill = { instances: [{ scope: { level: "public" } }, { scope: { level: "agent" }, agentSkillKind: "plugin" }], scopeLevels: ["public", "agent"], agents: ["codex"], projectRoots: [] };
  assert.equal(matchesInventoryFilters(skill, { kind: "public_shared" }), true);
  assert.equal(matchesInventoryFilters(skill, { kind: "agent" }), true);
  assert.equal(matchesInventoryFilters({ ...skill, instances: [{ scope: { level: "project" } }] }, { kind: "agent" }), false);
});

test("logical update commands target the concrete available instance", () => {
  const command = updateCommand({
    id: "logical-shared",
    instances: [
      { id: "public-shared", update: { status: "up_to_date" } },
      { id: "project-shared", update: { status: "update_available" } },
    ],
  });
  assert.match(command, /--skill project-shared /);
  assert.doesNotMatch(command, /logical-shared/);
});

test("logical source falls back to the unique aggregated source", () => {
  assert.equal(getLogicalSourceHref({ source: {}, sources: ["https://github.com/o/r"] }), "https://github.com/o/r");
});

test("returns every concrete instance with an available update", () => {
  const instances = getUpdateInstances({ instances: [
    { id: "a", update: { status: "update_available" } },
    { id: "b", update: { status: "up_to_date" } },
    { id: "c", update: { status: "update_available" } },
  ] });
  assert.deepEqual(instances.map((item) => item.id), ["a", "c"]);
});
