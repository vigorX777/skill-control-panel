#!/usr/bin/env node

import {
  scan,
  adopt,
  checkUpdates,
  validate,
  install,
  update,
  move,
  uninstall,
  migrateRoutes,
  reconcile,
} from "./lib/manager.mjs";
import { CliUsageError, parseSkillctlArgs } from "./lib/cli-args.mjs";
import { addProjectRoot, listProjectRoots, removeProjectRoot, updateProjectRoot } from "./lib/project-roots.mjs";
import { markTranslationError, markTranslationPending, readTranslations, syncTranslations, translationForInstance } from "./lib/translations.mjs";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

function requestedJson(argv) {
  return argv.includes("--json");
}

function commandHint(argv) {
  return argv[0] && !argv[0].startsWith("--") ? argv[0] : null;
}

function emitJson(payload) {
  console.log(JSON.stringify(payload, null, 2));
}

function emitHuman(command, result) {
  if (command === "scan") {
    console.log(`扫描完成：${result.summary.totalSkills} 个 Skill，${result.summary.unmanagedSkills} 个未纳管。`);
    return;
  }
  if (command === "validate") {
    console.log(result.ok ? "验证通过。" : `验证失败：${result.diagnostics.length} 个诊断。`);
    return;
  }
  console.log(JSON.stringify(result, null, 2));
}

export async function finalizeTranslation(skill, translationInput, dependencies = {}) {
  const markPending = dependencies.markPending || markTranslationPending;
  const sync = dependencies.sync || syncTranslations;
  const markError = dependencies.markError || markTranslationError;
  let pendingSaved = false;
  try {
    const pending = await markPending({ id: skill.id, name: skill.name, capabilitySummary: skill.capability_summary, source: skill.source });
    pendingSaved = true;
    if (!translationInput) return { translation: pending.status };
    await sync({ input: translationInput, confirmed: true });
    return { translation: "ready" };
  } catch (error) {
    if (pendingSaved) await markError({ id: skill.id, name: skill.name, capabilitySummary: skill.capability_summary, source: skill.source }, error).catch(() => {});
    return { translation: "error", translationError: error.message };
  }
}

async function execute(command, options) {
  switch (command) {
    case "scan": return scan();
    case "adopt": return adopt(options);
    case "install": return install({ ...options, projectRoot: options["project-root"] });
    case "update": return update({ skillId: options.skill, source: options.source, vetted: options.vetted });
    case "move": return move({
      skillId: options.skill,
      scope: options.scope,
      agent: options.agent,
      projectRoot: options["project-root"],
      confirmed: options.confirmed,
    });
    case "uninstall": return uninstall({ skillId: options.skill, confirmed: options.confirmed });
    case "check-updates": return checkUpdates({ skillId: options.skill });
    case "validate": return validate({ skillId: options.skill });
    case "reconcile": return reconcile({ skillId: options.skill });
    case "migrate-routes": return migrateRoutes({ agent: options.agent, confirmed: options.confirmed });
    case "skill-inventory-scan": return scan();
    case "skill-environment-validate": return validate({ skillId: options.skill });
    case "skill-update-check": return checkUpdates({ skillId: options.skill });
    case "skill-move": return move({ skillId: options.skill, scope: options.scope, agent: options.agent, projectRoot: options["project-root"], confirmed: options.confirmed });
    case "skill-uninstall": return uninstall({ skillId: options.skill, confirmed: options.confirmed });
    case "skill-reconcile": return reconcile({ skillId: options.skill });
    case "agent-route-migrate": return migrateRoutes({ agent: options.agent, confirmed: options.confirmed });
    case "project-path-list": return { ok: true, ...(await listProjectRoots()) };
    case "project-path-add": return addProjectRoot({ path: options.path, label: options.label, confirmed: options.confirmed });
    case "project-path-update": return updateProjectRoot({ path: options.path, id: options.id, scanMode: options["scan-mode"], confirmed: options.confirmed });
    case "project-path-remove": return removeProjectRoot({ path: options.path, id: options.id, confirmed: options.confirmed });
    case "project-path-scan": {
      const config = await listProjectRoots();
      const selected = config.roots.filter((item) => (!options.path && !options.id) || item.path === options.path || item.id === options.id);
      const items = await Promise.all(selected.map(async (item) => ({ ...item, exists: await lstat(item.path).then((s) => s.isDirectory()).catch(() => false), hasSkillRoot: await lstat(join(item.path, ".agents", "skills")).then((s) => s.isDirectory()).catch(() => false) })));
      return { ok: true, items };
    }
    case "skill-translation-sync": {
      const current = await scan();
      return syncTranslations({ input: options.input, confirmed: options.confirmed }, {
        currentDigests: new Map(current.skills.map((skill) => [skill.id, skill.source?.content_digest || null])),
        currentInstances: new Map(current.skills.map((skill) => [skill.id, skill])),
      });
    }
    case "skill-translation-retry": {
      const result = await scan(); const cache = await readTranslations();
      const items = result.skills.map((instance) => ({ instance, translation: translationForInstance(instance, cache) })).filter(({ instance, translation }) => (!options.skill || instance.id === options.skill) && translation.status !== "ready").map(({ instance, translation }) => ({ instanceId: instance.id, skillName: instance.name, contentDigest: instance.source?.content_digest || null, sourceText: instance.capabilitySummary, status: translation.status, error: translation.error || null }));
      return { ok: true, items };
    }
    case "skill-install": {
      const result = await install({ ...options, projectRoot: options["project-root"] });
      if (!result.ok) return result;
      return { ...result, skillOperation: "success", ...(await finalizeTranslation(result.skill, options["translation-input"])) };
    }
    case "skill-update": {
      const result = await update({ skillId: options.skill, source: options.source, vetted: options.vetted });
      if (!result.ok) return result;
      return { ...result, skillOperation: "success", ...(await finalizeTranslation(result.skill, options["translation-input"])) };
    }
    case "skill-adopt": {
      const result = await adopt(options);
      const translations = await Promise.all((result.adopted || []).map((skill) => finalizeTranslation(skill)));
      return { ...result, translation: translations.some((item) => item.translation === "error") ? "error" : "pending", translationErrors: translations.filter((item) => item.translationError).map((item) => item.translationError) };
    }
    default: throw new CliUsageError(`Unknown command: ${command}`);
  }
}

async function main(argv = process.argv.slice(2)) {
  let parsed;
  try {
    parsed = parseSkillctlArgs(argv);
  } catch (error) {
    const command = commandHint(argv);
    if (requestedJson(argv)) emitJson({ ok: false, command, error: error.message });
    else console.error(error.message);
    return error instanceof CliUsageError ? error.exitCode : 1;
  }

  try {
    const result = await execute(parsed.command, parsed.options);
    const ok = result?.ok !== false;
    if (parsed.json) {
      emitJson({ ok, command: parsed.command, result });
    } else if (ok || parsed.command === "validate") {
      emitHuman(parsed.command, result);
    } else {
      console.error(result.error || "Operation failed");
    }
    return ok ? 0 : 1;
  } catch (error) {
    if (parsed.json) emitJson({ ok: false, command: parsed.command, error: error.message });
    else console.error(error.message);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
