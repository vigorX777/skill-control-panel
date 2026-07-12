import { dirname, join } from "node:path";

import { GOVERNANCE_STATE_PATH, METADATA_PATH, PRIMARY_PROVIDER_PRIORITY } from "./constants.mjs";
import { readJsonFile, writeJsonFile } from "./metadata.mjs";

function metadataPathFromOptions(options = {}) {
  return options.metadataPath || process.env.SKILL_CONTROL_PANEL_METADATA_PATH || METADATA_PATH;
}

function governanceStatePathFromOptions(options = {}) {
  if (options.governanceStatePath) {
    return options.governanceStatePath;
  }

  if (metadataPathFromOptions(options) !== METADATA_PATH) {
    return join(dirname(metadataPathFromOptions(options)), "governance.json");
  }

  return GOVERNANCE_STATE_PATH;
}

export async function readGovernanceState(options = {}) {
  return readJsonFile(governanceStatePathFromOptions(options), {
    version: 1,
    lastPrimaryProvider: null,
    updatedAt: null,
  });
}

export async function writeGovernanceState(options = {}, patch = {}) {
  const current = await readGovernanceState(options);
  const next = {
    ...current,
    ...patch,
    version: 1,
    updatedAt: new Date().toISOString(),
  };
  await writeJsonFile(governanceStatePathFromOptions(options), next);
  return next;
}

function providerPriorityIndex(name) {
  const index = PRIMARY_PROVIDER_PRIORITY.indexOf(name);
  return index === -1 ? PRIMARY_PROVIDER_PRIORITY.length : index;
}

function sortProvidersForPrimary(left, right) {
  return (
    providerPriorityIndex(left.name) - providerPriorityIndex(right.name) ||
    left.label.localeCompare(right.label, "zh-Hans-CN")
  );
}

function providerHasEnabledExposure(skill, providerName) {
  return skill.providers.some(
    (provider) => provider.name === providerName && provider.exposureState === "enabled",
  );
}

function diagnosisForCounts(skillCount, sharedSkillCount, exclusiveSkillCount) {
  if (skillCount === 0) {
    return "空仓";
  }
  if (sharedSkillCount > 0 && exclusiveSkillCount === 0) {
    return "主要是主仓重复项";
  }
  if (sharedSkillCount > 0 && exclusiveSkillCount > 0) {
    return "既有重复项，也有独立项";
  }
  return "主要是独立项";
}

function buildExplanations() {
  return [
    {
      title: "指标解释",
      body: "Skill 数量表示该 Provider 当前承载的 Skill 总数；与主仓重复表示该 Provider 下与主仓共享同一真实路径的 Skill 数；独立项表示主仓中没有对应真实路径的 Skill 数。",
    },
    {
      title: "诊断结论",
      body: "空仓表示当前没有承载任何 Skill；主要是主仓重复项表示该 Provider 下的大部分内容都与主仓重复；既有重复项，也有独立项表示它同时承载重复内容和独立内容；主要是独立项表示它更像一个独立来源仓。",
    },
    {
      title: "当前版本限制",
      body: "当前版本只提供结构诊断和说明，不提供任何治理执行操作。",
    },
  ];
}

export async function resolvePrimaryProvider(snapshot, options = {}, explicitPrimaryProvider = "") {
  const activeProviders = snapshot.providers
    .filter((provider) => provider.uniqueSkillCount > 0)
    .sort((left, right) => sortProvidersForPrimary(left, right));

  if (!activeProviders.length) {
    const error = new Error("No providers with active skills were found");
    error.statusCode = 400;
    throw error;
  }

  if (explicitPrimaryProvider) {
    const explicit = snapshot.providers.find((provider) => provider.name === explicitPrimaryProvider);
    if (!explicit || explicit.uniqueSkillCount === 0) {
      const error = new Error(`Unknown primary provider: ${explicitPrimaryProvider}`);
      error.statusCode = 400;
      throw error;
    }
    return {
      provider: explicit,
      source: "explicit",
    };
  }

  const governanceState = await readGovernanceState(options);
  if (governanceState.lastPrimaryProvider) {
    const remembered = activeProviders.find(
      (provider) => provider.name === governanceState.lastPrimaryProvider,
    );
    if (remembered) {
      return {
        provider: remembered,
        source: "remembered",
      };
    }
  }

  const maxSkillCount = Math.max(...activeProviders.map((provider) => provider.uniqueSkillCount));
  const topProviders = activeProviders
    .filter((provider) => provider.uniqueSkillCount === maxSkillCount)
    .sort((left, right) => sortProvidersForPrimary(left, right));

  return {
    provider: topProviders[0],
    source: "derived",
  };
}

export async function buildProviderGovernanceReport(snapshot, options = {}, explicitPrimaryProvider = "") {
  const { provider: primaryProvider, source } = await resolvePrimaryProvider(
    snapshot,
    options,
    explicitPrimaryProvider,
  );

  const providerComparisons = snapshot.providers.map((provider) => {
    const sharedSkillCount = snapshot.managedSkills.filter(
      (skill) =>
        providerHasEnabledExposure(skill, provider.name) &&
        providerHasEnabledExposure(skill, primaryProvider.name),
    ).length;
    const exclusiveSkillCount = snapshot.managedSkills.filter(
      (skill) =>
        providerHasEnabledExposure(skill, provider.name) &&
        !providerHasEnabledExposure(skill, primaryProvider.name),
    ).length;

    return {
      provider: provider.name,
      label: provider.label,
      iconKey: provider.name,
      skillCount: provider.uniqueSkillCount,
      sharedSkillCount,
      exclusiveSkillCount,
      diagnosis: diagnosisForCounts(provider.uniqueSkillCount, sharedSkillCount, exclusiveSkillCount),
      enabled: provider.enabled,
    };
  });

  const activeProviders = providerComparisons
    .filter((provider) => provider.skillCount > 0)
    .sort((left, right) => left.label.localeCompare(right.label, "zh-Hans-CN"));
  const emptyProviders = providerComparisons
    .filter((provider) => provider.skillCount === 0)
    .sort((left, right) => left.label.localeCompare(right.label, "zh-Hans-CN"));

  return {
    primaryProvider: {
      name: primaryProvider.name,
      label: primaryProvider.label,
      iconKey: primaryProvider.name,
      skillCount: primaryProvider.uniqueSkillCount,
      source,
    },
    primaryCandidates: snapshot.providers
      .filter((provider) => provider.uniqueSkillCount > 0)
      .sort((left, right) => sortProvidersForPrimary(left, right))
      .map((provider) => ({
        provider: provider.name,
        label: provider.label,
        iconKey: provider.name,
        skillCount: provider.uniqueSkillCount,
      })),
    activeProviders,
    emptyProviders,
    summary: {
      providerCount: providerComparisons.length,
      activeProviderCount: activeProviders.length,
      emptyProviderCount: emptyProviders.length,
    },
    explanations: buildExplanations(),
  };
}
