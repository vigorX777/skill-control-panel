import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { acquireFileLock, withFileLock } from "../scripts/lib/file-lock.mjs";

test("release does not unlink a replacement lock owned by someone else", async () => {
  const root = await mkdtemp(join(tmpdir(), "scp-lock-owner-"));
  const lockPath = join(root, "registry.lock");
  try {
    const lock = await acquireFileLock(lockPath);
    await unlink(lockPath);
    await writeFile(lockPath, JSON.stringify({ pid: 999999, createdAt: new Date().toISOString(), token: "replacement" }));
    await lock.release();
    assert.equal(JSON.parse(await readFile(lockPath, "utf8")).token, "replacement");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent contenders reclaim one stale lock without overlapping", async () => {
  const root = await mkdtemp(join(tmpdir(), "scp-lock-stale-"));
  const lockPath = join(root, "registry.lock");
  let active = 0;
  let maximum = 0;
  try {
    await writeFile(lockPath, JSON.stringify({ pid: 999999, createdAt: "2000-01-01T00:00:00.000Z" }));
    await Promise.all(Array.from({ length: 16 }, () => withFileLock(
      lockPath,
      { lockTimeoutMs: 5000, staleLockMs: 1 },
      async () => {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 4));
        active -= 1;
      },
    )));
    assert.equal(maximum, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recovers an orphaned stale reclaim guard", async () => {
  const root = await mkdtemp(join(tmpdir(), "scp-lock-guard-"));
  const lockPath = join(root, "registry.lock");
  try {
    const stale = JSON.stringify({ pid: 999999, createdAt: "2000-01-01T00:00:00.000Z", token: "stale" });
    await writeFile(lockPath, stale);
    await writeFile(`${lockPath}.reclaim`, stale);
    const lock = await acquireFileLock(lockPath, { lockTimeoutMs: 1000, staleLockMs: 1 });
    await lock.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
