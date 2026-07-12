import test from "node:test";
import assert from "node:assert/strict";

import {
  PathSafetyError,
  assertSafeSkillName,
  assertSupportedAgent,
  resolveInsideRoot,
} from "../scripts/lib/path-safety.mjs";

test("rejects traversal and separator-bearing skill names", () => {
  for (const name of ["../escape", "a/b", "a\\b", ".", "..", "", " spaced ", "nul\0name"]) {
    assert.throws(() => assertSafeSkillName(name), PathSafetyError);
  }
  assert.equal(assertSafeSkillName("safe-skill_1.0"), "safe-skill_1.0");
});

test("accepts only supported agent names", () => {
  for (const agent of ["codex", "claude", "antigravity", "opencode"]) {
    assert.equal(assertSupportedAgent(agent), agent);
  }
  for (const agent of ["../claude", "gemini", "", null]) {
    assert.throws(() => assertSupportedAgent(agent), PathSafetyError);
  }
});

test("resolves targets strictly inside the managed root", () => {
  assert.equal(resolveInsideRoot("/tmp/public", "safe"), "/tmp/public/safe");
  for (const segment of ["../escape", ".", ""]) {
    assert.throws(() => resolveInsideRoot("/tmp/public", segment), PathSafetyError);
  }
});
