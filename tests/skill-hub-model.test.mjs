import test from "node:test";
import assert from "node:assert/strict";

import { governanceLevelsForInstance, hubFactForInstance } from "../scripts/lib/skill-hub-model.mjs";

test("derives Hub as a display label while preserving public scope", () => {
  const hub = {
    root: "/workspace/skill-hub",
    entities: new Map([["/workspace/skill-hub/skills/public/example", { kind: "public", path: "skills/public/example" }]]),
  };
  const instance = { realPath: "/workspace/skill-hub/skills/public/example", scope: { level: "public" } };
  assert.deepEqual(governanceLevelsForInstance(instance, hub), ["hub", "public"]);
  assert.deepEqual(hubFactForInstance(instance, hub), {
    root: "/workspace/skill-hub",
    kind: "public",
    path: "skills/public/example",
    entry: null,
  });
});

test("does not label a project entity as Hub", () => {
  const hub = { root: "/workspace/skill-hub", entities: new Map() };
  const instance = { realPath: "/workspace/project/.agents/skills/example", scope: { level: "project" } };
  assert.deepEqual(governanceLevelsForInstance(instance, hub), ["project"]);
  assert.equal(hubFactForInstance(instance, hub), null);
});
