import test from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { reconcileCurrentFacts } from "../scripts/lib/reconcile.mjs";
import { readHistory } from "../scripts/lib/history.mjs";
import { readRegistry, writeRegistry } from "../scripts/lib/registry.mjs";

test("reconciles source and version without moving canonical paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "reconcile-test-"));
  try {
    const skillPath = join(root, "skill");
    const registryPath = join(root, "registry.yaml");
    const historyPath = join(root, "history.jsonl");
    await mkdir(skillPath);
    await writeFile(join(skillPath, "SKILL.md"), "---\nname: reconcile-skill\ndescription: Current capability\n---\nbody");
    await writeFile(join(skillPath, "package.json"), JSON.stringify({ version: "4.0.0" }));
    execSync("git init && git config user.email test@example.com && git config user.name Test && git add . && git commit -m init && git remote add origin https://github.com/owner/reconcile.git", { cwd: skillPath, stdio: "ignore", shell: true });
    const unknownSource = { type: "unknown", url: null, repository: null, subpath: null, ref: null, revision: null, content_digest: null };
    await writeRegistry({
      schemaVersion: 1, updatedAt: null, skills: [{
        id: "stable-id", name: "reconcile-skill", lifecycle: "active", ownership: "adopted",
        capability_summary: "Old", scope: { level: "public", agent: null, project_root: null },
        install: { canonical_path: skillPath, skill_md_path: join(skillPath, "SKILL.md"), routes: [] },
        source: unknownSource, version: { current: null, kind: "unknown", basis: "unknown" },
        update: { status: "up_to_date", latest: "old", checked_at: "2026-07-09T00:00:00.000Z", error: null },
        installed_at: null, updated_at: null,
      }],
    }, { registryPath });

    const result = await reconcileCurrentFacts({ registryPath, historyPath, now: "2026-07-10T00:00:00.000Z" });
    assert.equal(result.ok, true);
    const registry = await readRegistry({ registryPath });
    assert.equal(registry.skills[0].id, "stable-id");
    assert.equal(registry.skills[0].install.canonical_path, skillPath);
    assert.equal(registry.skills[0].version.current, "4.0.0");
    assert.equal(registry.skills[0].source.url, "https://github.com/owner/reconcile");
    assert.equal(registry.skills[0].update.status, "unknown");
    assert.equal(registry.skills[0].update.latest, null);
    assert.equal((await readHistory({}, { historyPath })).items[0].action, "source_change");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preserves facts and records validation_failed when the canonical directory is missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "reconcile-missing-"));
  try {
    const registryPath = join(root, "registry.yaml");
    const historyPath = join(root, "history.jsonl");
    const missing = join(root, "missing-skill");
    const originalSource = { type: "github", url: "https://github.com/o/r", repository: "https://github.com/o/r", subpath: null, ref: null, revision: "abc", content_digest: "digest" };
    await writeRegistry({
      schemaVersion: 1, updatedAt: null, skills: [{
        id: "missing-id", name: "missing-skill", lifecycle: "active", ownership: "adopted",
        capability_summary: "Preserve me", scope: { level: "public", agent: null, project_root: null },
        install: { canonical_path: missing, skill_md_path: join(missing, "SKILL.md"), routes: [] },
        source: originalSource, version: { current: "1.0.0", kind: "semver", basis: "frontmatter" },
        update: { status: "up_to_date", latest: null, checked_at: "2026-07-09T00:00:00.000Z", error: null },
        installed_at: null, updated_at: null,
      }],
    }, { registryPath });

    const result = await reconcileCurrentFacts({ registryPath, historyPath, now: "2026-07-10T00:00:00.000Z" });
    assert.equal(result.ok, true);
    const [skill] = (await readRegistry({ registryPath })).skills;
    assert.deepEqual(skill.source, originalSource);
    assert.equal(skill.version.current, "1.0.0");
    const [event] = (await readHistory({}, { historyPath })).items;
    assert.equal(event.action, "validation_failed");
    assert.equal(event.result, "error");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not rewrite Registry timestamps when current facts are unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "reconcile-unchanged-"));
  try {
    const skillPath = join(root, "skill");
    const registryPath = join(root, "registry.yaml");
    const historyPath = join(root, "history.jsonl");
    await mkdir(skillPath);
    await writeFile(join(skillPath, "SKILL.md"), "---\nname: unchanged\ndescription: Current\n---\nbody");
    const { resolveSkillFacts } = await import("../scripts/lib/source.mjs");
    const facts = await resolveSkillFacts(skillPath);
    const originalUpdatedAt = "2026-07-09T00:00:00.000Z";
    await writeRegistry({
      schemaVersion: 1, updatedAt: originalUpdatedAt, skills: [{
        id: "unchanged-id", name: "unchanged", lifecycle: "active", ownership: "managed",
        capability_summary: facts.capabilitySummary, scope: { level: "public", agent: null, project_root: null },
        install: { canonical_path: skillPath, skill_md_path: join(skillPath, "SKILL.md"), routes: [] },
        source: facts.source, version: facts.version,
        update: { status: "not_checkable", latest: null, checked_at: null, error: null },
        installed_at: originalUpdatedAt, updated_at: originalUpdatedAt,
      }],
    }, { registryPath });

    const result = await reconcileCurrentFacts({ registryPath, historyPath, now: "2026-07-11T00:00:00.000Z" });
    const registry = await readRegistry({ registryPath });
    assert.deepEqual({ changed: result.changed, events: result.events }, { changed: 0, events: 0 });
    assert.equal(registry.updatedAt, originalUpdatedAt);
    assert.equal(registry.skills[0].updated_at, originalUpdatedAt);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("normalizes unchanged local unknown update status to not_checkable", async () => {
  const root = await mkdtemp(join(tmpdir(), "reconcile-local-status-"));
  try {
    const skillPath = join(root, "skill");
    const registryPath = join(root, "registry.yaml");
    const historyPath = join(root, "history.jsonl");
    await mkdir(skillPath);
    await writeFile(join(skillPath, "SKILL.md"), "---\nname: local-skill\ndescription: Local capability\n---\nbody");
    const { resolveSkillFacts } = await import("../scripts/lib/source.mjs");
    const facts = await resolveSkillFacts(skillPath);
    await writeRegistry({
      schemaVersion: 1, updatedAt: null, skills: [{
        id: "local-id", name: "local-skill", lifecycle: "active", ownership: "managed",
        capability_summary: facts.capabilitySummary, scope: { level: "public", agent: null, project_root: null },
        install: { canonical_path: skillPath, skill_md_path: join(skillPath, "SKILL.md"), routes: [] },
        source: facts.source, version: facts.version,
        update: { status: "unknown", latest: null, checked_at: null, error: null },
        installed_at: null, updated_at: null,
      }],
    }, { registryPath });

    const result = await reconcileCurrentFacts({ registryPath, historyPath, now: "2026-07-11T00:00:00.000Z" });
    const [skill] = (await readRegistry({ registryPath })).skills;
    assert.equal(result.changed, 1);
    assert.equal(skill.update.status, "not_checkable");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
