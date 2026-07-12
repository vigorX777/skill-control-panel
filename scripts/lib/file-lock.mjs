import { open, mkdir, readFile, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

async function canReclaim(lockPath, staleLockMs) {
  try {
    const info = JSON.parse(await readFile(lockPath, "utf8"));
    const age = Date.now() - Date.parse(info.createdAt);
    return Number.isFinite(age) && age > staleLockMs && !isProcessAlive(info.pid);
  } catch {
    try {
      return Date.now() - (await stat(lockPath)).mtimeMs > staleLockMs;
    } catch {
      return false;
    }
  }
}

async function createOwnedFile(path, payload) {
  let handle = null;
  try {
    handle = await open(path, "wx", 0o600);
    await handle.writeFile(JSON.stringify(payload));
    return handle;
  } catch (error) {
    if (handle) {
      await handle.close().catch(() => {});
      await unlink(path).catch(() => {});
    }
    throw error;
  }
}

async function releaseOwnedFile(handle, path, token) {
  await handle.close();
  try {
    const current = JSON.parse(await readFile(path, "utf8"));
    if (current.token === token) await unlink(path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function reclaimOrphanedGuard(path, staleLockMs) {
  let before;
  try {
    before = JSON.parse(await readFile(path, "utf8"));
  } catch {
    const beforeStat = await stat(path).catch(() => null);
    if (!beforeStat || Date.now() - beforeStat.mtimeMs <= staleLockMs) return false;
    await wait(10 + Math.floor(Math.random() * 20));
    const afterStat = await stat(path).catch(() => null);
    if (
      !afterStat ||
      afterStat.ino !== beforeStat.ino ||
      afterStat.size !== beforeStat.size ||
      afterStat.mtimeMs !== beforeStat.mtimeMs ||
      Date.now() - afterStat.mtimeMs <= staleLockMs
    ) return false;
    await unlink(path).catch(() => {});
    return true;
  }
  if (!before.token || !(await canReclaim(path, staleLockMs))) return false;
  await wait(10 + Math.floor(Math.random() * 20));
  try {
    const after = JSON.parse(await readFile(path, "utf8"));
    if (after.token !== before.token || !(await canReclaim(path, staleLockMs))) return false;
    await unlink(path);
    return true;
  } catch {
    return false;
  }
}

export async function acquireFileLock(lockPath, options = {}) {
  const timeoutMs = options.lockTimeoutMs ?? 10_000;
  const staleLockMs = options.staleLockMs ?? 30_000;
  const startedAt = Date.now();
  await mkdir(dirname(lockPath), { recursive: true });

  while (true) {
    try {
      const token = randomUUID();
      const handle = await createOwnedFile(lockPath, {
        pid: process.pid, createdAt: new Date().toISOString(), token,
      });
      let released = false;
      return {
        async release() {
          if (released) return;
          released = true;
          await releaseOwnedFile(handle, lockPath, token);
        },
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (await canReclaim(lockPath, staleLockMs)) {
        const reclaimPath = `${lockPath}.reclaim`;
        let reclaimHandle = null;
        let reclaimToken = null;
        try {
          reclaimToken = randomUUID();
          reclaimHandle = await createOwnedFile(reclaimPath, {
            pid: process.pid, createdAt: new Date().toISOString(), token: reclaimToken,
          });
          if (await canReclaim(lockPath, staleLockMs)) await unlink(lockPath).catch(() => {});
        } catch (reclaimError) {
          if (reclaimError.code !== "EEXIST") throw reclaimError;
          await reclaimOrphanedGuard(reclaimPath, staleLockMs);
        } finally {
          if (reclaimHandle) {
            await releaseOwnedFile(reclaimHandle, reclaimPath, reclaimToken);
          }
        }
        if (reclaimHandle) continue;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`Timed out acquiring lock: ${lockPath}`);
      }
      await wait(10 + Math.floor(Math.random() * 20));
    }
  }
}

export async function withFileLock(lockPath, options, callback) {
  const lock = await acquireFileLock(lockPath, options);
  try {
    return await callback();
  } finally {
    await lock.release();
  }
}
