import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, rm, mkdtemp, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createSkillControlServer } from "../scripts/lib/server-app.mjs";

async function makeTempDir() {
  return mkdtemp(join(tmpdir(), "scp-smoke-test-"));
}

describe("live readonly smoke test", () => {
  let root;
  let registryPath;
  let historyPath;
  let publicRoot;
  let serverInstance;

  beforeEach(async () => {
    root = await makeTempDir();
    registryPath = join(root, "skills-registry.yaml");
    historyPath = join(root, "skills-history.jsonl");
    publicRoot = join(root, "public");
    await mkdir(publicRoot, { recursive: true });

    // Create a mock skill
    const skillPath = join(publicRoot, "smoke-skill");
    await mkdir(skillPath, { recursive: true });
    await writeFile(join(skillPath, "SKILL.md"), "---\nname: smoke-skill\n---\nbody", "utf8");

    // Write a base registry
    const registryData = `
schemaVersion: 1
updatedAt: "2026-07-10T00:00:00.000Z"
skills:
  - id: "skill-smoke"
    name: "smoke-skill"
    lifecycle: "active"
    ownership: "managed"
    capability_summary: "Smoke test skill"
    scope:
      level: "public"
      agent: null
      project_root: null
    install:
      canonical_path: "${skillPath}"
      skill_md_path: "${join(skillPath, "SKILL.md")}"
      routes: []
    source:
      type: "local"
      url: null
      repository: null
      subpath: null
      ref: null
      revision: null
      content_digest: null
    version:
      current: "1.0.0"
      kind: "semver"
      basis: "frontmatter"
    update:
      status: "unknown"
      latest: null
      checked_at: null
      error: null
    installed_at: "2026-07-10T00:00:00.000Z"
    updated_at: "2026-07-10T00:00:00.000Z"
`;
    await writeFile(registryPath, registryData, "utf8");
  });

  afterEach(async () => {
    if (serverInstance) {
      await new Promise((resolve) => serverInstance.close(resolve));
    }
    await rm(root, { recursive: true, force: true });
  });

  it("server starts up and does not mutate registry or files on disk", async () => {
    const registryMtimeBefore = (await stat(registryPath)).mtimeMs;
    const skillMdMtimeBefore = (await stat(join(publicRoot, "smoke-skill", "SKILL.md"))).mtimeMs;

    const { server, getScanCache } = createSkillControlServer({
      registryPath,
      historyPath,
      publicRoot,
      roots: {
        public: [{ path: publicRoot, agents: ["claude"], ownership: "managed" }],
        agent: [],
        project: [],
        system: [],
        plugin: [],
      },
    });

    serverInstance = server;
    await new Promise((resolve) => serverInstance.listen(0, "127.0.0.1", resolve));

    // Force a scan
    const scanResult = await getScanCache();
    assert.equal(scanResult.skills.length, 1);

    // Verify mtime has not changed (indicating no write/mutation took place)
    const registryMtimeAfter = (await stat(registryPath)).mtimeMs;
    const skillMdMtimeAfter = (await stat(join(publicRoot, "smoke-skill", "SKILL.md"))).mtimeMs;

    assert.equal(registryMtimeBefore, registryMtimeAfter, "Registry file must not be mutated");
    assert.equal(skillMdMtimeBefore, skillMdMtimeAfter, "Skill source files must not be mutated");
  });
});
