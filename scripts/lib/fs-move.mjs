import { randomUUID } from "node:crypto";
import { cp as fsCp, mkdir, rename as fsRename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { computeDirectoryDigest } from "./source.mjs";

export async function stageMoveAcrossFilesystems(source, destination, options = {}) {
  const moveRename = options.rename || fsRename;
  const moveCp = options.cp || fsCp;
  await mkdir(dirname(destination), { recursive: true });
  try {
    await moveRename(source, destination);
    return {
      async rollback() { await moveRename(destination, source); },
      async cleanup() {},
    };
  } catch (error) {
    if (error.code !== "EXDEV") throw error;
  }

  const staging = join(dirname(destination), `.${basename(destination)}.${randomUUID()}.move-staging`);
  const sourceBackup = join(dirname(source), `.${basename(source)}.${randomUUID()}.move-backup`);
  try {
    await moveCp(source, staging, { recursive: true });
    const [sourceDigest, stagingDigest] = await Promise.all([
      computeDirectoryDigest(source),
      computeDirectoryDigest(staging),
    ]);
    if (sourceDigest !== stagingDigest) throw new Error("Cross-filesystem staging digest mismatch");
    await moveRename(staging, destination);
    await moveRename(source, sourceBackup);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
  return {
    async rollback() {
      await rm(destination, { recursive: true, force: true });
      await moveRename(sourceBackup, source);
    },
    async cleanup() {
      await rm(sourceBackup, { recursive: true, force: true });
      await rm(staging, { recursive: true, force: true });
    },
  };
}
