import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile, rm, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseSkillctlArgs } from "../scripts/lib/cli-args.mjs";

const SKILLCTL_PATH = join(process.cwd(), "scripts", "skillctl.mjs");

async function makeTempDir() {
  return mkdtemp(join(tmpdir(), "skillctl-test-"));
}

describe("skillctl CLI", () => {
  let root;
  let agentsConfigDir;
  let publicDir;
  let projectDir;

  beforeEach(async () => {
    root = await makeTempDir();
    agentsConfigDir = join(root, "agents-config");
    publicDir = join(root, "public-skills");
    projectDir = join(root, "project-skills");

    await mkdir(agentsConfigDir, { recursive: true });
    await mkdir(publicDir, { recursive: true });
    await mkdir(projectDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function runSkillctl(args, envOverrides = {}) {
    try {
      const stdout = execFileSync(process.execPath, [SKILLCTL_PATH, ...args], {
        env: {
          ...process.env,
          AGENTS_CONFIG_DIR: agentsConfigDir,
          SKILL_CONTROL_PANEL_PUBLIC_ROOT: publicDir,
          SKILL_CONTROL_PANEL_PROJECT_ROOT: projectDir,
          SKILL_CONTROL_PANEL_WORKSPACE_ROOTS: join(root, "workspace-roots"),
          SKILL_CONTROL_PANEL_AGENT_DISCOVERY_HOME: root,
          ...envOverrides,
        },
        encoding: "utf8",
      });
      return { status: 0, stdout, stderr: "" };
    } catch (error) {
      return {
        status: error.status,
        stdout: error.stdout || "",
        stderr: error.stderr || "",
      };
    }
  }

  it("fails on unknown command", () => {
    const res = runSkillctl(["foo", "--json"]);
    assert.equal(res.status, 2);
    assert.deepEqual(JSON.parse(res.stdout), {
      ok: false,
      command: "foo",
      error: "Unknown command: foo",
    });
  });

  it("returns 2 for unknown, duplicate, and missing-value flags", () => {
    for (const args of [
      ["scan", "--bogus", "--json"],
      ["scan", "--json", "--json"],
      ["check-updates", "--skill", "--json"],
    ]) {
      const res = runSkillctl(args);
      assert.equal(res.status, 2, args.join(" "));
      assert.equal(JSON.parse(res.stdout).ok, false);
    }
  });

  it("rejects invalid command combinations and enum values", () => {
    for (const args of [
      ["adopt", "--all", "--path", publicDir, "--json"],
      ["install", "--source", publicDir, "--scope", "shared", "--vetted", "--json"],
      ["install", "--source", publicDir, "--scope", "agent", "--agent", "cursor", "--vetted", "--json"],
      ["install", "--source", publicDir, "--scope", "public", "--json"],
      ["install", "--source", publicDir, "--scope", "project", "--vetted", "--json"],
      ["install", "--source", publicDir, "--scope", "public", "--project-root", projectDir, "--vetted", "--json"],
      ["update", "--skill", "skill-1", "--source", publicDir, "--json"],
      ["move", "--skill", "skill-1", "--scope", "project", "--json"],
      ["move", "--skill", "skill-1", "--scope", "project", "--confirmed", "--json"],
      ["uninstall", "--skill", "skill-1", "--json"],
      ["reconcile", "--json"],
      ["migrate-routes", "--agent", "codex", "--json"],
    ]) {
      const res = runSkillctl(args);
      assert.equal(res.status, 2, args.join(" "));
      assert.equal(JSON.parse(res.stdout).ok, false);
    }
  });

  it("parses the documented form of every command", () => {
    const commands = [
      ["scan"],
      ["adopt", "--all"],
      ["install", "--source", "/tmp/source", "--scope", "agent", "--agent", "codex", "--vetted"],
      ["update", "--skill", "skill-1", "--source", "/tmp/source", "--vetted"],
      ["move", "--skill", "skill-1", "--scope", "project", "--project-root", "/tmp/project", "--confirmed"],
      ["uninstall", "--skill", "skill-1", "--confirmed"],
      ["check-updates", "--skill", "skill-1"],
      ["validate", "--skill", "skill-1"],
      ["reconcile", "--confirmed"],
      ["migrate-routes", "--agent", "opencode", "--confirmed"],
    ];
    for (const args of commands) assert.equal(parseSkillctlArgs(args).command, args[0]);
  });

  it("returns 1 for a valid command whose operation fails", () => {
    const res = runSkillctl([
      "install", "--source", join(root, "missing"), "--scope", "public", "--vetted", "--json",
    ]);
    assert.equal(res.status, 1);
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.command, "install");
  });

  it("scan command returns skills and summary", async () => {
    // Create an unmanaged skill
    const skillPath = join(publicDir, "test-skill");
    await mkdir(skillPath, { recursive: true });
    await writeFile(join(skillPath, "SKILL.md"), "---\nname: Test Skill\n---\nbody", "utf8");

    const res = runSkillctl(["scan", "--json"]);
    assert.equal(res.status, 0);
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.command, "scan");
    assert.ok(parsed.result.skills);
    assert.equal(parsed.result.skills.length, 1);
    assert.equal(parsed.result.skills[0].name, "Test Skill");
    assert.equal(parsed.result.summary.unmanagedSkills, 1);
  });

  it("adopt --all manages unmanaged skills", async () => {
    const skillPath = join(publicDir, "test-skill");
    await mkdir(skillPath, { recursive: true });
    await writeFile(join(skillPath, "SKILL.md"), "---\nname: Test Skill\n---\nbody", "utf8");

    // First scan should show it's unmanaged
    let res = runSkillctl(["scan", "--json"]);
    let parsed = JSON.parse(res.stdout);
    assert.equal(parsed.result.summary.unmanagedSkills, 1);

    // Adopt all
    res = runSkillctl(["adopt", "--all", "--json"]);
    assert.equal(res.status, 0);

    // Scan again, should now be managed
    res = runSkillctl(["scan", "--json"]);
    parsed = JSON.parse(res.stdout);
    assert.equal(parsed.result.summary.unmanagedSkills, 0);
    assert.equal(parsed.result.summary.managedSkills, 1);
  });

  it("installs project scope at the explicit project root", async () => {
    const source = join(root, "project-source");
    await mkdir(source);
    await writeFile(join(source, "SKILL.md"), "---\nname: project-explicit\n---\nbody", "utf8");
    const res = runSkillctl([
      "install", "--source", source, "--scope", "project",
      "--project-root", projectDir, "--vetted", "--json",
    ]);
    assert.equal(res.status, 0);
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.result.skill.scope.project_root, projectDir);
    assert.equal(parsed.result.skill.install.canonical_path, join(projectDir, ".agents", "skills", "project-explicit"));
  });

  it("validate checks for diagnostics", async () => {
    // A skill missing SKILL.md will cause a diagnostic warning/error
    const skillPath = join(publicDir, "broken-skill");
    await mkdir(skillPath, { recursive: true });

    const res = runSkillctl(["validate", "--json"]);
    // Since there are diagnostics (missing SKILL.md is an error), validate might return exit code 1 or 0 depending on level.
    // Let's assert it runs successfully and returns diagnostics list.
    const parsed = JSON.parse(res.stdout);
    assert.ok(parsed.result.diagnostics);
    assert.ok(parsed.result.diagnostics.some(d => d.code === "missing_skill_md"));
  });
});
