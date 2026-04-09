import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, lstat, mkdir, readlink, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import {
  APP_CONFIG_DIR,
  CATEGORY_LABELS,
  CATEGORY_OPTIONS,
  CATEGORY_RULES,
  CATEGORY_TAG_LABELS,
  CORE_SKILL_NAMES,
  DISABLED_EXPOSURE_DIR,
  EXPOSURE_STATE_PATH,
  METADATA_PATH,
  PRIORITY_OPTIONS,
  STATUS_OPTIONS,
  TAG_RULES,
} from "./constants.mjs";
import { ensureDir, readJsonFile, writeJsonFile } from "./metadata.mjs";

const execFileAsync = promisify(execFile);

export class AsmUnavailableError extends Error {
  constructor(message = "asm is not installed or not available on PATH") {
    super(message);
    this.name = "AsmUnavailableError";
  }
}

export function stableId(value) {
  return createHash("sha1").update(value).digest("hex").slice(0, 16);
}

function getAsmBinary(options = {}) {
  return options.asmBin || process.env.ASM_BIN || "asm";
}

function metadataPathFromOptions(options = {}) {
  return options.metadataPath || process.env.SKILL_CONTROL_PANEL_METADATA_PATH || METADATA_PATH;
}

function exposureStatePathFromOptions(options = {}) {
  if (options.exposureStatePath) {
    return options.exposureStatePath;
  }
  if (metadataPathFromOptions(options) !== METADATA_PATH) {
    return join(dirname(metadataPathFromOptions(options)), "exposures.json");
  }
  return EXPOSURE_STATE_PATH;
}

function disabledExposureDirFromOptions(options = {}) {
  if (options.disabledExposureDir) {
    return options.disabledExposureDir;
  }
  if (metadataPathFromOptions(options) !== METADATA_PATH) {
    return join(dirname(metadataPathFromOptions(options)), "disabled-exposures");
  }
  return DISABLED_EXPOSURE_DIR;
}

async function readExposureStore(options = {}) {
  return readJsonFile(exposureStatePathFromOptions(options), {
    version: 1,
    items: [],
  });
}

