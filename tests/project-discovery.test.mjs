import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { discoverProjectSkillRoots, resolveScanRoots } from "../scripts/lib/project-discovery.mjs";
import { projectRootId } from "../scripts/lib/project-roots.mjs";
import { scanSkillEnvironment } from "../scripts/lib/scanner.mjs";

async function createSkill(skillsRoot, name) {
  const directory = join(skillsRoot, name);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "SKILL.md"), `---\nname: ${name}\n---\nbody`, "utf8");
}

test("discovers normal and trial project Skill roots but excludes worktrees", async () => {
  const root = await mkdtemp(join(tmpdir(), "project-discovery-"));
  try {
    const documents = join(root, "Documents");
    const vibecoding = join(root, "Vibecoding");
    await createSkill(join(documents, "open-slide", "my-slide", ".agents", "skills"), "create-slide");
    await createSkill(join(documents, "Skill试用", "impeccable", ".agents", "skills"), "impeccable");
    await createSkill(join(vibecoding, "A stock", ".worktrees", "feature", ".agents", "skills"), "a-stock-analysis");

    const result = await discoverProjectSkillRoots({
      workspaceRoots: [documents, vibecoding],
      projectDiscoveryTtlMs: 0,
    });

    assert.deepEqual(result.roots.map((item) => item.projectRoot), [
      join(documents, "Skill试用", "impeccable"),
      join(documents, "open-slide", "my-slide"),
    ].sort((left, right) => left.localeCompare(right)));
    assert.deepEqual(result.roots[0].agents, []);
    assert.deepEqual(result.diagnostics, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not follow directory symlinks or descend into dependency directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "project-discovery-boundary-"));
  try {
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await symlink(workspace, join(workspace, "loop"));
    await createSkill(join(workspace, "node_modules", "pkg", ".agents", "skills"), "ignored");
    const result = await discoverProjectSkillRoots({ workspaceRoots: [workspace], projectDiscoveryTtlMs: 0 });
    assert.deepEqual(result.roots, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("isolates inaccessible project directories as diagnostics", async () => {
  const root = await mkdtemp(join(tmpdir(), "project-discovery-access-"));
  const locked = join(root, "locked", ".agents");
  try {
    await createSkill(join(root, "healthy", ".agents", "skills"), "healthy");
    await mkdir(locked, { recursive: true });
    await chmod(locked, 0o000);
    const result = await discoverProjectSkillRoots({ workspaceRoots: [root], projectDiscoveryTtlMs: 0 });
    assert.equal(result.roots.length, 1);
    assert.equal(result.diagnostics[0].code, "project_discovery_error");
  } finally {
    await chmod(locked, 0o700).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("continues when an entire workspace root is inaccessible", async () => {
  const root = await mkdtemp(join(tmpdir(), "project-discovery-workspace-access-"));
  const healthy = join(root, "healthy-workspace");
  const lockedParent = join(root, "locked-parent");
  const inaccessible = join(lockedParent, "workspace");
  try {
    await createSkill(join(healthy, "project", ".agents", "skills"), "healthy");
    await mkdir(inaccessible, { recursive: true });
    await chmod(lockedParent, 0o000);
    const result = await discoverProjectSkillRoots({ workspaceRoots: [inaccessible, healthy], projectDiscoveryTtlMs: 0 });
    assert.equal(result.roots.length, 1);
    assert.equal(result.diagnostics[0].code, "project_discovery_error");
  } finally {
    await chmod(lockedParent, 0o700).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("adds only direct child Skill folders for a manual direct-skill-folders project", async () => {
  const root = await mkdtemp(join(tmpdir(), "project-discovery-direct-"));
  try {
    const project = join(root, "Skill试用");
    await createSkill(project, "a-stock-data");
    await createSkill(project, "global-stock-data");
    await createSkill(join(project, "nested"), "must-not-discover");
    const configPath = join(root, "project-roots.yaml");
    await writeFile(configPath, `schemaVersion: 1\nupdatedAt: null\nroots:\n  - id: ${projectRootId(project)}\n    path: ${project}\n    label: Skill试用\n    addedAt: "2026-07-11T00:00:00.000Z"\n    scanMode: direct-skill-folders\n`);
    const result = await resolveScanRoots({ public: [], project: [], agent: [], plugin: [], system: [] }, { home: root, workspaceRoots: [], projectRootsPath: configPath, projectDiscoveryTtlMs: 0 });
    assert.deepEqual(result.roots.project.filter((item) => item.directSkillFolders).map((item) => item.path), [project]);
    assert.equal(result.roots.project.find((item) => item.directSkillFolders).projectRoot, project);
    const scan = await scanSkillEnvironment({ registry: { skills: [] }, roots: result.roots });
    assert.deepEqual(scan.skills.map((item) => item.name).sort(), ["a-stock-data", "global-stock-data"]);
    assert.equal(scan.diagnostics.some((item) => item.code === "missing_skill_md"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
