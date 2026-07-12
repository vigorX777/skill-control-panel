import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { readRegistry } from "../scripts/lib/registry.mjs";

const execFileAsync = promisify(execFile);
const worker = fileURLToPath(new URL("./fixtures/registry-upsert-worker.mjs", import.meta.url));

test("preserves every concurrent registry upsert across processes", async () => {
  const root = await mkdtemp(join(tmpdir(), "registry-concurrency-"));
  const registryPath = join(root, "skills-registry.yaml");
  try {
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        execFileAsync(process.execPath, [worker, registryPath, String(index)]),
      ),
    );
    const registry = await readRegistry({ registryPath });
    assert.equal(registry.skills.length, 12);
    assert.equal(new Set(registry.skills.map((skill) => skill.id)).size, 12);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
