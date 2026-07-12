import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

import {
  SkillDocumentTooLargeError,
  readSkillDocument,
  scanSkillEnvironment,
} from "../scripts/lib/scanner.mjs";

const NOW = "2026-07-10T08:00:00.000Z";

function emptyRoots() {
  return { public: [], agent: [], project: [], system: [], plugin: [] };
}

function createRegistrySkill(canonicalPath, overrides = {}) {
  return {
    id: `registered-${canonicalPath.split("/").at(-1)}`,
    name: canonicalPath.split("/").at(-1),
    lifecycle: "active",
    ownership: "managed",
    capability_summary: "Registry capability",
    scope: { level: "public", agent: null, project_root: null },
    install: {
      canonical_path: canonicalPath,
      skill_md_path: join(canonicalPath, "SKILL.md"),
      routes: [],
    },
    source: {
      type: "unknown",
      url: null,
      repository: null,
      subpath: null,
      ref: null,
      revision: null,
      content_digest: null,
    },
    version: { current: null, kind: "unknown", basis: "unknown" },
    update: { status: "unknown", latest: null, checked_at: null, error: null },
    installed_at: null,
    updated_at: null,
    ...overrides,
  };
}

function registry(skills = []) {
  return { schemaVersion: 1, updatedAt: null, skills };
}

async function withTempTree(fn) {
  const root = await mkdtemp(join(tmpdir(), "skill-scanner-test-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function createSkill(root, name, source = `---\nname: ${name}\n---\n\n# ${name}\n`) {
  const path = join(root, name);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "SKILL.md"), source, "utf8");
  return realpath(path);
}

function diagnostic(result, code) {
  return result.diagnostics.find((item) => item.code === code);
}

test("classifies runtime agent system and plugin skills without unmanaged warnings", async () => {
  await withTempTree(async (root) => {
    const systemRoot = join(root, "system"), pluginRoot = join(root, "plugin");
    await createSkill(systemRoot, "system-skill");
    await createSkill(pluginRoot, "plugin-skill");
    const result = await scanSkillEnvironment({ registry: registry(), roots: { ...emptyRoots(),
      system: [{ path: systemRoot, agent: "codex", ownership: "system", agentSkillKind: "system", provider: "codex", enabledBasis: "system_builtin" }],
      plugin: [{ path: pluginRoot, agent: "opencode", ownership: "plugin", pluginName: "pkg", agentSkillKind: "plugin", provider: "pkg", enabledBasis: "enabled_config" }],
    } });
    assert.deepEqual(result.skills.map((skill) => [skill.scope.agent, skill.agentSkillKind, skill.provider, skill.enabledBasis]), [["opencode", "plugin", "pkg", "enabled_config"], ["codex", "system", "codex", "system_builtin"]]);
    assert.equal(result.diagnostics.some((item) => item.code === "unmanaged_skill"), false);
  });
});

test("does not follow runtime system or plugin Skill symlinks outside their roots", async () => {
  await withTempTree(async (root) => {
    const systemRoot = join(root, "system"), outside = join(root, "outside");
    await mkdir(systemRoot); await createSkill(outside, "outside-skill");
    await symlink(join(outside, "outside-skill"), join(systemRoot, "linked-skill"));
    const result = await scanSkillEnvironment({ registry: registry(), roots: { ...emptyRoots(), system: [{ path: systemRoot, agent: "codex", ownership: "system", agentSkillKind: "system", provider: "codex", enabledBasis: "system_builtin" }] } });
    assert.equal(result.skills.length, 0);
    assert.ok(result.diagnostics.some((item) => item.code === "runtime_skill_symlink"));
  });
});

