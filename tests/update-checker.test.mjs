import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, rm, mkdtemp, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

import {
  resolveInstalledVersion,
  resolveSourceMetadata,
  computeDirectoryDigest,
} from "../scripts/lib/source.mjs";

import {
  checkSkillUpdate,
  checkRegistryUpdates,
} from "../scripts/lib/update-checker.mjs";

// ── helpers ──────────────────────────────────────────────────────────

async function makeTempDir() {
  return mkdtemp(join(tmpdir(), "scp-uc-test-"));
}

function writeSkillMd(dir, content) {
  return writeFile(join(dir, "SKILL.md"), content, "utf8");
}

function writePackageJson(dir, obj) {
  return writeFile(join(dir, "package.json"), JSON.stringify(obj, null, 2), "utf8");
}

async function initGitRepo(dir) {
  execSync("git init", { cwd: dir, stdio: "ignore" });
  execSync("git config user.email test@test.com", { cwd: dir, stdio: "ignore" });
  execSync("git config user.name Test", { cwd: dir, stdio: "ignore" });
}

async function gitAddCommit(dir, message = "init") {
  execSync("git add -A", { cwd: dir, stdio: "ignore" });
  execSync(`git commit --allow-empty -m "${message}"`, { cwd: dir, stdio: "ignore" });
}

function gitCommitSha(dir) {
  return execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf8" }).trim();
}

function gitAddTag(dir, tag) {
  execSync(`git tag ${tag}`, { cwd: dir, stdio: "ignore" });
}

// ── resolveInstalledVersion ──────────────────────────────────────────