async function writeExposureStore(options, value) {
  await writeJsonFile(exposureStatePathFromOptions(options), value);
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function buildExposureRecord(skill, provider, symlinkTarget, options = {}) {
  const id = stableId(`${skill.id}:${provider.name}:${provider.path}`);
  return {
    id,
    skillId: skill.id,
    skillName: skill.name,
    description: skill.description || "",
    version: skill.version || "0.0.0",
    dirName: skill.dirName,
    realPath: skill.realPath,
    provider: provider.name,
    providerLabel: provider.label,
    originalPath: provider.path,
    scope: provider.scope || skill.scope || "global",
    location: provider.location || skill.location || `${provider.scope || skill.scope || "global"}-${provider.name}`,
    isSymlink: Boolean(provider.isSymlink),
    symlinkTarget: symlinkTarget || provider.symlinkTarget || null,
    metadataCategory: skill.metadata?.category || null,
    stashPath: join(disabledExposureDirFromOptions(options), id),
    disabledAt: new Date().toISOString(),
  };
}

function exposureRecordToRawSkill(item) {
  return {
    name: item.skillName,
    version: item.version || "0.0.0",
    description: item.description || "",
    creator: "",
    license: "",
    compatibility: "",
    allowedTools: [],
    dirName: item.dirName,
    path: item.originalPath,
    originalPath: item.originalPath,
    location: item.location,
    scope: item.scope,
    provider: item.provider,
    providerLabel: item.providerLabel,
    isSymlink: item.isSymlink,
    symlinkTarget: item.symlinkTarget || null,
    realPath: item.realPath,
    warnings: [],
    isDisabledExposure: true,
    disabledAt: item.disabledAt,
    stashPath: item.stashPath,
  };
}

function deriveTags(skill, category) {
  const tags = [];
  const pushTag = (tag) => {
    if (!tag || tags.includes(tag)) {
      return;
    }
    tags.push(tag);
  };

  pushTag(CATEGORY_TAG_LABELS[category] || CATEGORY_LABELS[category] || "其他");

  const text = [skill.name, skill.description, skill.dirName].filter(Boolean).join(" ");
  for (const rule of TAG_RULES) {
    if (rule.pattern.test(text)) {
      pushTag(rule.tag);
    }
  }

  if (CORE_SKILL_NAMES.has(skill.name)) {
    pushTag("核心工作流");
  }

  if (!tags.length) {
    pushTag("其他");
  }

  return tags;
}

export async function runAsm(args, options = {}) {
  try {
    const { stdout } = await execFileAsync(getAsmBinary(options), args, {
      cwd: options.cwd || process.cwd(),
      env: { ...process.env, ...(options.env || {}) },
      maxBuffer: 20 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (error) {
    if (error && error.code === "ENOENT") {
      throw new AsmUnavailableError();
    }

    const message = error?.stderr?.toString?.().trim() || error.message;
    const wrapped = new Error(message);
    wrapped.cause = error;
    throw wrapped;
  }
}

export async function readAsmConfig(options = {}) {
  const raw = await runAsm(["config", "show"], options);
  return JSON.parse(raw);
}

export async function getAsmConfigPath(options = {}) {
  return runAsm(["config", "path"], options);
}

export async function listAsmSkills(options = {}) {
  const raw = await runAsm(["list", "--json"], options);
  return JSON.parse(raw);
}

export async function inspectAsmSkill(name, options = {}) {
  const raw = await runAsm(["inspect", name, "--json"], options);
  return JSON.parse(raw);
}

export async function readDuplicateReport(options = {}) {
  const raw = await runAsm(["audit", "duplicates", "--json"], options);
  return JSON.parse(raw);
}

export async function installAsmSkill(source, provider, options = {}) {
  const args = ["install", source, "-y"];
  if (provider) {
    args.push("-p", provider);
  }
  return runAsm(args, options);
}

export async function uninstallAsmSkill(name, options = {}) {
  return runAsm(["uninstall", name, "-y"], options);
}

export async function updateAsmProviderEnabled(providerName, enabled, options = {}) {
  const configPath = await getAsmConfigPath(options);
  const config = await readJsonFile(configPath, null);

  if (!config) {
    throw new Error("asm config file is missing");
  }

  const provider = config.providers?.find((item) => item.name === providerName);
  if (!provider) {
    throw new Error(`Unknown asm provider: ${providerName}`);
  }

  provider.enabled = Boolean(enabled);
  await writeJsonFile(configPath, config);
  return config;
}

export function buildDefaultMetadata(skill) {
  const text = `${skill.name} ${skill.description || ""} ${skill.dirName || ""}`;
  const category =
    CATEGORY_RULES.find((rule) => rule.pattern.test(text))?.category || "other";
  const status = CORE_SKILL_NAMES.has(skill.name) ? "core" : "active";
  const priority =
    status === "core"
      ? "high"
      : category === "vertical-analysis"
        ? "low"
        : "medium";

  return {
    category,
    priority,
    status,
    notes: "",
    preferredProvider: skill.providers[0]?.name || null,
    favorite: false,
  };
}

export function sanitizeMetadata(input, fallback) {
  const output = { ...fallback };

  if (CATEGORY_OPTIONS.includes(input?.category)) {
    output.category = input.category;
  }

  if (PRIORITY_OPTIONS.includes(input?.priority)) {
    output.priority = input.priority;
  }

  if (STATUS_OPTIONS.includes(input?.status)) {
    output.status = input.status;
  }

  if (typeof input?.notes === "string") {
    output.notes = input.notes;
  }

  if (typeof input?.preferredProvider === "string" || input?.preferredProvider === null) {
    output.preferredProvider = input.preferredProvider;
  }

  if (typeof input?.favorite === "boolean") {
    output.favorite = input.favorite;
  }

  return output;
}

function warningsForSkill(instances) {
  const warnings = [];
  const seen = new Set();

  for (const instance of instances) {
    for (const warning of instance.warnings || []) {
      const key = `${warning.category}:${warning.message}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      warnings.push(warning);
    }
  }

  return warnings;
}

export function buildManagedSkills(rawSkills, duplicateGroups, metadataStore, asmConfig) {
  const byRealPath = new Map();
  const providerEnabled = new Map(
    (asmConfig.providers || []).map((provider) => [provider.name, provider.enabled]),
  );
  const duplicateByRealPath = new Map();

  for (const group of duplicateGroups) {
    const realPaths = [...new Set(group.instances.map((item) => item.realPath || item.path))];
    const mode =
      realPaths.length === 1
        ? "provider-exposed-duplicate"
        : "true-copy-duplicate";

    for (const instance of group.instances) {
      duplicateByRealPath.set(instance.realPath || instance.path, {
        key: group.key,
        mode,
      });
    }
  }

  for (const skill of rawSkills) {
    const realPath = skill.realPath || skill.path;
    const entry = byRealPath.get(realPath) || [];
    entry.push(skill);
    byRealPath.set(realPath, entry);
  }

  return [...byRealPath.entries()]
    .map(([realPath, instances]) => {
      const first = instances[0];
      const id = stableId(realPath);
      const duplicateInfo = duplicateByRealPath.get(realPath) || null;
      const providers = instances
        .map((instance) => ({
          name: instance.provider,
          label: instance.providerLabel,
          path: instance.path,
          location: instance.location,
          scope: instance.scope,
          providerEnabled: providerEnabled.get(instance.provider) ?? true,
          isSymlink: Boolean(instance.isSymlink),
          symlinkTarget: instance.symlinkTarget || null,
          exposureState: instance.isDisabledExposure ? "disabled" : "enabled",
          disabledAt: instance.disabledAt || null,
          stashPath: instance.stashPath || null,
        }))
        .sort((a, b) => a.label.localeCompare(b.label, "zh-Hans-CN"));
      const enabledProviders = providers.filter((provider) => provider.exposureState === "enabled").length;
      const totalProviders = providers.length;
      const runStatus =
        enabledProviders === totalProviders
          ? "enabled"
          : enabledProviders === 0
            ? "disabled"
            : "partial";

      const base = {
        id,
        name: first.name,
        description: first.description || "",
        version: first.version,
        dirName: first.dirName,
        realPath,
        scope: first.scope,
        location: first.location,
        providers,
        warnings: warningsForSkill(instances),
        duplicateMode: duplicateInfo?.mode || null,
        duplicateKey: duplicateInfo?.key || null,
        runtimeSummary: {
          enabledProviders,
          totalProviders,
        },
        runStatus,
        rawInstances: instances,
      };

      const defaults = buildDefaultMetadata(base);
      const stored = metadataStore.skills?.[id] || {};
      const metadata = sanitizeMetadata(stored, defaults);

      return {
        ...base,
        metadata,
        tags: deriveTags(base, metadata.category),
        favorite: Boolean(metadata.favorite),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
}

export function buildProviderSummary(asmConfig, activeRawSkills, managedSkills) {
  return (asmConfig.providers || []).map((provider) => ({
    ...provider,
    instanceCount: activeRawSkills.filter((item) => item.provider === provider.name).length,
    uniqueSkillCount: managedSkills.filter((item) =>
      item.providers.some(
        (providerItem) =>
          providerItem.name === provider.name && providerItem.exposureState === "enabled",
      ),
    ).length,
  }));
}

export function buildDuplicateSummary(duplicateReport) {
  return (duplicateReport.duplicateGroups || []).map((group) => {
    const realPaths = [...new Set(group.instances.map((item) => item.realPath || item.path))];
    const providers = [...new Set(group.instances.map((item) => item.providerLabel))];
    return {
      key: group.key,
      mode:
        realPaths.length === 1
          ? "provider-exposed-duplicate"
          : "true-copy-duplicate",
      instanceCount: group.instances.length,
      realPathCount: realPaths.length,
      providers,
      items: group.instances,
    };
  });
}

export function buildSummary(activeRawSkills, managedSkills, duplicates, providers) {
  const enabledSkillCount = managedSkills.filter((skill) => skill.runStatus !== "disabled").length;
  const disabledSkillCount = managedSkills.filter((skill) => skill.runStatus === "disabled").length;

  return {
    totalSkillInstances: managedSkills.reduce((count, skill) => count + skill.providers.length, 0),
    activeSkillInstances: activeRawSkills.length,
    enabledSkillInstances: activeRawSkills.length,
    enabledSkillCount,
    disabledSkillCount,
    uniqueSkills: managedSkills.length,
    duplicateGroups: duplicates.length,
    warningCount: activeRawSkills.reduce(
      (count, skill) => count + (skill.warnings?.length || 0),
      0,
    ),
    providerDistribution: providers.map((provider) => ({
      name: provider.name,
      label: provider.label,
      enabled: provider.enabled,
      instanceCount: provider.instanceCount,
      uniqueSkillCount: provider.uniqueSkillCount,
    })),
  };
}

export async function disableSkillExposure(skillId, providerName, options = {}) {
  const snapshot = await loadDashboardState(options);
  const skill = snapshot.managedSkills.find((item) => item.id === skillId);

  if (!skill) {
    throw new Error(`Unknown skill id: ${skillId}`);
  }

  const provider = skill.providers.find((item) => item.name === providerName);
  if (!provider) {
    throw new Error(`Skill ${skill.name} is not exposed in provider ${providerName}`);
  }

  if (provider.exposureState === "disabled") {
    return {
      skillId,
      providerName,
      action: "disable",
      ok: true,
      noChange: true,
    };
  }

  if (!(await pathExists(provider.path))) {
    throw new Error(`Provider exposure path is missing: ${provider.path}`);
  }

  const store = await readExposureStore(options);
  await ensureDir(disabledExposureDirFromOptions(options));

  let symlinkTarget = null;
  const stat = await lstat(provider.path);
  if (stat.isSymbolicLink()) {
    symlinkTarget = await readlink(provider.path);
  }

  const record = buildExposureRecord(skill, provider, symlinkTarget, options);

  if (await pathExists(record.stashPath)) {
    await rm(record.stashPath, { recursive: true, force: true });
  }

  await rename(provider.path, record.stashPath);
  store.items = store.items.filter(
    (item) => !(item.skillId === skillId && item.provider === providerName),
  );
  store.items.push(record);
  await writeExposureStore(options, store);

  return {
    skillId,
    providerName,
    action: "disable",
    ok: true,
  };
}

export async function enableSkillExposure(skillId, providerName, options = {}) {
  const store = await readExposureStore(options);
  const record = store.items.find(
    (item) => item.skillId === skillId && item.provider === providerName,
  );

  if (!record) {
    const snapshot = await loadDashboardState(options);
    const skill = snapshot.managedSkills.find((item) => item.id === skillId);
    const provider = skill?.providers.find((item) => item.name === providerName);
    if (provider?.exposureState === "enabled") {
      return {
        skillId,
        providerName,
        action: "enable",
        ok: true,
        noChange: true,
      };
    }

    throw new Error(`No disabled exposure found for ${skillId} / ${providerName}`);
  }

  if (!(await pathExists(record.stashPath))) {
    throw new Error(`Disabled exposure data is missing: ${record.stashPath}`);
  }

  if (await pathExists(record.originalPath)) {
    throw new Error(`Exposure path already exists: ${record.originalPath}`);
  }

  await ensureDir(dirname(record.originalPath));
  await rename(record.stashPath, record.originalPath);
  store.items = store.items.filter((item) => item.id !== record.id);
  await writeExposureStore(options, store);

  return {
    skillId,
    providerName,
    action: "enable",
    ok: true,
  };
}

export async function uninstallSkillExposure(skillId, providerName, options = {}) {
  const store = await readExposureStore(options);
  const disabledRecordIndex = store.items.findIndex(
    (item) => item.skillId === skillId && item.provider === providerName,
  );

  if (disabledRecordIndex >= 0) {
    const [record] = store.items.splice(disabledRecordIndex, 1);
    await rm(record.stashPath, { recursive: true, force: true });
    await writeExposureStore(options, store);

    return {
      skillId,
      providerName,
      action: "uninstall",
      ok: true,
      removedState: "disabled",
    };
  }

  const snapshot = await loadDashboardState(options);
  const skill = snapshot.managedSkills.find((item) => item.id === skillId);

  if (!skill) {
    throw new Error(`Unknown skill id: ${skillId}`);
  }

  const provider = skill.providers.find((item) => item.name === providerName);

  if (!provider) {
    throw new Error(`Skill ${skill.name} is not exposed in provider ${providerName}`);
  }

  await rm(provider.path, { recursive: true, force: true });

  return {
    skillId,
    providerName,
    action: "uninstall",
    ok: true,
    removedState: "enabled",
  };
}

export async function loadDashboardState(options = {}) {
  await ensureDir(APP_CONFIG_DIR);
  const metadataPath = metadataPathFromOptions(options);
  const metadataStore = await readJsonFile(metadataPath, { version: 1, skills: {} });
  const exposureStore = await readExposureStore(options);
  const [activeRawSkills, duplicateReport, asmConfig] = await Promise.all([
    listAsmSkills(options),
    readDuplicateReport(options),
    readAsmConfig(options),
  ]);

  const disabledRawSkills = exposureStore.items.map(exposureRecordToRawSkill);
  const managedSkills = buildManagedSkills(
    [...activeRawSkills, ...disabledRawSkills],
    duplicateReport.duplicateGroups || [],
    metadataStore,
    asmConfig,
  );
  const providers = buildProviderSummary(asmConfig, activeRawSkills, managedSkills);
  const duplicates = buildDuplicateSummary(duplicateReport);

  return {
    scannedAt: new Date().toISOString(),
    metadataStore,
    rawSkills: activeRawSkills,
    disabledExposureStore: exposureStore,
    managedSkills,
    duplicates,
    providers,
    summary: buildSummary(activeRawSkills, managedSkills, duplicates, providers),
  };
}