test("deduplicates canonical realpaths and merges agents and actual symlink routes", async () => {
  await withTempTree(async (root) => {
    const publicRoot = join(root, ".agents", "skills");
    const claudeRoot = join(root, ".claude", "skills");
    const canonicalPath = await createSkill(publicRoot, "shared-skill");
    const claudeRoute = join(claudeRoot, "shared-skill");
    await mkdir(claudeRoot, { recursive: true });
    await symlink(canonicalPath, claudeRoute);

    const result = await scanSkillEnvironment({
      registry: registry([
        createRegistrySkill(canonicalPath, {
          id: "shared-id",
          install: {
            canonical_path: canonicalPath,
            skill_md_path: join(canonicalPath, "SKILL.md"),
            routes: [claudeRoute],
          },
        }),
      ]),
      roots: {
        ...emptyRoots(),
        public: [{ path: publicRoot, agents: ["codex", "opencode", "antigravity"], ownership: "managed" }],
        agent: [{ path: claudeRoot, agent: "claude", ownership: "managed" }],
      },
      agentVersions: {},
      now: NOW,
    });

    assert.equal(result.scannedAt, NOW);
    assert.equal(result.skills.length, 1);
    assert.equal(result.skills[0].id, "shared-id");
    assert.equal(result.skills[0].realPath, canonicalPath);
    assert.deepEqual(result.skills[0].agents, ["antigravity", "claude", "codex", "opencode"]);
    assert.deepEqual(result.skills[0].routes, [claudeRoute]);
    assert.deepEqual(result.summary, {
      totalSkills: 1,
      updateAvailable: 0,
      managedSkills: 1,
      unmanagedSkills: 0,
      diagnostics: { error: 0, warning: 0, info: 0 },
    });
  });
});

test("rejects a registered SKILL.md symlink instead of exposing its target", async () => {
  await withTempTree(async (root) => {
    const publicRoot = join(root, "public");
    const skillPath = join(publicRoot, "linked-document");
    const outside = join(root, "outside.txt");
    await mkdir(skillPath, { recursive: true });
    await writeFile(outside, "private outside content", "utf8");
    await symlink(outside, join(skillPath, "SKILL.md"));

    const result = await scanSkillEnvironment({
      registry: registry([createRegistrySkill(skillPath)]),
      roots: { ...emptyRoots(), public: [{ path: publicRoot, agents: ["codex"], ownership: "managed" }] },
    });

    assert.equal(result.skills.length, 0);
    assert.equal(diagnostic(result, "skill_access_error")?.severity, "error");
    await assert.rejects(readSkillDocument({ skillMdPath: join(skillPath, "SKILL.md") }), /symbolic link|regular file/i);
  });
});

test("isolates fact-resolution failures caused by unreadable auxiliary files", async () => {
  await withTempTree(async (root) => {
    const publicRoot = join(root, "public");
    const healthy = await createSkill(publicRoot, "healthy");
    const broken = await createSkill(publicRoot, "broken-facts");
    const unreadable = join(broken, "secret.bin");
    await writeFile(unreadable, "secret", "utf8");
    await chmod(unreadable, 0o000);
    try {
      const result = await scanSkillEnvironment({
        registry: registry([createRegistrySkill(healthy), createRegistrySkill(broken)]),
        roots: { ...emptyRoots(), public: [{ path: publicRoot, agents: ["codex"], ownership: "managed" }] },
      });
      assert.deepEqual(result.skills.map((skill) => skill.name), ["healthy"]);
      assert.equal(diagnostic(result, "skill_fact_error")?.severity, "error");
    } finally {
      await chmod(unreadable, 0o600);
    }
  });
});

test("keeps same-name instances and reports differences as a warning", async () => {
  await withTempTree(async (root) => {
    const publicRoot = join(root, "public");
    const projectRoot = join(root, "project");
    const projectSkills = join(projectRoot, ".agents", "skills");
    const publicSkill = await createSkill(publicRoot, "duplicate");
    const projectSkill = await createSkill(projectSkills, "duplicate");
    await createSkill(join(publicSkill, "references"), "nested-support");

    const result = await scanSkillEnvironment({
      registry: registry([
        createRegistrySkill(publicSkill, { id: "public-id" }),
        createRegistrySkill(projectSkill, {
          id: "project-id",
          scope: { level: "project", agent: null, project_root: projectRoot },
        }),
      ]),
      roots: {
        ...emptyRoots(),
        public: [{ path: publicRoot, agents: ["codex"], ownership: "managed" }],
        project: [{ path: projectSkills, projectRoot, agents: ["codex", "claude"], ownership: "managed" }],
      },
      agentVersions: {},
      now: NOW,
    });

    assert.deepEqual(result.skills.map((skill) => skill.id).sort(), ["project-id", "public-id"]);
    assert.equal(result.summary.totalSkills, 2);
    assert.deepEqual(diagnostic(result, "instance_difference"), {
      code: "instance_difference",
      severity: "warning",
      message: 'Skill "duplicate" has differing installation instances',
      skillId: null,
      path: null,
      agent: null,
      details: { name: "duplicate", instanceIds: ["project-id", "public-id"] },
    });
    assert.equal(result.skills.some((skill) => skill.name === "nested-support"), false);
  });
});