describe("resolveInstalledVersion", () => {
  let root;

  beforeEach(async () => {
    root = await makeTempDir();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("returns semver from SKILL.md frontmatter", async () => {
    await writeSkillMd(root, "---\nname: test\nversion: 1.2.3\n---\nBody");
    const result = await resolveInstalledVersion(root);
    assert.equal(result.current, "1.2.3");
    assert.equal(result.kind, "semver");
    assert.equal(result.basis, "frontmatter");
  });

  it("returns tag from non-semver frontmatter version", async () => {
    await writeSkillMd(root, "---\nname: test\nversion: beta-2\n---\nBody");
    const result = await resolveInstalledVersion(root);
    assert.equal(result.current, "beta-2");
    assert.equal(result.kind, "tag");
    assert.equal(result.basis, "frontmatter");
  });

  it("returns semver with v prefix from frontmatter", async () => {
    await writeSkillMd(root, "---\nname: test\nversion: v2.0.1\n---\nBody");
    const result = await resolveInstalledVersion(root);
    assert.equal(result.current, "v2.0.1");
    assert.equal(result.kind, "semver");
    assert.equal(result.basis, "frontmatter");
  });

  it("falls back to package.json version", async () => {
    await writeSkillMd(root, "---\nname: test\n---\nBody");
    await writePackageJson(root, { name: "test", version: "3.0.0" });
    const result = await resolveInstalledVersion(root);
    assert.equal(result.current, "3.0.0");
    assert.equal(result.kind, "semver");
    assert.equal(result.basis, "manifest");
  });

  it("falls back to git tag", async () => {
    await writeSkillMd(root, "---\nname: test\n---\nBody");
    await initGitRepo(root);
    await gitAddCommit(root, "init");
    gitAddTag(root, "v1.0.0");
    const result = await resolveInstalledVersion(root);
    assert.equal(result.current, "v1.0.0");
    assert.equal(result.kind, "semver");
    assert.equal(result.basis, "git_tag");
  });

  it("falls back to git commit SHA", async () => {
    await writeSkillMd(root, "---\nname: test\n---\nBody");
    await initGitRepo(root);
    await gitAddCommit(root, "init");
    const sha = gitCommitSha(root);
    const result = await resolveInstalledVersion(root);
    assert.equal(result.current, sha);
    assert.equal(result.kind, "commit");
    assert.equal(result.basis, "git_commit");
  });

  it("returns null/unknown/unknown when nothing is available", async () => {
    await writeSkillMd(root, "---\nname: test\n---\nBody");
    const result = await resolveInstalledVersion(root);
    assert.equal(result.current, null);
    assert.equal(result.kind, "unknown");
    assert.equal(result.basis, "unknown");
  });

  it("treats empty string version as missing", async () => {
    await writeSkillMd(root, '---\nname: test\nversion: ""\n---\nBody');
    const result = await resolveInstalledVersion(root);
    assert.equal(result.current, null);
    assert.equal(result.kind, "unknown");
    assert.equal(result.basis, "unknown");
  });

  it("prefers frontmatter over package.json and git", async () => {
    await writeSkillMd(root, "---\nname: test\nversion: 1.0.0\n---\nBody");
    await writePackageJson(root, { name: "test", version: "2.0.0" });
    await initGitRepo(root);
    await gitAddCommit(root, "init");
    gitAddTag(root, "v3.0.0");
    const result = await resolveInstalledVersion(root);
    assert.equal(result.current, "1.0.0");
    assert.equal(result.basis, "frontmatter");
  });
});

// ── resolveSourceMetadata ────────────────────────────────────────────

describe("resolveSourceMetadata", () => {
  let root;

  beforeEach(async () => {
    root = await makeTempDir();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("extracts GitHub HTTPS URL from frontmatter", async () => {
    await writeSkillMd(root, "---\nname: test\nsource: https://github.com/owner/repo\n---\n");
    const result = await resolveSourceMetadata(root);
    assert.equal(result.type, "github");
    assert.equal(result.url, "https://github.com/owner/repo");
  });

  it("normalizes GitHub URL with .git suffix", async () => {
    await writeSkillMd(root, "---\nname: test\nsource: https://github.com/owner/repo.git\n---\n");
    const result = await resolveSourceMetadata(root);
    assert.equal(result.type, "github");
    assert.equal(result.url, "https://github.com/owner/repo");
  });

  it("normalizes git@ SSH URL to HTTPS", async () => {
    await writeSkillMd(root, "---\nname: test\nsource: git@github.com:owner/repo.git\n---\n");
    const result = await resolveSourceMetadata(root);
    assert.equal(result.type, "github");
    assert.equal(result.url, "https://github.com/owner/repo");
  });

  it("extracts source object with subpath and ref", async () => {
    const fm = [
      "---",
      "name: test",
      "source:",
      "  url: https://github.com/owner/monorepo",
      "  subpath: packages/skill-a",
      "  ref: main",
      "---",
    ].join("\n");
    await writeSkillMd(root, fm);
    const result = await resolveSourceMetadata(root);
    assert.equal(result.type, "github");
    assert.equal(result.url, "https://github.com/owner/monorepo");
    assert.equal(result.subpath, "packages/skill-a");
    assert.equal(result.ref, "main");
  });

  it("falls back to git remote origin", async () => {
    await writeSkillMd(root, "---\nname: test\n---\n");
    await initGitRepo(root);
    await gitAddCommit(root, "init");
    execSync("git remote add origin https://github.com/owner/from-remote.git", {
      cwd: root,
      stdio: "ignore",
    });
    const result = await resolveSourceMetadata(root);
    assert.equal(result.type, "github");
    assert.equal(result.url, "https://github.com/owner/from-remote");
  });

  it("derives repository subpath and revision from a parent git repository", async () => {
    const skillDir = join(root, "skills", "nested");
    await mkdir(skillDir, { recursive: true });
    await writeSkillMd(skillDir, "---\nname: nested\n---\nbody");
    await initGitRepo(root);
    await gitAddCommit(root, "nested skill");
    execSync("git remote add origin https://github.com/owner/monorepo.git", { cwd: root, stdio: "ignore" });
    const result = await resolveSourceMetadata(skillDir);
    assert.equal(result.url, "https://github.com/owner/monorepo");
    assert.equal(result.subpath, "skills/nested");
    assert.match(result.revision, /^[0-9a-f]{40}$/);
  });

  it("recognizes a nested metadata homepage as a source", async () => {
    await writeSkillMd(root, [
      "---", "name: metadata-source", "metadata:", "  openclaw:",
      "    homepage: https://github.com/owner/metadata-source#skill", "---", "body",
    ].join("\n"));
    const result = await resolveSourceMetadata(root);
    assert.equal(result.type, "github");
    assert.equal(result.url, "https://github.com/owner/metadata-source");
  });

  it("falls back to package.json repository", async () => {
    await writeSkillMd(root, "---\nname: test\n---\n");
    await writePackageJson(root, {
      name: "test",
      repository: { type: "git", url: "https://github.com/owner/pkg-repo.git" },
    });
    const result = await resolveSourceMetadata(root);
    assert.equal(result.type, "github");
    assert.equal(result.url, "https://github.com/owner/pkg-repo");
  });

  it("returns local type for non-git directory without source", async () => {
    await writeSkillMd(root, "---\nname: test\n---\n");
    const result = await resolveSourceMetadata(root);
    assert.equal(result.type, "local");
    assert.equal(result.url, null);
  });

  it("returns unknown for missing SKILL.md", async () => {
    const result = await resolveSourceMetadata(root);
    assert.equal(result.type, "unknown");
  });
});

// ── computeDirectoryDigest ───────────────────────────────────────────

describe("computeDirectoryDigest", () => {
  let root;

  beforeEach(async () => {
    root = await makeTempDir();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("produces deterministic hex digest", async () => {
    await writeFile(join(root, "a.txt"), "hello", "utf8");
    await writeFile(join(root, "b.txt"), "world", "utf8");
    const d1 = await computeDirectoryDigest(root);
    const d2 = await computeDirectoryDigest(root);
    assert.equal(d1, d2);
    assert.match(d1, /^[0-9a-f]{64}$/);
  });

  it("ignores .git, .DS_Store, and node_modules", async () => {
    await writeFile(join(root, "a.txt"), "content", "utf8");
    const d1 = await computeDirectoryDigest(root);

    await mkdir(join(root, ".git"), { recursive: true });
    await writeFile(join(root, ".git", "config"), "gitdata", "utf8");
    await writeFile(join(root, ".DS_Store"), "dsstore", "utf8");
    await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(root, "node_modules", "pkg", "index.js"), "x", "utf8");

    const d2 = await computeDirectoryDigest(root);
    assert.equal(d1, d2);
  });

  it("ignores generated Python cache directories and files", async () => {
    await writeFile(join(root, "a.txt"), "content", "utf8");
    const d1 = await computeDirectoryDigest(root);

    await mkdir(join(root, "__pycache__"), { recursive: true });
    await writeFile(join(root, "__pycache__", "module.cpython-312.pyc"), "cache", "utf8");
    await writeFile(join(root, "legacy.pyc"), "cache", "utf8");

    const d2 = await computeDirectoryDigest(root);
    assert.equal(d1, d2);
  });

  it("changes when file content changes", async () => {
    await writeFile(join(root, "a.txt"), "v1", "utf8");
    const d1 = await computeDirectoryDigest(root);
    await writeFile(join(root, "a.txt"), "v2", "utf8");
    const d2 = await computeDirectoryDigest(root);
    assert.notEqual(d1, d2);
  });

  it("changes when a file is added", async () => {
    await writeFile(join(root, "a.txt"), "v1", "utf8");
    const d1 = await computeDirectoryDigest(root);
    await writeFile(join(root, "b.txt"), "v1", "utf8");
    const d2 = await computeDirectoryDigest(root);
    assert.notEqual(d1, d2);
  });
});

// ── checkSkillUpdate ─────────────────────────────────────────────────

describe("checkSkillUpdate", () => {
  let tempRoot;
  const fixedNow = "2026-07-10T00:00:00.000Z";

  beforeEach(async () => {
    tempRoot = await makeTempDir();
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("returns not_checkable for local source", async () => {
    const skill = {
      id: "s1",
      name: "local-skill",
      source: { type: "local", url: null, repository: null, subpath: null, ref: null, revision: null, content_digest: null },
      install: { canonical_path: "/fake" },
    };
    const result = await checkSkillUpdate(skill, { tempRoot, now: fixedNow });
    assert.equal(result.status, "not_checkable");
    assert.equal(result.checked_at, fixedNow);
    assert.equal(result.error, null);
  });

  it("returns not_checkable for unknown source", async () => {
    const skill = {
      id: "s2",
      name: "unknown-skill",
      source: { type: "unknown", url: null, repository: null, subpath: null, ref: null, revision: null, content_digest: null },
      install: { canonical_path: "/fake" },
    };
    const result = await checkSkillUpdate(skill, { tempRoot, now: fixedNow });
    assert.equal(result.status, "not_checkable");
  });

  it("returns not_checkable for plugin source", async () => {
    const skill = {
      id: "s3",
      name: "plugin-skill",
      source: { type: "plugin", url: null, repository: null, subpath: null, ref: null, revision: null, content_digest: null },
      install: { canonical_path: "/fake" },
    };
    const result = await checkSkillUpdate(skill, { tempRoot, now: fixedNow });
    assert.equal(result.status, "not_checkable");
  });

  it("returns up_to_date when digests match", async () => {
    const skillDir = await makeTempDir();
    await writeSkillMd(skillDir, "---\nname: test\n---\ncontent");
    const digest = await computeDirectoryDigest(skillDir);

    const mockRunGit = async (args, opts) => {
      // Simulate clone by copying content to checkout dir
      const checkoutDir = args[args.indexOf("--") + 1] || opts.cwd;
      // For ls-remote, return the ref
      if (args[0] === "ls-remote") return "abc123\trefs/heads/main\n";
      // For clone, simulate the remote having the same content
      if (args[0] === "clone") {
        const targetDir = args[args.length - 1];
        await mkdir(targetDir, { recursive: true });
        await writeSkillMd(targetDir, "---\nname: test\n---\ncontent");
        return "";
      }
      return "";
    };

    const skill = {
      id: "s4",
      name: "up-to-date-skill",
      source: { type: "github", url: "https://github.com/o/r", repository: null, subpath: null, ref: "main", revision: null, content_digest: digest },
      install: { canonical_path: skillDir },
    };

    const result = await checkSkillUpdate(skill, {
      tempRoot,
      now: fixedNow,
      runGit: mockRunGit,
    });
    assert.equal(result.status, "up_to_date");
    await rm(skillDir, { recursive: true, force: true });
  });

  it("returns update_available when digests differ", async () => {
    const skillDir = await makeTempDir();
    await writeSkillMd(skillDir, "---\nname: test\n---\nold-content");
    const digest = await computeDirectoryDigest(skillDir);

    const mockRunGit = async (args) => {
      if (args[0] === "ls-remote") return "abc123\trefs/heads/main\n";
      if (args[0] === "clone") {
        const targetDir = args[args.length - 1];
        await mkdir(targetDir, { recursive: true });
        await writeSkillMd(targetDir, "---\nname: test\n---\nnew-content");
        return "";
      }
      return "";
    };

    const skill = {
      id: "s5",
      name: "outdated-skill",
      source: { type: "github", url: "https://github.com/o/r", repository: null, subpath: null, ref: "main", revision: null, content_digest: digest },
      install: { canonical_path: skillDir },
    };

    const result = await checkSkillUpdate(skill, {
      tempRoot,
      now: fixedNow,
      runGit: mockRunGit,
    });
    assert.equal(result.status, "update_available");
    assert.ok(result.latest);
    await rm(skillDir, { recursive: true, force: true });
  });

  it("returns error when git fails", async () => {
    const mockRunGit = async () => {
      throw new Error("git clone failed: network error");
    };

    const skill = {
      id: "s6",
      name: "error-skill",
      source: { type: "github", url: "https://github.com/o/r", repository: null, subpath: null, ref: "main", revision: null, content_digest: "abc" },
      install: { canonical_path: "/fake" },
    };

    const result = await checkSkillUpdate(skill, {
      tempRoot,
      now: fixedNow,
      runGit: mockRunGit,
    });
    assert.equal(result.status, "error");
    assert.ok(result.error);
    assert.match(result.error, /network error/);
  });

  it("always cleans temp directory even on failure", async () => {
    const mockRunGit = async (args) => {
      if (args[0] === "clone") {
        const targetDir = args[args.length - 1];
        await mkdir(targetDir, { recursive: true });
        await writeFile(join(targetDir, "leftover"), "data", "utf8");
        throw new Error("deliberate failure");
      }
      return "";
    };

    const skill = {
      id: "s7",
      name: "cleanup-skill",
      source: { type: "git", url: "https://example.com/repo.git", repository: null, subpath: null, ref: "main", revision: null, content_digest: "abc" },
      install: { canonical_path: "/fake" },
    };

    await checkSkillUpdate(skill, { tempRoot, now: fixedNow, runGit: mockRunGit });

    // tempRoot should be empty or only contain the tempRoot dir itself
    const remaining = await readdir(tempRoot);
    assert.equal(remaining.length, 0, "Temp directory should be cleaned up");
  });

  it("handles subpath correctly - only compares subpath content", async () => {
    const skillDir = await makeTempDir();
    await writeSkillMd(skillDir, "---\nname: test\n---\nskill content");
    const digest = await computeDirectoryDigest(skillDir);

    const mockRunGit = async (args) => {
      if (args[0] === "ls-remote") return "abc123\trefs/heads/main\n";
      if (args[0] === "clone") {
        const targetDir = args[args.length - 1];
        // Create monorepo with different subpath content
        const subDir = join(targetDir, "skills", "my-skill");
        await mkdir(subDir, { recursive: true });
        await writeSkillMd(subDir, "---\nname: test\n---\nupdated skill content");
        // Also create unrelated dirs
        const otherDir = join(targetDir, "skills", "other");
        await mkdir(otherDir, { recursive: true });
        await writeFile(join(otherDir, "README.md"), "other", "utf8");
        return "";
      }
      return "";
    };

    const skill = {
      id: "s8",
      name: "subpath-skill",
      source: { type: "github", url: "https://github.com/o/monorepo", repository: null, subpath: "skills/my-skill", ref: "main", revision: null, content_digest: digest },
      install: { canonical_path: skillDir },
    };

    const result = await checkSkillUpdate(skill, {
      tempRoot,
      now: fixedNow,
      runGit: mockRunGit,
    });
    assert.equal(result.status, "update_available");
    await rm(skillDir, { recursive: true, force: true });
  });

  it("rejects a repository subpath that escapes the temporary checkout", async () => {
    let gitCalls = 0;
    const skill = {
      id: "escape-subpath",
      name: "escape-subpath",
      source: { type: "github", url: "https://github.com/o/r", repository: null, subpath: "../../../etc", ref: "main", revision: null, content_digest: "abc" },
      install: { canonical_path: "/fake" },
    };
    const result = await checkSkillUpdate(skill, {
      tempRoot,
      now: fixedNow,
      runGit: async () => { gitCalls += 1; return ""; },
    });
    assert.equal(result.status, "error");
    assert.match(result.error, /outside managed root/i);
    assert.equal(gitCalls, 0);
  });

  it("clones repository rather than a display URL", async () => {
    const skillDir = await makeTempDir();
    await writeSkillMd(skillDir, "body");
    const calls = [];
    const skill = {
      id: "repo-priority",
      name: "repo-priority",
      source: {
        type: "github",
        url: "https://github.com/o/r/tree/main/skills/example",
        repository: "https://github.com/o/r",
        subpath: null, ref: "main", revision: null, content_digest: null,
      },
      install: { canonical_path: skillDir },
    };
    await checkSkillUpdate(skill, {
      tempRoot,
      now: fixedNow,
      runGit: async (args) => {
        calls.push(args);
        if (args[0] === "clone") {
          await mkdir(args.at(-1), { recursive: true });
          await writeSkillMd(args.at(-1), "body");
        }
        return args[0] === "rev-parse" ? "abc123\n" : "";
      },
    });
    assert.ok(calls[0].includes("https://github.com/o/r"));
    assert.equal(calls[0].includes("https://github.com/o/r/tree/main/skills/example"), false);
    await rm(skillDir, { recursive: true, force: true });
  });

  it("recomputes the current local digest instead of trusting the registry snapshot", async () => {
    const skillDir = await makeTempDir();
    await writeSkillMd(skillDir, "remote-version");
    const oldDigest = await computeDirectoryDigest(skillDir);
    await writeSkillMd(skillDir, "locally-modified");
    const skill = {
      id: "local-change",
      name: "local-change",
      source: { type: "github", url: "https://github.com/o/r", repository: null, subpath: null, ref: "main", revision: null, content_digest: oldDigest },
      install: { canonical_path: skillDir },
    };
    const result = await checkSkillUpdate(skill, {
      tempRoot,
      now: fixedNow,
      runGit: async (args) => {
        if (args[0] === "clone") {
          await mkdir(args.at(-1), { recursive: true });
          await writeSkillMd(args.at(-1), "remote-version");
        }
        return args[0] === "rev-parse" ? "abc123\n" : "";
      },
    });
    assert.equal(result.status, "update_available");
    await rm(skillDir, { recursive: true, force: true });
  });
});

// ── checkRegistryUpdates ─────────────────────────────────────────────

describe("checkRegistryUpdates", () => {
  let tempRoot;
  const fixedNow = "2026-07-10T00:00:00.000Z";

  beforeEach(async () => {
    tempRoot = await makeTempDir();
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("processes all active skills and skips removed ones", async () => {
    const registry = {
      schemaVersion: 1,
      updatedAt: null,
      skills: [
        {
          id: "active-1",
          name: "active",
          lifecycle: "active",
          ownership: "managed",
          capability_summary: "",
          scope: { level: "public", agent: null, project_root: null },
          install: { canonical_path: "/fake1", skill_md_path: "/fake1/SKILL.md", routes: [] },
          source: { type: "local", url: null, repository: null, subpath: null, ref: null, revision: null, content_digest: null },
          version: { current: null, kind: "unknown", basis: "unknown" },
          update: { status: "unknown", latest: null, checked_at: null, error: null },
          installed_at: null,
          updated_at: null,
        },
        {
          id: "removed-1",
          name: "removed",
          lifecycle: "removed",
          ownership: "managed",
          capability_summary: "",
          scope: { level: "public", agent: null, project_root: null },
          install: { canonical_path: "/fake2", skill_md_path: "/fake2/SKILL.md", routes: [] },
          source: { type: "github", url: "https://github.com/o/r", repository: null, subpath: null, ref: null, revision: null, content_digest: null },
          version: { current: null, kind: "unknown", basis: "unknown" },
          update: { status: "unknown", latest: null, checked_at: null, error: null },
          installed_at: null,
          updated_at: null,
        },
      ],
    };

    const result = await checkRegistryUpdates(registry, {
      tempRoot,
      now: fixedNow,
    });

    assert.ok(result.registry);
    assert.ok(Array.isArray(result.events));
    // active-1 is local so not_checkable, removed-1 should be skipped
    const active = result.registry.skills.find((s) => s.id === "active-1");
    const removed = result.registry.skills.find((s) => s.id === "removed-1");
    assert.equal(active.update.status, "not_checkable");
    // removed skill's update should not have been touched
    assert.equal(removed.update.status, "unknown");
    // Should have 1 event for active-1 only
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0].skillId, "active-1");
    assert.equal(result.events[0].action, "update_check");
  });

  it("preserves the last successful status when a later check fails", async () => {
    const skill = {
      id: "active-1", name: "active", lifecycle: "active", ownership: "managed",
      capability_summary: "", scope: { level: "public", agent: null, project_root: null },
      install: { canonical_path: "/fake", skill_md_path: "/fake/SKILL.md", routes: [] },
      source: { type: "github", url: "https://example.invalid/repo", repository: null, subpath: null, ref: null, revision: "installed", content_digest: "abc" },
      version: { current: "1.0.0", kind: "semver", basis: "frontmatter" },
      update: { status: "update_available", latest: "remote-revision", checked_at: fixedNow, error: null },
      installed_at: fixedNow, updated_at: fixedNow,
    };
    const result = await checkRegistryUpdates(
      { schemaVersion: 1, updatedAt: fixedNow, skills: [skill] },
      { now: "2026-07-11T00:00:00.000Z", runGit: async () => { throw new Error("network down"); }, tempRoot },
    );
    assert.deepEqual(result.registry.skills[0].update, {
      status: "update_available",
      latest: "remote-revision",
      checked_at: "2026-07-11T00:00:00.000Z",
      error: "network down",
    });
  });
});
