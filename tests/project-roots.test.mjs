import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addProjectRoot, listProjectRoots, removeProjectRoot, updateProjectRoot } from "../scripts/lib/project-roots.mjs";

test("adds unicode project roots idempotently and removes only configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "project-roots-"));
  try {
    const configPath = join(root, "project-roots.yaml");
    const path = join(root, "🚩 项目");
    const first = await addProjectRoot({ path, label: "项目", confirmed: true }, { configPath, historyPath: join(root, "history.jsonl"), now: "2026-07-11T00:00:00.000Z" });
    const second = await addProjectRoot({ path, label: "重复", confirmed: true }, { configPath, historyPath: join(root, "history.jsonl") });
    assert.equal(first.root.id, second.root.id);
    assert.equal((await listProjectRoots({ configPath })).roots.length, 1);
    await removeProjectRoot({ id: first.root.id, confirmed: true }, { configPath, historyPath: join(root, "history.jsonl") });
    assert.equal((await listProjectRoots({ configPath })).roots.length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("rejects malformed duplicate or noncanonical project root records", async () => {
  const root = await mkdtemp(join(tmpdir(), "project-roots-invalid-"));
  try {
    const configPath = join(root, "project-roots.yaml");
    await writeFile(configPath, `schemaVersion: 1\nupdatedAt: null\nroots:\n  - id: wrong\n    path: /tmp/example/..\n    label: Example\n    addedAt: 2026-07-11T00:00:00.000Z\n`);
    await assert.rejects(() => listProjectRoots({ configPath }), /schema|canonical|id/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects blank labels before writing an invalid configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "project-roots-label-"));
  try {
    const configPath = join(root, "project-roots.yaml");
    await assert.rejects(() => addProjectRoot({ path: root, label: "   ", confirmed: true }, { configPath, historyPath: join(root, "history.jsonl") }), /label/i);
    assert.equal((await listProjectRoots({ configPath })).roots.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("normalizes legacy roots and persists an explicit direct child scan mode", async () => {
  const root = await mkdtemp(join(tmpdir(), "project-roots-mode-"));
  try {
    const configPath = join(root, "project-roots.yaml");
    const project = join(root, "Skill试用");
    const addedAt = "2026-07-11T00:00:00.000Z";
    const first = await addProjectRoot({ path: project, label: "Skill试用", confirmed: true }, { configPath, historyPath: join(root, "history.jsonl"), now: addedAt });
    assert.equal((await listProjectRoots({ configPath })).roots[0].scanMode, "standard");

    const updated = await updateProjectRoot({ id: first.root.id, scanMode: "direct-skill-folders", confirmed: true }, { configPath, historyPath: join(root, "history.jsonl"), now: "2026-07-11T01:00:00.000Z" });
    assert.equal(updated.changed, true);
    assert.equal(updated.root.scanMode, "direct-skill-folders");
    assert.equal((await listProjectRoots({ configPath })).roots[0].scanMode, "direct-skill-folders");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
