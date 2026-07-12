import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, rm, mkdtemp, access, readdir, readlink, symlink, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  adopt,
  checkUpdates,
  install,
  update,
  move,
  uninstall,
  scan,
} from "../scripts/lib/manager.mjs";

import { readRegistry, writeRegistry } from "../scripts/lib/registry.mjs";
import { readHistory } from "../scripts/lib/history.mjs";
import { stableSkillId } from "../scripts/lib/path-safety.mjs";

async function makeTempDir() {
  return mkdtemp(join(tmpdir(), "scp-actions-test-"));
}

describe("manager actions", () => {
  let root;
  let registryPath;
  let historyPath;
  let trashDir;
  let publicRoot;
  let agentSkillsDir;
  let projectRoot;
  let agentRouteRoots;

  beforeEach(async () => {
    root = await makeTempDir();
    registryPath = join(root, "skills-registry.yaml");
    historyPath = join(root, "skills-history.jsonl");
    trashDir = join(root, "trash");
    publicRoot = join(root, "public");
    agentSkillsDir = join(root, "agent-skills");
    projectRoot = join(root, "project");
    agentRouteRoots = { claude: join(root, "claude-routes") };

    await mkdir(publicRoot, { recursive: true });
    await mkdir(agentSkillsDir, { recursive: true });
    await mkdir(projectRoot, { recursive: true });
    await mkdir(agentRouteRoots.claude, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function getOptions() {
    return {
      registryPath,
      historyPath,
      trashDir,
      publicRoot,
      agentSkillsDir,
      projectRoot,
      agentRouteRoots,
      roots: {
        public: [{ path: publicRoot, agents: ["claude"], ownership: "managed" }],
        agent: [{ path: join(agentSkillsDir, "claude"), agent: "claude", ownership: "managed" }],
        project: [{ path: join(projectRoot, ".agents", "skills"), projectRoot, agents: ["claude"], ownership: "managed" }],
        system: [],
        plugin: [],
      },
    };
  }

  async function installThenCorruptCanonical(name) {
    const sourceDir = join(root, `source-${name}`);
    await mkdir(sourceDir);
    await writeFile(join(sourceDir, "SKILL.md"), `---\nname: ${name}\n---\nsource`, "utf8");
    const installed = await install({ source: sourceDir, scope: "public", vetted: true }, getOptions());
    const victim = join(root, `victim-${name}`);
    await mkdir(victim);
    await writeFile(join(victim, "SKILL.md"), "victim-content", "utf8");
    const registry = await readRegistry(getOptions());
    const record = registry.skills.find((skill) => skill.id === installed.skill.id);
    record.install.canonical_path = victim;
    record.install.skill_md_path = join(victim, "SKILL.md");
    await writeRegistry(registry, getOptions());
    return { installed, victim, sourceDir };
  }

  it("adds every discovered project root to a live-style scan", async () => {
    const workspace = join(root, "workspace");
    const project = join(workspace, "demo");
    const skillPath = join(project, ".agents", "skills", "project-only");
    await mkdir(skillPath, { recursive: true });
    await writeFile(join(skillPath, "SKILL.md"), "---\nname: project-only\n---\nProject capability", "utf8");

    const result = await scan({
      ...getOptions(),
      discoverProjects: true,
      workspaceRoots: [workspace],
      projectDiscoveryTtlMs: 0,
    });

    const discovered = result.skills.find((skill) => skill.name === "project-only");
    assert.equal(discovered.scope.level, "project");
    assert.equal(discovered.scope.project_root, project);
    assert.equal(discovered.ownership, "unmanaged");
  });

  // ── install ────────────────────────────────────────────────────────

  it("fails to install if not vetted", async () => {
    const sourceDir = await makeTempDir();
    await writeFile(join(sourceDir, "SKILL.md"), "---\nname: my-skill\n---\nbody", "utf8");

    const res = await install(
      { source: sourceDir, scope: "public" },
      getOptions(),
    );
    assert.equal(res.ok, false);
    assert.match(res.error, /vetted/i);

    await rm(sourceDir, { recursive: true, force: true });
  });

  it("installs an agent-private skill with a discoverable route", async () => {
    const sourceDir = await makeTempDir();
    await writeFile(join(sourceDir, "SKILL.md"), "---\nname: private-skill\n---\nbody", "utf8");
    const result = await install(
      { source: sourceDir, scope: "agent", agent: "claude", vetted: true },
      getOptions(),
    );
    assert.equal(result.ok, true);
    const route = join(agentRouteRoots.claude, "private-skill");
    assert.equal(await readlink(route), result.skill.install.canonical_path);
    assert.deepEqual(result.skill.install.routes, [route]);
    await rm(sourceDir, { recursive: true, force: true });
  });

  it("installs to public scope successfully when vetted", async () => {
    const sourceDir = await makeTempDir();
    await writeFile(join(sourceDir, "SKILL.md"), "---\nname: my-skill\n---\nbody", "utf8");

    const res = await install(
      { source: sourceDir, scope: "public", vetted: true },
      getOptions(),
    );

    assert.equal(res.ok, true);
    assert.equal(res.action, "install");

    // Verify it is on disk
    const targetPath = join(publicRoot, "my-skill");
    await assert.doesNotReject(access(join(targetPath, "SKILL.md")));

    // Verify registry
    const registry = await readRegistry(getOptions());
    const skill = registry.skills.find(s => s.name === "my-skill");
    assert.ok(skill);
    assert.equal(skill.scope.level, "public");

    // Verify history
    const history = await readHistory({}, getOptions());
    assert.equal(history.items.length, 1);
    assert.equal(history.items[0].action, "install");

    await rm(sourceDir, { recursive: true, force: true });
  });

  it("rejects install with duplicate name", async () => {
    const sourceDir = await makeTempDir();
    await writeFile(join(sourceDir, "SKILL.md"), "---\nname: my-skill\n---\nbody", "utf8");

    // First install
    await install(
      { source: sourceDir, scope: "public", vetted: true },
      getOptions(),
    );

    // Second install
    const res = await install(
      { source: sourceDir, scope: "public", vetted: true },
      getOptions(),
    );
    assert.equal(res.ok, false);
    assert.match(res.error, /duplicate/i);

    await rm(sourceDir, { recursive: true, force: true });
  });

  it("rejects install with invalid SKILL.md", async () => {
    const sourceDir = await makeTempDir();
    // No SKILL.md
    const res = await install(
      { source: sourceDir, scope: "public", vetted: true },
      getOptions(),
    );
    assert.equal(res.ok, false);
    assert.match(res.error, /SKILL\.md/i);

    await rm(sourceDir, { recursive: true, force: true });
  });

  it("rejects a source whose SKILL.md is a symbolic link", async () => {
    const sourceDir = join(root, "symlink-source");
    const outside = join(root, "outside-skill.md");
    await mkdir(sourceDir);
    await writeFile(outside, "---\nname: linked-skill\n---\nbody", "utf8");
    await symlink(outside, join(sourceDir, "SKILL.md"));
    const result = await install({ source: sourceDir, scope: "public", vetted: true }, getOptions());
    assert.equal(result.ok, false);
    assert.match(result.error, /regular file|symbolic link/i);
    await assert.rejects(access(join(publicRoot, "linked-skill")));
  });

  it("rejects a frontmatter name that escapes the public root", async () => {
    const sourceDir = await makeTempDir();
    await writeFile(join(sourceDir, "SKILL.md"), "---\nname: ../escaped-skill\n---\nbody", "utf8");

    const res = await install(
      { source: sourceDir, scope: "public", vetted: true },
      getOptions(),
    );

    assert.equal(res.ok, false);
    assert.match(res.error, /safe basename|managed root/i);
    await assert.rejects(access(join(root, "escaped-skill", "SKILL.md")));
    await rm(sourceDir, { recursive: true, force: true });
  });

  it("uses the canonical-path stable id when installing", async () => {
    const sourceDir = await makeTempDir();
    await writeFile(join(sourceDir, "SKILL.md"), "---\nname: stable-skill\n---\nbody", "utf8");

    const installed = await install(
      { source: sourceDir, scope: "public", vetted: true },
      getOptions(),
    );
    const scanned = await scan(getOptions());

    assert.equal(installed.skill.id, scanned.skills[0].id);
    assert.equal(installed.skill.update.status, "not_checkable");
    await rm(sourceDir, { recursive: true, force: true });
  });

  it("rolls back an install when history append fails", async () => {
    const sourceDir = await makeTempDir();
    await writeFile(join(sourceDir, "SKILL.md"), "---\nname: history-fail\n---\nbody", "utf8");
    const badHistoryPath = join(root, "history-directory");
    await mkdir(badHistoryPath);

    const result = await install(
      { source: sourceDir, scope: "public", vetted: true },
      { ...getOptions(), historyPath: badHistoryPath },
    );

    assert.equal(result.ok, false);
    assert.equal(result.rolledBack, true);
    await assert.rejects(access(join(publicRoot, "history-fail", "SKILL.md")));
    assert.equal((await readRegistry(getOptions())).skills.length, 0);
    await rm(sourceDir, { recursive: true, force: true });
  });

  it("reports an incomplete rollback when partial History cannot be truncated", async () => {
    const sourceDir = await makeTempDir();
    await writeFile(join(sourceDir, "SKILL.md"), "---\nname: history-truncate-fail\n---\nbody", "utf8");
    const result = await install(
      { source: sourceDir, scope: "public", vetted: true },
      {
        ...getOptions(),
        historyWrite: async (handle, data) => {
          await handle.write(data.subarray(0, 12));
          throw new Error("partial append");
        },
        historyTruncate: async () => { throw new Error("truncate failed"); },
      },
    );
    assert.equal(result.ok, false);
    assert.equal(result.rolledBack, false);
    assert.match(result.rollbackErrors.join(" "), /History rollback failed.*truncate failed/);
    await rm(sourceDir, { recursive: true, force: true });
  });

  // ── update ─────────────────────────────────────────────────────────

  it("updates existing skill and preserves history data", async () => {
    const sourceDir1 = await makeTempDir();
    await writeFile(join(sourceDir1, "SKILL.md"), "---\nname: my-skill\nversion: 1.0.0\n---\nbody", "utf8");

    const installRes = await install(
      { source: sourceDir1, scope: "public", vetted: true },
      getOptions(),
    );
    const skillId = installRes.skill.id;

    const sourceDir2 = await makeTempDir();
    await writeFile(join(sourceDir2, "SKILL.md"), "---\nname: my-skill\nversion: 2.0.0\n---\nbody updated", "utf8");

    const res = await update(
      { skillId, source: sourceDir2, vetted: true },
      getOptions(),
    );
    assert.equal(res.ok, true);
    assert.equal(res.skill.version.current, "2.0.0");
    assert.equal(res.skill.update.status, "not_checkable");

    // Verify history version diff
    const history = await readHistory({ action: "update" }, getOptions());
    assert.equal(history.items.length, 1);
    assert.equal(history.items[0].before.version.current, "1.0.0");
    assert.equal(history.items[0].after.version.current, "2.0.0");

    await rm(sourceDir1, { recursive: true, force: true });
    await rm(sourceDir2, { recursive: true, force: true });
  });

  it("preserves an existing remote source locator when the update directory is standalone", async () => {
    const sourceDir1 = await makeTempDir();
    await writeFile(join(sourceDir1, "SKILL.md"), "---\nname: remote-skill\nversion: 1.0.0\n---\nbody", "utf8");
    const installed = await install({ source: sourceDir1, scope: "public", vetted: true }, getOptions());
    const registry = await readRegistry(getOptions());
    const current = registry.skills.find((skill) => skill.id === installed.skill.id);
    current.source = {
      type: "github",
      url: "https://github.com/example/remote-skill",
      repository: "https://github.com/example/remote-skill.git",
      subpath: ".agents/skills/remote-skill",
      ref: "main",
      revision: "old-revision",
      content_digest: current.source.content_digest,
    };
    await writeRegistry(registry, getOptions());

    const replacement = await makeTempDir();
    await writeFile(join(replacement, "SKILL.md"), "---\nname: remote-skill\nversion: 2.0.0\n---\nupdated", "utf8");
    const result = await update({ skillId: installed.skill.id, source: replacement, vetted: true }, getOptions());

    assert.equal(result.ok, true);
    assert.equal(result.skill.version.current, "2.0.0");
    assert.deepEqual(result.skill.source, {
      type: "github",
      url: "https://github.com/example/remote-skill",
      repository: "https://github.com/example/remote-skill.git",
      subpath: ".agents/skills/remote-skill",
      ref: "main",
      revision: "old-revision",
      content_digest: result.skill.source.content_digest,
    });
    assert.match(result.skill.source.content_digest, /^[0-9a-f]{64}$/);

    await rm(sourceDir1, { recursive: true, force: true });
    await rm(replacement, { recursive: true, force: true });
  });

  it("rolls back files and registry on update failure", async () => {
    const sourceDir1 = await makeTempDir();
    await writeFile(join(sourceDir1, "SKILL.md"), "---\nname: my-skill\nversion: 1.0.0\n---\nbody", "utf8");
    const installRes = await install(
      { source: sourceDir1, scope: "public", vetted: true },
      getOptions(),
    );
    const skillId = installRes.skill.id;

    // Make a non-existent source directory update to force an update failure and test rollback
    const badRes = await update(
      { skillId, source: join(root, "non-existent-src"), vetted: true },
      getOptions(),
    );

    assert.equal(badRes.ok, false);
    // Original version should still be 1.0.0
    const registry = await readRegistry(getOptions());
    const skill = registry.skills.find(s => s.id === skillId);
    assert.equal(skill.version.current, "1.0.0");

    await rm(sourceDir1, { recursive: true, force: true });
  });

  it("restores files and registry when update history append fails", async () => {
    const sourceDir1 = await makeTempDir();
    const sourceDir2 = await makeTempDir();
    await writeFile(join(sourceDir1, "SKILL.md"), "---\nname: my-skill\nversion: 1.0.0\n---\nv1", "utf8");
    await writeFile(join(sourceDir2, "SKILL.md"), "---\nname: my-skill\nversion: 2.0.0\n---\nv2", "utf8");
    const installed = await install({ source: sourceDir1, scope: "public", vetted: true }, getOptions());
    const badHistoryPath = join(root, "history-directory");
    await mkdir(badHistoryPath);

    const result = await update(
      { skillId: installed.skill.id, source: sourceDir2, vetted: true },
      { ...getOptions(), historyPath: badHistoryPath },
    );

    assert.equal(result.ok, false);
    assert.equal(result.rolledBack, true);
    assert.match(await (await import("node:fs/promises")).readFile(join(publicRoot, "my-skill", "SKILL.md"), "utf8"), /version: 1\.0\.0/);
    assert.equal((await readRegistry(getOptions())).skills[0].version.current, "1.0.0");
    assert.deepEqual((await readdir(publicRoot)).filter((name) => name.includes("backup")), []);
    await rm(sourceDir1, { recursive: true, force: true });
    await rm(sourceDir2, { recursive: true, force: true });
  });

  it("rejects an update whose staged Skill name differs from the registry", async () => {
    const original = join(root, "identity-original");
    const replacement = join(root, "identity-replacement");
    await mkdir(original);
    await mkdir(replacement);
    await writeFile(join(original, "SKILL.md"), "---\nname: identity-a\n---\noriginal", "utf8");
    await writeFile(join(replacement, "SKILL.md"), "---\nname: identity-b\n---\nreplacement", "utf8");
    const installed = await install({ source: original, scope: "public", vetted: true }, getOptions());
    const result = await update({ skillId: installed.skill.id, source: replacement, vetted: true }, getOptions());
    assert.equal(result.ok, false);
    assert.match(result.error, /name.*match|identity/i);
    assert.match(await (await import("node:fs/promises")).readFile(join(publicRoot, "identity-a", "SKILL.md"), "utf8"), /original/);
  });

  // ── move ───────────────────────────────────────────────────────────

  it("moves skill to new scope successfully when confirmed", async () => {
    const sourceDir = await makeTempDir();
    await writeFile(join(sourceDir, "SKILL.md"), "---\nname: my-skill\n---\nbody", "utf8");

    const installRes = await install(
      { source: sourceDir, scope: "public", vetted: true },
      getOptions(),
    );
    const skillId = installRes.skill.id;

    // Fail if not confirmed
    let moveRes = await move(
      { skillId, scope: "project" },
      getOptions(),
    );
    assert.equal(moveRes.ok, false);
    assert.match(moveRes.error, /confirm/i);

    // Success if confirmed
    moveRes = await move(
      { skillId, scope: "project", confirmed: true },
      getOptions(),
    );
    assert.equal(moveRes.ok, true);

    const registry = await readRegistry(getOptions());
    const skill = registry.skills.find(s => s.id === moveRes.skill.id);
    assert.equal(skill.scope.level, "project");
    assert.equal(skill.id, stableSkillId(skill.install.canonical_path));
    assert.equal(registry.skills.some((item) => item.id === skillId), false);
    const removed = await uninstall({ skillId: skill.id, confirmed: true }, getOptions());
    assert.equal(removed.ok, true);

    await rm(sourceDir, { recursive: true, force: true });
  });

  it("restores the original scope when move history append fails", async () => {
    const sourceDir = await makeTempDir();
    await writeFile(join(sourceDir, "SKILL.md"), "---\nname: my-skill\n---\nbody", "utf8");
    const installed = await install({ source: sourceDir, scope: "public", vetted: true }, getOptions());
    const badHistoryPath = join(root, "history-directory");
    await mkdir(badHistoryPath);

    const result = await move(
      { skillId: installed.skill.id, scope: "project", confirmed: true },
      { ...getOptions(), historyPath: badHistoryPath },
    );

    assert.equal(result.ok, false);
    assert.equal(result.rolledBack, true);
    await assert.doesNotReject(access(join(publicRoot, "my-skill", "SKILL.md")));
    await assert.rejects(access(join(projectRoot, ".agents", "skills", "my-skill")));
    assert.equal((await readRegistry(getOptions())).skills[0].scope.level, "public");
    await rm(sourceDir, { recursive: true, force: true });
  });

  // ── uninstall ──────────────────────────────────────────────────────

  it("moves uninstalled skill to trash and does not delete permanently", async () => {
    const sourceDir = await makeTempDir();
    await writeFile(join(sourceDir, "SKILL.md"), "---\nname: my-skill\n---\nbody", "utf8");

    const installRes = await install(
      { source: sourceDir, scope: "public", vetted: true },
      getOptions(),
    );
    const skillId = installRes.skill.id;

    // Fail if not confirmed
    let uninstallRes = await uninstall(
      { skillId },
      getOptions(),
    );
    assert.equal(uninstallRes.ok, false);
    assert.match(uninstallRes.error, /confirm/i);

    // Success if confirmed
    uninstallRes = await uninstall(
      { skillId, confirmed: true },
      getOptions(),
    );
    assert.equal(uninstallRes.ok, true);

    // Verify it is NOT at original canonical path
    const targetPath = join(publicRoot, "my-skill");
    await assert.rejects(access(targetPath));

    // Verify it is in trash
    const trashFiles = await readdir(trashDir);
    assert.ok(trashFiles.length > 0);
    // Find my-skill inside the timestamped subdirectory
    const timestampDir = join(trashDir, trashFiles[0]);
    await assert.doesNotReject(access(join(timestampDir, "my-skill", "SKILL.md")));

    await rm(sourceDir, { recursive: true, force: true });
  });

  it("restores an uninstalled skill when history append fails", async () => {
    const sourceDir = await makeTempDir();
    await writeFile(join(sourceDir, "SKILL.md"), "---\nname: my-skill\n---\nbody", "utf8");
    const installed = await install({ source: sourceDir, scope: "public", vetted: true }, getOptions());
    const badHistoryPath = join(root, "history-directory");
    await mkdir(badHistoryPath);

    const result = await uninstall(
      { skillId: installed.skill.id, confirmed: true },
      { ...getOptions(), historyPath: badHistoryPath },
    );

    assert.equal(result.ok, false);
    assert.equal(result.rolledBack, true);
    await assert.doesNotReject(access(join(publicRoot, "my-skill", "SKILL.md")));
    assert.equal((await readRegistry(getOptions())).skills[0].lifecycle, "active");
    await rm(sourceDir, { recursive: true, force: true });
  });

  it("refuses update, move, and uninstall when the registry canonical path contradicts its scope", async (t) => {
    for (const action of ["update", "move", "uninstall"]) {
      await t.test(action, async () => {
        const name = `corrupt-${action}`;
        const { installed, victim } = await installThenCorruptCanonical(name);
        let result;
        if (action === "update") {
          const replacement = join(root, `replacement-${name}`);
          await mkdir(replacement);
          await writeFile(join(replacement, "SKILL.md"), `---\nname: ${name}\n---\nreplacement`, "utf8");
          result = await update({ skillId: installed.skill.id, source: replacement, vetted: true }, getOptions());
        } else if (action === "move") {
          result = await move({ skillId: installed.skill.id, scope: "project", confirmed: true }, getOptions());
        } else {
          result = await uninstall({ skillId: installed.skill.id, confirmed: true }, getOptions());
        }
        assert.equal(result.ok, false);
        assert.match(result.error, /canonical path|stable.*id|scope/i);
        assert.equal(await (await import("node:fs/promises")).readFile(join(victim, "SKILL.md"), "utf8"), "victim-content");
      });
    }
  });

  it("allows adopted Skills stored in a versioned directory", async () => {
    const sourceDir = join(publicRoot, "versioned-skill-1.0.0");
    await mkdir(sourceDir);
    await writeFile(join(sourceDir, "SKILL.md"), "---\nname: versioned-skill\n---\nbody", "utf8");
    const adopted = await adopt({ ...getOptions(), path: sourceDir });

    const result = await uninstall({ skillId: adopted.adopted[0].id, confirmed: true }, getOptions());

    assert.equal(result.ok, true);
  });

  it("does not lose a concurrent install while a full update check is in flight", async () => {
    const firstSource = join(root, "check-first-source");
    const secondSource = join(root, "check-second-source");
    await mkdir(firstSource);
    await mkdir(secondSource);
    await writeFile(join(firstSource, "SKILL.md"), "---\nname: check-first\n---\nbody", "utf8");
    await writeFile(join(secondSource, "SKILL.md"), "---\nname: check-second\n---\nbody", "utf8");
    const first = await install({ source: firstSource, scope: "public", vetted: true }, getOptions());
    const registry = await readRegistry(getOptions());
    registry.skills[0].source = { ...registry.skills[0].source, type: "github", url: "https://github.com/o/r", repository: "https://github.com/o/r" };
    await writeRegistry(registry, getOptions());

    let releaseClone;
    let announceClone;
    const cloneStarted = new Promise((resolve) => { announceClone = resolve; });
    const cloneReleased = new Promise((resolve) => { releaseClone = resolve; });
    const checking = checkUpdates({
      ...getOptions(),
      runGit: async (args) => {
        if (args[0] === "clone") {
          announceClone();
          await cloneReleased;
          await mkdir(args.at(-1), { recursive: true });
          await writeFile(join(args.at(-1), "SKILL.md"), "---\nname: check-first\n---\nbody", "utf8");
        }
        return args[0] === "rev-parse" ? "abc123\n" : "";
      },
    });
    await cloneStarted;
    const second = await install({ source: secondSource, scope: "public", vetted: true }, getOptions());
    assert.equal(second.ok, true);
    releaseClone();
    assert.equal((await checking).ok, true);
    const names = (await readRegistry(getOptions())).skills.map((skill) => skill.name).sort();
    assert.deepEqual(names, [first.skill.name, second.skill.name].sort());
  });

  it("does not apply a stale check result after the checked Skill is updated concurrently", async () => {
    const firstSource = join(root, "stale-check-first");
    const replacement = join(root, "stale-check-replacement");
    await mkdir(firstSource);
    await mkdir(replacement);
    await writeFile(join(firstSource, "SKILL.md"), "---\nname: stale-check\n---\nold", "utf8");
    await writeFile(join(replacement, "SKILL.md"), "---\nname: stale-check\n---\nnew", "utf8");
    const installed = await install({ source: firstSource, scope: "public", vetted: true }, getOptions());
    const registry = await readRegistry(getOptions());
    registry.skills[0].source = { ...registry.skills[0].source, type: "github", url: "https://github.com/o/old", repository: "https://github.com/o/old" };
    await writeRegistry(registry, getOptions());
    let releaseClone;
    let announceClone;
    const cloneStarted = new Promise((resolve) => { announceClone = resolve; });
    const cloneReleased = new Promise((resolve) => { releaseClone = resolve; });
    const checking = checkUpdates({
      ...getOptions(), skillId: installed.skill.id,
      runGit: async (args) => {
        if (args[0] === "clone") {
          announceClone();
          await cloneReleased;
          await mkdir(args.at(-1), { recursive: true });
          await writeFile(join(args.at(-1), "SKILL.md"), "old-remote", "utf8");
        }
        return args[0] === "rev-parse" ? "old-revision\n" : "";
      },
    });
    await cloneStarted;
    const updated = await update({ skillId: installed.skill.id, source: replacement, vetted: true }, getOptions());
    assert.equal(updated.ok, true);
    releaseClone();
    assert.equal((await checking).ok, true);
    const [skill] = (await readRegistry(getOptions())).skills;
    assert.equal(skill.source.type, "github");
    assert.equal(skill.source.repository, "https://github.com/o/old");
    assert.equal(skill.update.status, "unknown");
  });

  it("rolls back update-check Registry changes when History append fails", async () => {
    const source = join(root, "check-history-source");
    await mkdir(source);
    await writeFile(join(source, "SKILL.md"), "---\nname: check-history\n---\nbody", "utf8");
    const installed = await install({ source, scope: "public", vetted: true }, getOptions());
    const registry = await readRegistry(getOptions());
    registry.skills[0].source = { ...registry.skills[0].source, type: "github", url: "https://github.com/o/r", repository: "https://github.com/o/r" };
    registry.skills[0].update = { status: "unknown", latest: null, checked_at: null, error: null };
    await writeRegistry(registry, getOptions());
    const badHistoryPath = join(root, "check-history-directory");
    await mkdir(badHistoryPath);
    const result = await checkUpdates({
      ...getOptions(), historyPath: badHistoryPath, skillId: installed.skill.id,
      runGit: async (args) => {
        if (args[0] === "clone") {
          await mkdir(args.at(-1), { recursive: true });
          await writeFile(join(args.at(-1), "SKILL.md"), "different", "utf8");
        }
        return args[0] === "rev-parse" ? "abc123\n" : "";
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.rolledBack, true);
    assert.equal((await readRegistry(getOptions())).skills[0].update.status, "unknown");
  });

  it("rolls back an adopt-all batch when History append fails", async () => {
    for (const name of ["adopt-one", "adopt-two"]) {
      const path = join(publicRoot, name);
      await mkdir(path);
      await writeFile(join(path, "SKILL.md"), `---\nname: ${name}\n---\nbody`, "utf8");
    }
    const badHistoryPath = join(root, "adopt-history-directory");
    await mkdir(badHistoryPath);
    const result = await adopt({ ...getOptions(), historyPath: badHistoryPath, all: true });
    assert.equal(result.ok, false);
    assert.equal(result.rolledBack, true);
    assert.deepEqual((await readRegistry(getOptions())).skills, []);
  });

  it("adopts a symlink route using the canonical real path and scanner id", async () => {
    const actual = join(publicRoot, "actual-adopt");
    const route = join(root, "adopt-route");
    await mkdir(actual);
    await writeFile(join(actual, "SKILL.md"), "---\nname: actual-adopt\n---\nbody", "utf8");
    await symlink(actual, route, "dir");
    const result = await adopt({ ...getOptions(), path: route });
    const canonical = await realpath(actual);
    assert.equal(result.ok, true);
    assert.equal(result.adopted[0].install.canonical_path, canonical);
    assert.equal(result.adopted[0].id, stableSkillId(canonical));
    assert.equal((await uninstall({ skillId: result.adopted[0].id, confirmed: true }, getOptions())).ok, true);
  });
});
