import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  RegistryValidationError,
  readRegistry,
  removeRegistrySkill,
  upsertRegistrySkill,
  writeRegistry,
} from "../scripts/lib/registry.mjs";
import { appendHistoryEvent, appendHistoryEvents, readHistory } from "../scripts/lib/history.mjs";

function createSkill(overrides = {}) {
  return {
    id: "skill-1",
    name: "example-skill",
    lifecycle: "active",
    ownership: "managed",
    capability_summary: "Example capability",
    scope: {
      level: "public",
      agent: null,
      project_root: null,
    },
    install: {
      canonical_path: "/tmp/skills/example-skill",
      skill_md_path: "/tmp/skills/example-skill/SKILL.md",
      routes: ["/tmp/routes/example-skill"],
    },
    source: {
      type: "github",
      url: "https://github.com/example/skills/tree/main/example-skill",
      repository: "https://github.com/example/skills.git",
      subpath: "example-skill",
      ref: "main",
      revision: "abc123",
      content_digest: "sha256:abc123",
    },
    version: {
      current: "1.2.3",
      kind: "semver",
      basis: "frontmatter",
    },
    update: {
      status: "up_to_date",
      latest: "1.2.3",
      checked_at: "2026-07-10T00:00:00.000Z",
      error: null,
    },
    installed_at: "2026-07-09T00:00:00.000Z",
    updated_at: "2026-07-10T00:00:00.000Z",
    ...overrides,
  };
}