test("excludes stale registry paths from the inventory and reports them", async () => {
  await withTempTree(async (root) => {
    const missingPath = join(root, "missing", "stale-skill");
    const result = await scanSkillEnvironment({
      registry: registry([createRegistrySkill(missingPath, { id: "stale-id" })]),
      roots: emptyRoots(),
      agentVersions: {},
      now: NOW,
    });

    assert.equal(result.skills.length, 0);
    assert.equal(result.summary.totalSkills, 0);
    assert.deepEqual(diagnostic(result, "stale_registry"), {
      code: "stale_registry",
      severity: "warning",
      message: 'Registry skill "stale-skill" is missing from disk',
      skillId: "stale-id",
      path: missingPath,
      agent: null,
      details: {},
    });
  });
});

test("reports unmanaged skills and directories missing SKILL.md", async () => {
  await withTempTree(async (root) => {
    const publicRoot = join(root, "public");
    const unmanagedPath = await createSkill(publicRoot, "unmanaged");
    const incompletePath = join(publicRoot, "incomplete");
    await mkdir(incompletePath, { recursive: true });

    const result = await scanSkillEnvironment({
      registry: registry(),
      roots: {
        ...emptyRoots(),
        public: [{ path: publicRoot, agents: ["codex"], ownership: "managed" }],
      },
      agentVersions: {},
      now: NOW,
    });

    assert.equal(result.skills.length, 1);
    assert.equal(result.skills[0].realPath, unmanagedPath);
    assert.equal(result.skills[0].ownership, "unmanaged");
    assert.equal(result.summary.unmanagedSkills, 1);
    assert.equal(diagnostic(result, "unmanaged_skill").path, unmanagedPath);
    assert.equal(diagnostic(result, "missing_skill_md").path, incompletePath);
    assert.deepEqual(result.summary.diagnostics, { error: 1, warning: 1, info: 0 });
  });
});

test("uses frontmatter and the first prose paragraph when registry metadata is missing", async () => {
  await withTempTree(async (root) => {
    const publicRoot = join(root, "public");
    const skillPath = await createSkill(
      publicRoot,
      "metadata-skill",
      [
        "---",
        "name: metadata-skill",
        "description: Handles release planning.",
        "version: 2.3.4",
        "source:",
        "  url: https://github.com/example/skills/tree/main/metadata-skill",
        "  repository: https://github.com/example/skills.git",
        "  ref: main",
        "---",
        "",
        "# Metadata Skill",
        "",
        "Turns a release brief into a checked execution plan.",
        "",
        "## Inputs",
        "",
        "This later paragraph is not part of the fallback.",
      ].join("\n"),
    );

    const result = await scanSkillEnvironment({
      registry: registry([
        createRegistrySkill(skillPath, {
          id: "metadata-id",
          capability_summary: "",
        }),
      ]),
      roots: {
        ...emptyRoots(),
        public: [{ path: publicRoot, agents: ["codex"], ownership: "managed" }],
      },
      agentVersions: {},
      now: NOW,
    });
    const skill = result.skills[0];

    assert.equal(
      skill.capabilitySummary,
      "Handles release planning. Turns a release brief into a checked execution plan.",
    );
    assert.deepEqual(skill.version, { current: "2.3.4", kind: "semver", basis: "frontmatter" });
    assert.equal(skill.source.type, "github");
    assert.equal(skill.source.url, "https://github.com/example/skills/tree/main/metadata-skill");
    assert.equal(skill.source.repository, "https://github.com/example/skills.git");
    assert.equal(skill.source.ref, "main");
    assert.match(skill.source.content_digest, /^[0-9a-f]{64}$/);
  });
});

