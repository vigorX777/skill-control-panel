import test from "node:test";
import assert from "node:assert/strict";
import { CHAT_FUNCTIONS, getChatFunction } from "../scripts/lib/chat-functions.mjs";
import { parseSkillctlArgs } from "../scripts/lib/cli-args.mjs";

test("exports every stable chat function name exactly once", () => {
  const names = CHAT_FUNCTIONS.map((item) => item.name);
  assert.equal(new Set(names).size, 17);
  for (const name of ["skill-install", "skill-translation-sync", "project-path-add", "project-path-update", "agent-route-migrate"]) {
    assert.equal(getChatFunction(name).name, name);
  }
  for (const item of CHAT_FUNCTIONS) {
    assert.ok(item.description.length > item.title.length);
    assert.ok(Array.isArray(item.parameters));
    assert.match(item.example, new RegExp(item.name));
    assert.match(item.cliExample, new RegExp(item.name));
  }
});

test("parses stable project and translation function commands", () => {
  assert.equal(parseSkillctlArgs(["project-path-add", "--path", "/tmp/p", "--confirmed"]).command, "project-path-add");
  assert.equal(parseSkillctlArgs(["project-path-update", "--path", "/tmp/p", "--scan-mode", "direct-skill-folders", "--confirmed"]).command, "project-path-update");
  assert.equal(parseSkillctlArgs(["skill-translation-sync", "--input", "/tmp/t.json", "--confirmed"]).command, "skill-translation-sync");
  assert.equal(parseSkillctlArgs(["reconcile", "--skill", "skill-123", "--confirmed"]).options.skill, "skill-123");
});

test("describes the agent translation closure for scanned Skills", () => {
  assert.match(getChatFunction("skill-inventory-scan").description, /批量补齐/);
  assert.match(getChatFunction("skill-install").description, /同一次对话/);
  assert.match(getChatFunction("skill-update").description, /同一次对话/);
  assert.match(getChatFunction("skill-translation-sync").description, /当前扫描/);
});