async function withTempRegistry(fn) {
  const tempRoot = await mkdtemp(join(tmpdir(), "skill-registry-test-"));
  const registryPath = join(tempRoot, "nested", "skills-registry.yaml");

  try {
    await fn({ registryPath });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function withTempHistory(fn) {
  const tempRoot = await mkdtemp(join(tmpdir(), "skill-history-test-"));
  const historyPath = join(tempRoot, "nested", "skills-history.jsonl");

  try {
    await fn({ historyPath });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

function createHistoryEvent(overrides = {}) {
  return {
    actor: { agent: "codex", sessionId: "session-1" },
    skillId: "skill-1",
    skillName: "example-skill",
    action: "install",
    before: null,
    after: { version: "1.0.0" },
    affectedPaths: ["/tmp/skills/example-skill"],
    result: "success",
    error: null,
    ...overrides,
  };
}

test("missing registry returns the empty schema", async () => {
  await withTempRegistry(async ({ registryPath }) => {
    assert.deepEqual(await readRegistry({ registryPath }), {
      schemaVersion: 1,
      updatedAt: null,
      skills: [],
    });
  });
});

test("registry data round-trips through YAML", async () => {
  await withTempRegistry(async ({ registryPath }) => {
    const registry = {
      schemaVersion: 1,
      updatedAt: "2026-07-10T00:00:00.000Z",
      skills: [createSkill()],
    };

    await writeRegistry(registry, { registryPath });

    assert.deepEqual(await readRegistry({ registryPath }), registry);
  });
});

test("registry accepts the fixed missing-version representation and directory basis", async () => {
  await withTempRegistry(async ({ registryPath }) => {
    const missingVersion = createSkill({
      version: { current: null, kind: "unknown", basis: "unknown" },
    });
    const directoryVersion = createSkill({
      id: "skill-2",
      version: { current: "example-skill", kind: "unknown", basis: "directory" },
    });
    const registry = {
      schemaVersion: 1,
      updatedAt: null,
      skills: [missingVersion, directoryVersion],
    };

    await writeRegistry(registry, { registryPath });

    assert.deepEqual(await readRegistry({ registryPath }), registry);
  });
});

test("registry writes replace a read-only target through a temporary rename", async () => {
  await withTempRegistry(async ({ registryPath }) => {
    const original = {
      schemaVersion: 1,
      updatedAt: null,
      skills: [],
    };
    const replacement = {
      schemaVersion: 1,
      updatedAt: "2026-07-10T01:00:00.000Z",
      skills: [createSkill()],
    };

    await writeRegistry(original, { registryPath });
    await chmod(registryPath, 0o444);
    await writeRegistry(replacement, { registryPath });

    assert.deepEqual(await readRegistry({ registryPath }), replacement);
  });
});

test("invalid registry schema throws RegistryValidationError", async () => {
  await withTempRegistry(async ({ registryPath }) => {
    await assert.rejects(
      writeRegistry({ schemaVersion: 2, updatedAt: null, skills: [] }, { registryPath }),
      RegistryValidationError,
    );
  });
});

test("registry rejects unknown and desired-state fields without persisting them", async (t) => {
  const invalidRegistries = [
    ["top-level desiredState", (registry) => { registry.desiredState = {}; }],
    ["skill desired_version", (registry) => { registry.skills[0].desired_version = "2.0.0"; }],
    ["scope desired_scope", (registry) => { registry.skills[0].scope.desired_scope = "agent"; }],
    ["install unknown field", (registry) => { registry.skills[0].install.mode = "copy"; }],
    ["source unknown field", (registry) => { registry.skills[0].source.credentials = "secret"; }],
    ["version unknown field", (registry) => { registry.skills[0].version.expected = "2.0.0"; }],
    ["update auto_update", (registry) => { registry.skills[0].update.auto_update = true; }],
  ];

  for (const [label, addUnknownField] of invalidRegistries) {
    await t.test(label, async () => {
      await withTempRegistry(async ({ registryPath }) => {
        const registry = {
          schemaVersion: 1,
          updatedAt: null,
          skills: [createSkill()],
        };
        addUnknownField(registry);

        await assert.rejects(
          writeRegistry(registry, { registryPath }),
          RegistryValidationError,
        );
        await assert.rejects(readFile(registryPath, "utf8"), { code: "ENOENT" });
      });
    });
  }
});

test("version.current rejects empty and untrimmed strings", async (t) => {
  for (const current of ["", "   ", " 1.2.3 "]) {
    await t.test(JSON.stringify(current), async () => {
      await withTempRegistry(async ({ registryPath }) => {
        await assert.rejects(
          writeRegistry(
            {
              schemaVersion: 1,
              updatedAt: null,
              skills: [createSkill({ version: { current, kind: "semver", basis: "frontmatter" } })],
            },
            { registryPath },
          ),
          RegistryValidationError,
        );
      });
    });
  }
});

test("registry timestamps require ISO-8601 date-time syntax", async (t) => {
  const invalidRegistries = [
    ["updatedAt year", { updatedAt: "2026" }],
    ["updatedAt locale date", { updatedAt: "7/10/2026" }],
    ["update checked_at", { skill: { update: { ...createSkill().update, checked_at: "2026" } } }],
    ["installed_at", { skill: { installed_at: "July 10, 2026" } }],
    ["updated_at", { skill: { updated_at: "2026-07-10" } }],
  ];

  for (const [label, overrides] of invalidRegistries) {
    await t.test(label, async () => {
      await withTempRegistry(async ({ registryPath }) => {
        const registry = {
          schemaVersion: 1,
          updatedAt: "2026-07-10T00:00:00.000Z",
          skills: [createSkill(overrides.skill)],
          ...("updatedAt" in overrides ? { updatedAt: overrides.updatedAt } : {}),
        };

        await assert.rejects(
          writeRegistry(registry, { registryPath }),
          RegistryValidationError,
        );
      });
    });
  }
});

test("upsertRegistrySkill inserts and replaces a skill by id", async () => {
  await withTempRegistry(async ({ registryPath }) => {
    const inserted = await upsertRegistrySkill(createSkill(), {
      registryPath,
      now: "2026-07-10T01:00:00.000Z",
    });
    const replacedSkill = createSkill({ name: "renamed-skill" });
    const replaced = await upsertRegistrySkill(replacedSkill, {
      registryPath,
      now: "2026-07-10T02:00:00.000Z",
    });

    assert.equal(inserted.skills.length, 1);
    assert.deepEqual(replaced.skills, [replacedSkill]);
    assert.equal(replaced.updatedAt, "2026-07-10T02:00:00.000Z");
    assert.deepEqual(await readRegistry({ registryPath }), replaced);
  });
});

test("removeRegistrySkill deletes a skill by id", async () => {
  await withTempRegistry(async ({ registryPath }) => {
    await writeRegistry(
      {
        schemaVersion: 1,
        updatedAt: null,
        skills: [createSkill(), createSkill({ id: "skill-2", name: "second-skill" })],
      },
      { registryPath },
    );

    const registry = await removeRegistrySkill("skill-1", {
      registryPath,
      now: "2026-07-10T03:00:00.000Z",
    });

    assert.deepEqual(registry.skills.map((skill) => skill.id), ["skill-2"]);
    assert.equal(registry.updatedAt, "2026-07-10T03:00:00.000Z");
    assert.deepEqual(await readRegistry({ registryPath }), registry);
  });
});

test("registry validates enums, scope details, install paths, and routes", async (t) => {
  const invalidSkills = [
    ["lifecycle", createSkill({ lifecycle: "disabled" })],
    ["ownership", createSkill({ ownership: "personal" })],
    ["scope level", createSkill({ scope: { level: "shared", agent: null, project_root: null } })],
    ["agent scope", createSkill({ scope: { level: "agent", agent: null, project_root: null } })],
    ["relative project root", createSkill({ scope: { level: "project", agent: null, project_root: "projects/demo" } })],
    ["source type", createSkill({ source: { ...createSkill().source, type: "npm" } })],
    ["version kind", createSkill({ version: { ...createSkill().version, kind: "branch" } })],
    ["version basis", createSkill({ version: { ...createSkill().version, basis: "filename" } })],
    ["update status", createSkill({ update: { ...createSkill().update, status: "stale" } })],
    ["canonical path", createSkill({ install: { ...createSkill().install, canonical_path: "relative/path" } })],
    ["skill document path", createSkill({ install: { ...createSkill().install, skill_md_path: "SKILL.md" } })],
    ["route path", createSkill({ install: { ...createSkill().install, routes: ["relative/route"] } })],
  ];

  for (const [label, skill] of invalidSkills) {
    await t.test(label, async () => {
      await withTempRegistry(async ({ registryPath }) => {
        await assert.rejects(
          writeRegistry(
            { schemaVersion: 1, updatedAt: null, skills: [skill] },
            { registryPath },
          ),
          RegistryValidationError,
        );
      });
    });
  }
});

test("history appends JSONL events in write order with generated defaults", async () => {
  await withTempHistory(async ({ historyPath }) => {
    const installed = await appendHistoryEvent(createHistoryEvent(), {
      historyPath,
      now: "2026-07-10T01:00:00.000Z",
    });
    const updated = await appendHistoryEvent(
      createHistoryEvent({ action: "update", before: { version: "1.0.0" }, after: { version: "1.1.0" } }),
      { historyPath, now: "2026-07-10T02:00:00.000Z" },
    );
    const lines = (await readFile(historyPath, "utf8")).trim().split("\n").map(JSON.parse);

    assert.deepEqual(lines.map((event) => event.action), ["install", "update"]);
    assert.equal(installed.schemaVersion, 1);
    assert.match(installed.id, /^[0-9a-f-]{36}$/);
    assert.equal(installed.timestamp, "2026-07-10T01:00:00.000Z");
    assert.equal(updated.timestamp, "2026-07-10T02:00:00.000Z");
  });
});

test("history restores its exact previous bytes after a partial append failure", async () => {
  await withTempHistory(async ({ historyPath }) => {
    await mkdir(dirname(historyPath), { recursive: true });
    await writeFile(historyPath, "existing-history\n", "utf8");
    await assert.rejects(
      appendHistoryEvents([createHistoryEvent()], {
        historyPath,
        historyWrite: async (handle, data) => {
          await handle.write(data.subarray(0, 12));
          throw new Error("simulated partial write");
        },
      }),
      /simulated partial write/,
    );
    assert.equal(await readFile(historyPath, "utf8"), "existing-history\n");
  });
});

test("history ignores malformed lines and returns newest events first", async () => {
  await withTempHistory(async ({ historyPath }) => {
    await appendHistoryEvent(createHistoryEvent({ id: "older" }), {
      historyPath,
      now: "2026-07-10T01:00:00.000Z",
    });
    await writeFile(historyPath, `${await readFile(historyPath, "utf8")}not-json\n`, "utf8");
    await appendHistoryEvent(createHistoryEvent({ id: "newer", action: "update" }), {
      historyPath,
      now: "2026-07-10T02:00:00.000Z",
    });

    const history = await readHistory({}, { historyPath });

    assert.deepEqual(history.items.map((event) => event.id), ["newer", "older"]);
    assert.deepEqual(
      { total: history.total, offset: history.offset, limit: history.limit, nextOffset: history.nextOffset },
      { total: 2, offset: 0, limit: 50, nextOffset: null },
    );
  });
});

test("history filters by skill, action, and result before pagination", async () => {
  await withTempHistory(async ({ historyPath }) => {
    const events = [
      createHistoryEvent({ id: "one", action: "install", result: "success" }),
      createHistoryEvent({ id: "two", action: "update", result: "failure" }),
      createHistoryEvent({ id: "three", skillId: "skill-2", action: "update", result: "failure" }),
      createHistoryEvent({ id: "four", action: "update", result: "failure" }),
    ];
    for (const [index, event] of events.entries()) {
      await appendHistoryEvent(event, {
        historyPath,
        now: `2026-07-10T0${index + 1}:00:00.000Z`,
      });
    }

    const firstPage = await readHistory(
      { skillId: "skill-1", action: "update", result: "failure", offset: 0, limit: 1 },
      { historyPath },
    );
    const secondPage = await readHistory(
      { skillId: "skill-1", action: "update", result: "failure", offset: 1, limit: 1 },
      { historyPath },
    );

    assert.deepEqual(firstPage.items.map((event) => event.id), ["four"]);
    assert.deepEqual(
      { total: firstPage.total, nextOffset: firstPage.nextOffset },
      { total: 2, nextOffset: 1 },
    );
    assert.deepEqual(secondPage.items.map((event) => event.id), ["two"]);
    assert.equal(secondPage.nextOffset, null);
  });
});

test("history persists only event fields and removes chat content recursively", async () => {
  await withTempHistory(async ({ historyPath }) => {
    const event = await appendHistoryEvent(
      createHistoryEvent({
        chatText: "secret chat",
        message: "secret message",
        prompt: "secret prompt",
        ignored: "not part of the event contract",
        before: { version: "1.0.0", chatText: "nested secret" },
      }),
      { historyPath, now: "2026-07-10T01:00:00.000Z" },
    );
    const serialized = await readFile(historyPath, "utf8");

    assert.deepEqual(Object.keys(event), [
      "schemaVersion",
      "id",
      "timestamp",
      "actor",
      "skillId",
      "skillName",
      "action",
      "before",
      "after",
      "affectedPaths",
      "result",
      "error",
    ]);
    assert.equal(/chatText|message|prompt|secret chat|secret message|secret prompt|nested secret/.test(serialized), false);
  });
});