test("keeps non-empty registry metadata ahead of file fallbacks and preserves null missing values", async () => {
  await withTempTree(async (root) => {
    const publicRoot = join(root, "public");
    const preferredPath = await createSkill(
      publicRoot,
      "preferred",
      "---\ndescription: File capability\nversion: 9.9.9\nsource: https://example.test/file\n---\n\nFile paragraph.\n",
    );
    const missingPath = await createSkill(publicRoot, "missing-values", "# Missing Values\n");
    const registrySource = {
      type: "git",
      url: "https://example.test/registry",
      repository: "https://example.test/registry.git",
      subpath: null,
      ref: "stable",
      revision: null,
      content_digest: null,
    };

    const result = await scanSkillEnvironment({
      registry: registry([
        createRegistrySkill(preferredPath, {
          id: "preferred-id",
          capability_summary: "Registry capability",
          scope: { level: "agent", agent: "claude", project_root: null },
          source: registrySource,
          version: { current: "1.0.0", kind: "semver", basis: "manifest" },
        }),
        createRegistrySkill(missingPath, {
          id: "missing-id",
          capability_summary: "",
        }),
      ]),
      roots: {
        ...emptyRoots(),
        public: [{ path: publicRoot, agents: ["codex"], ownership: "managed" }],
      },
      agentVersions: {},
      now: NOW,
    });

    const preferred = result.skills.find((skill) => skill.id === "preferred-id");
    assert.equal(preferred.capabilitySummary, "Registry capability");
    assert.deepEqual(preferred.scope, { level: "agent", agent: "claude", project_root: null });
    assert.deepEqual(preferred.version, { current: "1.0.0", kind: "semver", basis: "manifest" });
    assert.deepEqual(preferred.source, registrySource);

    const missing = result.skills.find((skill) => skill.id === "missing-id");
    assert.equal(missing.capabilitySummary, "");
    assert.equal(missing.version.current, null);
    assert.equal(missing.source.url, null);
    assert.equal(missing.source.repository, null);
  });
});

test("adapts public, agent, project, system, and plugin roots without recursive discovery", async () => {
  await withTempTree(async (root) => {
    const projectRoot = join(root, "workspace");
    const rootDescriptors = {
      public: [{ path: join(root, "public"), agents: ["codex", "claude"], ownership: "adopted" }],
      agent: [{ path: join(root, "agent"), agent: "opencode", ownership: "adopted" }],
      project: [{ path: join(projectRoot, ".agents", "skills"), projectRoot, agents: ["codex", "antigravity"], ownership: "adopted" }],
      system: [{ path: join(root, "system"), agent: "claude", ownership: "system" }],
      plugin: [{ path: join(root, "plugin"), agent: "codex", pluginName: "example-plugin", ownership: "plugin" }],
    };
    for (const [kind, descriptors] of Object.entries(rootDescriptors)) {
      await createSkill(descriptors[0].path, `${kind}-skill`);
    }

    const result = await scanSkillEnvironment({
      registry: registry(),
      roots: rootDescriptors,
      agentVersions: {},
      now: NOW,
    });

    assert.equal(result.skills.length, 5);
    assert.deepEqual(result.skills.find((skill) => skill.name === "public-skill").scope, {
      level: "public", agent: null, project_root: null,
    });
    assert.deepEqual(result.skills.find((skill) => skill.name === "agent-skill").scope, {
      level: "agent", agent: "opencode", project_root: null,
    });
    assert.deepEqual(result.skills.find((skill) => skill.name === "project-skill").scope, {
      level: "project", agent: null, project_root: projectRoot,
    });
    assert.equal(result.skills.find((skill) => skill.name === "system-skill").ownership, "system");
    const pluginSkill = result.skills.find((skill) => skill.name === "plugin-skill");
    assert.equal(pluginSkill.ownership, "plugin");
    assert.equal(pluginSkill.source.type, "plugin");
    assert.equal(pluginSkill.source.subpath, "example-plugin");
  });
});

