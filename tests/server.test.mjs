import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile, rm, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import http from "node:http";

import { createSkillControlServer } from "../scripts/lib/server-app.mjs";
import { scan as scanSkills } from "../scripts/lib/manager.mjs";

async function makeTempDir() {
  return mkdtemp(join(tmpdir(), "scp-server-test-"));
}

function requestJson(port, path, method = "GET", body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "127.0.0.1",
      port,
      path,
      method,
      headers: {
        "content-type": "application/json",
      },
    };

    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        try {
          const parsed = data ? JSON.parse(data) : null;
          resolve({ status: res.statusCode, body: parsed, headers: res.headers });
        } catch {
          resolve({ status: res.statusCode, body: data, headers: res.headers });
        }
      });
    });

    req.on("error", reject);

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

describe("server-app read-only api", () => {
  let root;
  let registryPath;
  let historyPath;
  let publicRoot;
  let projectRoot;
  let serverInstance;
  let app;
  let port;
  let scanCalls;

  beforeEach(async () => {
    root = await makeTempDir();
    registryPath = join(root, "skills-registry.yaml");
    historyPath = join(root, "skills-history.jsonl");
    publicRoot = join(root, "public");
    projectRoot = join(root, "project");
    await mkdir(publicRoot, { recursive: true });

    // Create a mock skill
    const skillPath = join(publicRoot, "my-skill");
    await mkdir(skillPath, { recursive: true });
    await writeFile(
      join(skillPath, "SKILL.md"),
      "---\nname: my-skill\nversion: 1.0.0\n---\nbody text",
      "utf8",
    );
    const projectSkillPath = join(projectRoot, ".agents", "skills", "my-skill");
    await mkdir(projectSkillPath, { recursive: true });
    await writeFile(join(projectSkillPath, "SKILL.md"), "---\nname: my-skill\nversion: 2.0.0\n---\nproject body text", "utf8");

    // Create registry with the skill
    const registryData = `
schemaVersion: 1
updatedAt: "2026-07-10T00:00:00.000Z"
skills:
  - id: "skill-123"
    name: "my-skill"
    lifecycle: "active"
    ownership: "managed"
    capability_summary: "summary capability"
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
  - id: "skill-project-123"
    name: "my-skill"
    lifecycle: "active"
    ownership: "managed"
    capability_summary: "summary capability"
    scope:
      level: "project"
      agent: null
      project_root: "${projectRoot}"
    install:
      canonical_path: "${projectSkillPath}"
      skill_md_path: "${join(projectSkillPath, "SKILL.md")}"
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
      current: "2.0.0"
      kind: "semver"
      basis: "frontmatter"
    update:
      status: "not_checkable"
      latest: null
      checked_at: null
      error: null
    installed_at: "2026-07-10T00:00:00.000Z"
    updated_at: "2026-07-10T00:00:00.000Z"
`;
    await writeFile(registryPath, registryData, "utf8");

    // Start server on ephemeral port
    scanCalls = 0;
    app = createSkillControlServer({
      hubRoot: false,
      registryPath,
      historyPath,
      publicRoot,
      roots: {
        public: [{ path: publicRoot, agents: [], ownership: "managed" }],
        agent: [],
        project: [{ path: join(projectRoot, ".agents", "skills"), projectRoot, agents: [], ownership: "managed" }],
        system: [],
        plugin: [],
      },
      scanFn: async (options) => {
        scanCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return scanSkills(options);
      },
    });

    serverInstance = app.server;
    await new Promise((resolve) => serverInstance.listen(0, "127.0.0.1", resolve));
    port = serverInstance.address().port;
  });

  afterEach(async () => {
    await new Promise((resolve) => serverInstance.close(resolve));
    await rm(root, { recursive: true, force: true });
  });

  it("GET /api/overview returns summary statistics", async () => {
    const res = await requestJson(port, "/api/overview");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.summary.byAvailability, { shared: 1, codex: 0, claude: 0, antigravity: 0, opencode: 0 });
    assert.ok(res.body.summary);
    assert.equal(res.body.summary.totalSkills, 1);
  });

  it("does not expose wildcard CORS headers", async () => {
    const res = await requestJson(port, "/api/health");
    assert.equal(res.headers["access-control-allow-origin"], undefined);
    assert.equal(res.headers["access-control-allow-methods"], undefined);
  });

  it("shares one in-flight scan across concurrent first requests", async () => {
    const results = await Promise.all([
      requestJson(port, "/api/overview"),
      requestJson(port, "/api/skills"),
      requestJson(port, "/api/diagnostics"),
    ]);
    assert.ok(results.every((result) => result.status === 200));
    assert.equal(scanCalls, 1);
  });

  it("forces a fresh scan even while the cache TTL is current", async () => {
    await requestJson(port, "/api/overview");
    assert.equal(scanCalls, 1);
    await app.refreshSnapshot();
    assert.equal(scanCalls, 2);
  });

  it("GET /api/skills returns skills list", async () => {
    const res = await requestJson(port, "/api/skills");
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.items));
    assert.equal(res.body.items.length, 1);
    assert.match(res.body.items[0].id, /^logical-/);
    assert.deepEqual(res.body.items[0].scopeLevels, ["public", "project"]);
    assert.equal(res.body.items[0].instanceCount, 2);
    assert.equal(res.body.items[0].hasSharedAvailability, true);
    assert.deepEqual(res.body.items[0].agents, []);
    assert.deepEqual(res.body.items[0].availabilityLabels, ["声明共享"]);
  });

  it("adds routed to visibility basis when an instance has governance routes", async () => {
    const res = await requestJson(port, "/api/skills");
    const routed = res.body.items.find((skill) => skill.instances.some((instance) => instance.routes?.length));
    if (routed) assert.ok(routed.visibilityBasis.includes("routed"));
  });

  it("GET /api/skills/:id returns every installation document", async () => {
    const list = await requestJson(port, "/api/skills");
    const logicalId = list.body.items[0].id;
    const res = await requestJson(port, `/api/skills/${logicalId}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.item.id, logicalId);
    assert.deepEqual(res.body.documents.map((item) => item.instanceId), ["skill-123", "skill-project-123"]);
    assert.match(res.body.documents[0].content, /body text/);
    assert.match(res.body.documents[1].content, /project body text/);
  });

  it("GET /api/updates returns updates info", async () => {
    const res = await requestJson(port, "/api/updates");
    assert.equal(res.status, 200);
    assert.ok(res.body.items);
  });

  it("GET /api/diagnostics returns diagnostics lists", async () => {
    const res = await requestJson(port, "/api/diagnostics");
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.diagnostics));
  });

  it("GET /api/history returns history events list", async () => {
    const res = await requestJson(port, "/api/history");
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.items));
  });

  it("GET /api/governance returns registry governance info", async () => {
    const res = await requestJson(port, "/api/governance");
    assert.equal(res.status, 200);
    assert.ok(res.body.registry);
  });

  it("GET /api/health returns ok", async () => {
    const res = await requestJson(port, "/api/health");
    assert.equal(res.status, 200);
    assert.equal(res.body.status, "ok");
  });

  it("exposes read only projects chat functions and translation status", async () => {
    const projects = await requestJson(port, "/api/projects");
    const functions = await requestJson(port, "/api/chat-functions");
    const translations = await requestJson(port, "/api/translations/status");
    assert.equal(projects.status, 200);
    assert.ok(projects.body.items.some((item) => item.path === projectRoot));
    assert.ok(functions.body.items.some((item) => item.name === "project-path-add"));
    assert.equal(translations.body.summary.pending >= 1, true);
  });

  it("rejects every non-GET API method with 405", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      const res = await requestJson(port, "/api/rescan", method)
        .catch((error) => { throw new Error(`${method}: ${error.message}`); });
      assert.equal(res.status, 405, method);
    }
  });

  it("keeps healthy skills available when another document is oversized", async () => {
    const brokenPath = join(publicRoot, "oversized-skill");
    await mkdir(brokenPath, { recursive: true });
    await writeFile(join(brokenPath, "SKILL.md"), Buffer.alloc(2 * 1024 * 1024 + 1, "x"));

    const skills = await requestJson(port, "/api/skills");
    const diagnostics = await requestJson(port, "/api/diagnostics");
    assert.equal(skills.status, 200);
    assert.ok(skills.body.items.some((skill) => skill.instances.some((item) => item.id === "skill-123")));
    assert.ok(diagnostics.body.diagnostics.some((item) => item.code === "skill_document_error"));
  });

  it("configures the live server with registry/history roots instead of dead metadata", async () => {
    const source = await readFile(join(process.cwd(), "scripts", "server.mjs"), "utf8");
    assert.doesNotMatch(source, /METADATA_PATH|metadataPath/);
    assert.match(source, /registryPath:\s*REGISTRY_PATH/);
    assert.match(source, /historyPath:\s*HISTORY_PATH/);
    assert.match(source, /roots:\s*getDefaultRoots\(\)/);
  });
});
