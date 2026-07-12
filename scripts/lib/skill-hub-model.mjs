import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { parse } from "yaml";

import { SKILL_HUB_CONFIG_PATH } from "./constants.mjs";

function isInside(path, parent) {
  const value = relative(parent, path);
  return value === "" || (!value.startsWith("..") && !value.includes("/../"));
}

export async function readSkillHubModel(options = {}) {
  if (options.hubRoot === false) return { root: null, entities: new Map() };
  let hubRoot = options.hubRoot || process.env.SKILL_CONTROL_PANEL_HUB_ROOT || null;
  if (!hubRoot) {
    try {
      const config = parse(await readFile(SKILL_HUB_CONFIG_PATH, "utf8"));
      if (config?.schemaVersion === 1 && typeof config.hubRoot === "string" && config.hubRoot.startsWith("/")) hubRoot = config.hubRoot;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  if (!hubRoot) return { root: null, entities: new Map() };

  const root = resolve(hubRoot);
  const manifest = parse(await readFile(`${root}/skill-hub.yaml`, "utf8"));
  if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.skills)) throw new Error(`Invalid Skill Hub manifest: ${root}/skill-hub.yaml`);
  const entities = new Map(manifest.skills
    .filter((item) => typeof item?.path === "string" && typeof item?.kind === "string")
    .map((item) => [resolve(root, item.path), item]));
  return { root, entities };
}

export function hubFactForInstance(instance, hub) {
  if (!hub?.root || !isInside(resolve(instance.realPath), resolve(hub.root, "skills"))) return null;
  const entity = hub.entities.get(resolve(instance.realPath)) || null;
  return {
    root: hub.root,
    kind: entity?.kind || "unknown",
    path: entity?.path || relative(hub.root, instance.realPath),
    entry: entity?.entry || null,
  };
}

export function governanceLevelsForInstance(instance, hub) {
  return [
    ...(hubFactForInstance(instance, hub) ? ["hub"] : []),
    instance.scope?.level,
  ].filter(Boolean);
}