test("reports invalid frontmatter, broken registry routes, and incompatible Claude versions without mutation", async () => {
  await withTempTree(async (root) => {
    const publicRoot = join(root, "public");
    const skillPath = await createSkill(
      publicRoot,
      "invalid-metadata",
      "---\nname: [unterminated\n---\n\n# Still a Skill\n",
    );
    const missingRoute = join(root, "claude", "invalid-metadata");
    const result = await scanSkillEnvironment({
      registry: registry([
        createRegistrySkill(skillPath, {
          id: "invalid-id",
          install: {
            canonical_path: skillPath,
            skill_md_path: join(skillPath, "SKILL.md"),
            routes: [missingRoute],
          },
        }),
      ]),
      roots: {
        ...emptyRoots(),
        public: [{ path: publicRoot, agents: ["codex"], ownership: "managed" }],
      },
      agentVersions: { claude: "2.1.178" },
      now: NOW,
    });

    assert.equal(result.skills.length, 1);
    assert.equal(diagnostic(result, "invalid_frontmatter").skillId, "invalid-id");
    assert.equal(diagnostic(result, "broken_route").path, missingRoute);
    assert.deepEqual(diagnostic(result, "agent_version_incompatible"), {
      code: "agent_version_incompatible",
      severity: "warning",
      message: "Claude Code 2.1.178 does not support per-skill routes; 2.1.203 or newer is required",
      skillId: null,
      path: null,
      agent: "claude",
      details: { currentVersion: "2.1.178", minimumVersion: "2.1.203" },
    });
  });
});

test("readSkillDocument returns complete UTF-8 text and rejects files over 2 MiB", async () => {
  await withTempTree(async (root) => {
    const normalPath = join(root, "normal.md");
    const content = "技能内容：完整读取。\n";
    await writeFile(normalPath, content, "utf8");
    assert.deepEqual(
      await readSkillDocument({ skillMdPath: normalPath }),
      { content, byteSize: Buffer.byteLength(content) },
    );

    const oversizedPath = join(root, "oversized.md");
    await writeFile(oversizedPath, Buffer.alloc(2 * 1024 * 1024 + 1, 0x61));
    await assert.rejects(
      readSkillDocument({ skillMdPath: oversizedPath }),
      (error) => {
        assert.ok(error instanceof SkillDocumentTooLargeError);
        assert.equal(error.code, "SKILL_DOCUMENT_TOO_LARGE");
        assert.equal(error.path, oversizedPath);
        assert.equal(error.byteSize, 2 * 1024 * 1024 + 1);
        assert.equal(error.maxBytes, 2 * 1024 * 1024);
        return true;
      },
    );
  });
});

test("requires all five classified root arrays", async () => {
  await assert.rejects(
    scanSkillEnvironment({ registry: registry(), roots: { public: [] }, agentVersions: {} }),
    /roots\.agent must be an array/i,
  );
});

test("rejects malformed root descriptors", async () => {
  await assert.rejects(
    scanSkillEnvironment({
      registry: registry(),
      roots: { ...emptyRoots(), public: [{ path: "/tmp", agents: "codex", ownership: "managed" }] },
      agentVersions: {},
    }),
    /roots\.public/i,
  );
});

test("ignores known infrastructure directories in skill roots", async () => {
  await withTempTree(async (root) => {
    const publicRoot = join(root, "public");
    await createSkill(publicRoot, "valid-skill");
    for (const name of [".codex-system", ".governance", ".omo", ".sisyphus", ".system"]) {
      await mkdir(join(publicRoot, name), { recursive: true });
    }

    const result = await scanSkillEnvironment({
      registry: registry(),
      roots: { ...emptyRoots(), public: [{ path: publicRoot, agents: ["codex"], ownership: "managed" }] },
      agentVersions: {},
    });

    assert.equal(result.skills.length, 1);
    assert.equal(result.diagnostics.some((item) => item.code === "missing_skill_md"), false);
  });
});

