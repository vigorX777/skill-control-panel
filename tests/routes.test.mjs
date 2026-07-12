import test from "node:test";
import assert from "node:assert/strict";
import { access, cp, lstat, mkdir, mkdtemp, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyRoutePlan, migrateDirectoryRoute, planRouteRemoval, planRoutesForSkill, validateRouteMigration } from "../scripts/lib/routes.mjs";
import { stageMoveAcrossFilesystems } from "../scripts/lib/fs-move.mjs";

async function tempRoot() {
  return mkdtemp(join(tmpdir(), "skill-routes-test-"));
}

test("refuses an agent-private route through a shared directory symlink", async () => {
  const root = await tempRoot();
  try {
    const publicRoot = join(root, "public");
    const routeRoot = join(root, "claude-skills");
    await mkdir(publicRoot);
    await symlink(publicRoot, routeRoot, "dir");
    await assert.rejects(
      planRoutesForSkill(
        { name: "private", scope: { level: "agent", agent: "claude" }, install: { canonical_path: join(root, "private"), routes: [] } },
        { claude: routeRoot },
      ),
      /directory route migration/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("creates and rolls back a per-skill route", async () => {
  const root = await tempRoot();
  try {
    const canonical = join(root, "canonical");
    const routeRoot = join(root, "routes");
    await mkdir(canonical);
    await writeFile(join(canonical, "SKILL.md"), "body");
    await mkdir(routeRoot);
    const plan = await planRoutesForSkill(
      { name: "private", scope: { level: "agent", agent: "claude" }, install: { canonical_path: canonical, routes: [] } },
      { claude: routeRoot },
    );
    const applied = await applyRoutePlan(plan);
    assert.equal(await readlink(join(routeRoot, "private")), canonical);
    await applied.rollback();
    await assert.rejects(access(join(routeRoot, "private")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("creates public leaf routes only for already migrated directory roots", async () => {
  const root = await tempRoot();
  try {
    const publicRoot = join(root, "public");
    const canonical = join(publicRoot, "shared");
    const legacyRoot = join(root, "legacy-routes");
    const migratedRoot = join(root, "migrated-routes");
    await mkdir(canonical, { recursive: true });
    await writeFile(join(canonical, "SKILL.md"), "body");
    await symlink(publicRoot, legacyRoot, "dir");
    await mkdir(migratedRoot);
    const plan = await planRoutesForSkill(
      { name: "shared", scope: { level: "public", agent: null }, install: { canonical_path: canonical, routes: [] } },
      { claude: legacyRoot, codex: migratedRoot },
    );
    assert.deepEqual(plan.routes, [join(migratedRoot, "shared")]);
    const applied = await applyRoutePlan(plan);
    assert.equal(await readlink(join(migratedRoot, "shared")), canonical);
    assert.equal((await lstat(legacyRoot)).isSymbolicLink(), true);
    await applied.rollback();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses to remove a managed route whose target was replaced", async () => {
  const root = await tempRoot();
  try {
    const canonical = join(root, "canonical");
    const other = join(root, "other");
    const routeRoot = join(root, "routes");
    const route = join(routeRoot, "shared");
    await mkdir(canonical);
    await mkdir(other);
    await mkdir(routeRoot);
    await symlink(other, route);
    const plan = planRouteRemoval(
      { name: "shared", install: { canonical_path: canonical, routes: [route] } },
      { claude: routeRoot },
    );
    await assert.rejects(applyRoutePlan(plan), /different target/i);
    assert.equal(await readlink(route), other);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("replaces a retained route target during a scope move and rolls back", async () => {
  const root = await tempRoot();
  try {
    const oldCanonical = join(root, "old");
    const newCanonical = join(root, "new");
    const routeRoot = join(root, "routes");
    const route = join(routeRoot, "shared");
    await mkdir(oldCanonical);
    await mkdir(newCanonical);
    await mkdir(routeRoot);
    await symlink(oldCanonical, route);
    const plan = await planRoutesForSkill(
      { name: "shared", scope: { level: "agent", agent: "claude" }, install: { canonical_path: newCanonical, routes: [route] } },
      { claude: routeRoot },
      { previousCanonicalPath: oldCanonical },
    );
    const applied = await applyRoutePlan(plan);
    assert.equal(await readlink(route), newCanonical);
    await applied.rollback();
    assert.equal(await readlink(route), oldCanonical);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses persisted routes outside every managed agent route root", async () => {
  const root = await tempRoot();
  try {
    const victim = join(root, "victim-link");
    const canonical = join(root, "canonical");
    const routeRoot = join(root, "routes");
    await mkdir(canonical);
    await mkdir(routeRoot);
    await symlink(canonical, victim);
    const skill = {
      name: "private",
      scope: { level: "public", agent: null },
      install: { canonical_path: canonical, routes: [victim] },
    };
    assert.throws(() => planRouteRemoval(skill, { claude: routeRoot }), /outside managed agent roots/i);
    await assert.rejects(
      planRoutesForSkill(skill, { claude: routeRoot }),
      /outside managed agent roots/i,
    );
    assert.equal((await lstat(victim)).isSymbolicLink(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("allows a Hub public route in the shared discovery root to be removed", () => {
  const skill = {
    name: "shared",
    install: {
      canonical_path: "/hub/skills/public/shared",
      routes: ["/routes/shared/shared"],
    },
  };
  const plan = planRouteRemoval(skill, { shared: "/routes/shared" });
  assert.deepEqual(plan.routes, []);
  assert.deepEqual(plan.operations, [{ type: "remove", path: "/routes/shared/shared", expectedTarget: "/hub/skills/public/shared" }]);
});

test("removes a chained discovery route only when it resolves to the expected entity", async () => {
  const root = await tempRoot();
  try {
    const canonical = join(root, "canonical");
    const sharedRoot = join(root, "shared");
    const codexRoot = join(root, "codex");
    const sharedRoute = join(sharedRoot, "memory-reflow");
    const codexRoute = join(codexRoot, "memory-reflow");
    await mkdir(canonical);
    await mkdir(sharedRoot);
    await mkdir(codexRoot);
    await symlink(canonical, sharedRoute);
    await symlink(sharedRoute, codexRoute);
    const skill = { name: "memory-reflow", install: { canonical_path: canonical, routes: [sharedRoute, codexRoute] } };
    const applied = await applyRoutePlan(planRouteRemoval(skill, { shared: sharedRoot, codex: codexRoot }));
    await assert.rejects(lstat(sharedRoute));
    await assert.rejects(lstat(codexRoute));
    await applied.cleanup();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("enforces the Claude per-skill route version gate", () => {
  assert.throws(() => validateRouteMigration("claude", { claude: "2.1.202" }), /2\.1\.203/);
  assert.throws(() => validateRouteMigration("claude", { claude: null }), /detect|unknown|2\.1\.203/i);
  assert.doesNotThrow(() => validateRouteMigration("claude", { claude: "2.1.203" }));
  assert.doesNotThrow(() => validateRouteMigration("codex", { codex: null }));
});

test("explicitly migrates and can roll back a whole-directory route", async () => {
  const root = await tempRoot();
  try {
    const publicRoot = join(root, "public");
    const routeRoot = join(root, "claude-skills");
    const backupRoot = join(root, "backups");
    const skillPath = join(publicRoot, "shared");
    const unmanagedPath = join(publicRoot, "unmanaged");
    await mkdir(skillPath, { recursive: true });
    await mkdir(unmanagedPath, { recursive: true });
    await writeFile(join(skillPath, "SKILL.md"), "body");
    await writeFile(join(unmanagedPath, "SKILL.md"), "body");
    await symlink(publicRoot, routeRoot, "dir");

    const migration = await migrateDirectoryRoute({
      agent: "claude",
      routeRoot,
      backupRoot,
      confirmed: true,
      agentVersions: { claude: "2.1.203" },
      skills: [{ name: "shared", install: { canonical_path: skillPath } }],
    });

    assert.equal((await lstat(routeRoot)).isDirectory(), true);
    assert.equal(await readlink(join(routeRoot, "shared")), skillPath);
    assert.equal(await readlink(join(routeRoot, "unmanaged")), unmanagedPath);
    await migration.rollback();
    assert.equal((await lstat(routeRoot)).isSymbolicLink(), true);
    assert.equal(await readlink(routeRoot), publicRoot);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stages and rolls back an EXDEV move", async () => {
  const root = await tempRoot();
  try {
    const source = join(root, "source");
    const destination = join(root, "destination");
    await mkdir(source);
    await writeFile(join(source, "SKILL.md"), "body");
    let first = true;
    const move = await stageMoveAcrossFilesystems(source, destination, {
      async rename(from, to) {
        if (first) {
          first = false;
          throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
        }
        return rename(from, to);
      },
      cp,
    });
    await assert.doesNotReject(access(join(destination, "SKILL.md")));
    await assert.rejects(access(source));
    await move.rollback();
    await assert.doesNotReject(access(join(source, "SKILL.md")));
    await assert.rejects(access(destination));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