test("isolates an unreadable or oversized skill document from the rest of the inventory", async () => {
  await withTempTree(async (root) => {
    const publicRoot = join(root, "public");
    await createSkill(publicRoot, "valid-skill");
    const oversized = join(publicRoot, "oversized");
    await mkdir(oversized, { recursive: true });
    await writeFile(join(oversized, "SKILL.md"), Buffer.alloc(2 * 1024 * 1024 + 1, 0x61));

    const result = await scanSkillEnvironment({
      registry: registry(),
      roots: { ...emptyRoots(), public: [{ path: publicRoot, agents: ["codex"], ownership: "managed" }] },
      agentVersions: {},
    });

    assert.deepEqual(result.skills.map((skill) => skill.name), ["valid-skill"]);
    assert.equal(diagnostic(result, "skill_document_error").details.code, "SKILL_DOCUMENT_TOO_LARGE");
  });
});

test("isolates a root entry that becomes inaccessible during discovery", async () => {
  await withTempTree(async (root) => {
    const publicRoot = join(root, "public");
    await createSkill(publicRoot, "healthy-skill");
    const restricted = await createSkill(publicRoot, "restricted-skill");
    await chmod(restricted, 0o000);
    try {
      const result = await scanSkillEnvironment({
        registry: registry([createRegistrySkill(restricted)]),
        roots: { ...emptyRoots(), public: [{ path: publicRoot, agents: ["codex"], ownership: "managed" }] },
        agentVersions: {},
      });
      assert.deepEqual(result.skills.map((skill) => skill.name), ["healthy-skill"]);
      assert.ok(result.diagnostics.some((item) => item.code === "skill_access_error"));
    } finally {
      await chmod(restricted, 0o700);
    }
  });
});

test("does not accept a canonical directory itself as a route", async () => {
  await withTempTree(async (root) => {
    const publicRoot = join(root, "public");
    const skillPath = await createSkill(publicRoot, "route-check");
    const result = await scanSkillEnvironment({
      registry: registry([createRegistrySkill(skillPath, {
        install: { canonical_path: skillPath, skill_md_path: join(skillPath, "SKILL.md"), routes: [skillPath] },
      })]),
      roots: { ...emptyRoots(), public: [{ path: publicRoot, agents: ["codex"], ownership: "managed" }] },
      agentVersions: {},
    });

    assert.deepEqual(result.skills[0].routes, []);
    assert.equal(diagnostic(result, "broken_route").path, skillPath);
  });
});

test("does not follow a project Skill symlink outside its project root", async () => {
  await withTempTree(async (root) => {
    const projectRoot = join(root, "project");
    const projectSkills = join(projectRoot, ".agents", "skills");
    const outside = await createSkill(join(root, "outside"), "escaped");
    await mkdir(projectSkills, { recursive: true });
    await symlink(outside, join(projectSkills, "escaped"));
    const result = await scanSkillEnvironment({ roots: { ...emptyRoots(), project: [{ path: projectSkills, projectRoot, agents: ["codex"], ownership: "managed" }] } });
    assert.equal(result.skills.length, 0);
    assert.equal(diagnostic(result, "project_skill_symlink")?.severity, "warning");
  });
});

test("uses manifest and git facts when registry facts are missing", async () => {
  await withTempTree(async (root) => {
    const publicRoot = join(root, "public");
    const skillPath = await createSkill(publicRoot, "git-skill", "---\nname: git-skill\n---\nbody");
    await writeFile(join(skillPath, "package.json"), JSON.stringify({ version: "3.2.1" }));
    execSync("git init && git config user.email test@example.com && git config user.name Test && git add . && git commit -m init && git remote add origin https://github.com/owner/git-skill.git", {
      cwd: skillPath, stdio: "ignore", shell: true,
    });
    const result = await scanSkillEnvironment({
      registry: registry([createRegistrySkill(skillPath)]),
      roots: { ...emptyRoots(), public: [{ path: publicRoot, agents: ["codex"], ownership: "managed" }] },
      agentVersions: {},
    });
    assert.deepEqual(result.skills[0].version, { current: "3.2.1", kind: "semver", basis: "manifest" });
    assert.equal(result.skills[0].source.url, "https://github.com/owner/git-skill");
  });
});
