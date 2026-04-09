import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { createSkillControlServer } from "../scripts/lib/server-app.mjs";

async function withServer(fn, serverOptions = {}) {
  const tempRoot = await mkdtemp(join(tmpdir(), "skill-control-panel-"));
  const configDir = join(tempRoot, "config");
  await mkdir(configDir, { recursive: true });

  const asmConfigPath = join(tempRoot, "asm-config.json");
  const metadataPath = join(configDir, "metadata.json");
  const asmScriptPath = join(tempRoot, "mock-asm.mjs");
  const claudeProviderDir = join(tempRoot, ".claude", "skills");
  const codexProviderDir = join(tempRoot, ".codex", "skills");
  const realRoot = join(tempRoot, "real");

  await mkdir(claudeProviderDir, { recursive: true });
  await mkdir(codexProviderDir, { recursive: true });
  await mkdir(realRoot, { recursive: true });

  const defuddleRealPath = join(realRoot, "defuddle");
  const smartSearchRealPath = join(realRoot, "smart-search");
  await mkdir(defuddleRealPath, { recursive: true });
  await mkdir(smartSearchRealPath, { recursive: true });

  const claudeDefuddlePath = join(claudeProviderDir, "defuddle");
  const codexDefuddlePath = join(codexProviderDir, "defuddle");
  const claudeSmartSearchPath = join(claudeProviderDir, "smart-search");

  await symlink(defuddleRealPath, claudeDefuddlePath);
  await symlink(defuddleRealPath, codexDefuddlePath);
  await symlink(smartSearchRealPath, claudeSmartSearchPath);

  const mockSkills = [
    {
      name: "defuddle",
      version: "0.0.0",
      description: "Web cleanup skill",
      creator: "",
      license: "",
      compatibility: "",
      allowedTools: [],
      dirName: "defuddle",
      path: claudeDefuddlePath,
      originalPath: claudeDefuddlePath,
      location: "global-claude",
      scope: "global",
      provider: "claude",
      providerLabel: "Claude Code",
      isSymlink: true,
      symlinkTarget: defuddleRealPath,
      realPath: defuddleRealPath,
      warnings: [{ category: "missing-version", message: "Missing version" }],
    },
    {
      name: "defuddle",
      version: "0.0.0",
      description: "Web cleanup skill",
      creator: "",
      license: "",
      compatibility: "",
      allowedTools: [],
      dirName: "defuddle",
      path: codexDefuddlePath,
      originalPath: codexDefuddlePath,
      location: "global-codex",
      scope: "global",
      provider: "codex",
      providerLabel: "Codex",
      isSymlink: true,
      symlinkTarget: defuddleRealPath,
      realPath: defuddleRealPath,
      warnings: [{ category: "missing-version", message: "Missing version" }],
    },
    {
      name: "smart-search",
      version: "0.0.0",
      description: "Search routing skill",
      creator: "",
      license: "",
      compatibility: "",
      allowedTools: [],
      dirName: "smart-search",
      path: claudeSmartSearchPath,
      originalPath: claudeSmartSearchPath,
      location: "global-claude",
      scope: "global",
      provider: "claude",
      providerLabel: "Claude Code",
      isSymlink: true,
      symlinkTarget: smartSearchRealPath,
      realPath: smartSearchRealPath,
      warnings: [],
    },
  ];

  const duplicateReport = {
    scannedAt: new Date().toISOString(),
    totalSkills: mockSkills.length,
    duplicateGroups: [
      {
        key: "defuddle",
        reason: "same-dirName",
        instances: mockSkills.slice(0, 2),
      },
    ],
    totalDuplicateInstances: 2,
  };

  const asmConfig = {
    version: 1,
    providers: [
      {
        name: "claude",
        label: "Claude Code",
        global: "~/.claude/skills",
        project: ".claude/skills",
        enabled: true,
      },
      {
        name: "codex",
        label: "Codex",
        global: "~/.codex/skills",
        project: ".codex/skills",
        enabled: true,
      },
    ],
    customPaths: [],
    preferences: {
      defaultScope: "both",
      defaultSort: "name",
    },
  };

  await writeFile(asmConfigPath, JSON.stringify(asmConfig, null, 2), "utf8");
  await writeFile(
    asmScriptPath,
    `#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
const configPath = ${JSON.stringify(asmConfigPath)};
const skills = ${JSON.stringify(mockSkills)};
const duplicates = ${JSON.stringify(duplicateReport)};
const visibleSkills = skills.filter((item) => existsSync(item.path));
const visibleDuplicates = {
  ...duplicates,
  duplicateGroups: duplicates.duplicateGroups
    .map((group) => ({
      ...group,
      instances: group.instances.filter((item) => existsSync(item.path)),
    }))
    .filter((group) => group.instances.length > 1),
};
if (args[0] === "config" && args[1] === "show") {
  process.stdout.write(readFileSync(configPath, "utf8"));
} else if (args[0] === "config" && args[1] === "path") {
  process.stdout.write(configPath);
} else if (args[0] === "list") {
  process.stdout.write(JSON.stringify(visibleSkills));
} else if (args[0] === "inspect") {
  process.stdout.write(JSON.stringify(visibleSkills.filter((item) => item.name === args[1])));
} else if (args[0] === "audit" && args[1] === "duplicates") {
  process.stdout.write(JSON.stringify(visibleDuplicates));
} else if (args[0] === "uninstall") {
  process.stdout.write("ok");
} else if (args[0] === "install") {
  process.stdout.write("ok");
} else {
  process.exit(1);
}
`,
    "utf8",
  );
  await chmod(asmScriptPath, 0o755);

  const app = createSkillControlServer({
    asmBin: asmScriptPath,
    metadataPath,
    translationEnabled: false,
    ...serverOptions,
  });
  await app.refreshSnapshot();
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const address = app.server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await fn({ baseUrl, metadataPath, asmConfigPath });
  } finally {
    await new Promise((resolve, reject) => app.server.close((error) => (error ? reject(error) : resolve())));
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function waitFor(check, timeoutMs = 5000, intervalMs = 100) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const result = await check();
    if (result) {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error("Timed out while waiting for condition");
}

test("summary and duplicates mark provider-exposed groups", async () => {
  await withServer(async ({ baseUrl }) => {
    const summary = await fetch(`${baseUrl}/api/summary`).then((response) => response.json());
    const skills = await fetch(`${baseUrl}/api/skills`).then((response) => response.json());
    const duplicates = await fetch(`${baseUrl}/api/duplicates`).then((response) => response.json());

    assert.equal(summary.summary.totalSkillInstances, 3);
    assert.equal(summary.summary.enabledSkillInstances, 3);
    assert.equal(summary.summary.uniqueSkills, 2);
    assert.equal(skills.items.find((item) => item.name === "defuddle").duplicateMode, "provider-exposed-duplicate");
    assert.equal(skills.items.find((item) => item.name === "defuddle").runStatus, "enabled");
    assert.equal(duplicates.items[0].mode, "provider-exposed-duplicate");
  });
});

test("metadata persists after patch and rescan", async () => {
  await withServer(async ({ baseUrl, metadataPath }) => {
    const skills = await fetch(`${baseUrl}/api/skills`).then((response) => response.json());
    const skill = skills.items.find((item) => item.name === "defuddle");

    const patchResponse = await fetch(`${baseUrl}/api/metadata/${skill.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        category: "automation-system",
        priority: "low",
        status: "hidden",
        notes: "Keep for later",
      }),
    });

    assert.equal(patchResponse.status, 200);

    await fetch(`${baseUrl}/api/rescan`, { method: "POST" });
    const refreshed = await fetch(`${baseUrl}/api/skills`).then((response) => response.json());
    const updated = refreshed.items.find((item) => item.id === skill.id);
    const metadataFile = JSON.parse(await readFile(metadataPath, "utf8"));

    assert.equal(updated.metadata.category, "automation-system");
    assert.equal(updated.metadata.status, "hidden");
    assert.equal(metadataFile.skills[skill.id].notes, "Keep for later");
  });
});

test("provider toggle basket applies to asm config", async () => {
  await withServer(async ({ baseUrl, asmConfigPath }) => {
    const queueResponse = await fetch(`${baseUrl}/api/basket/items`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "set-provider-enabled",
        target: "codex",
        payload: { enabled: false },
      }),
    });

    assert.equal(queueResponse.status, 201);

    const applyResponse = await fetch(`${baseUrl}/api/basket/apply`, {
      method: "POST",
    });
    const applied = await applyResponse.json();
    const updatedConfig = JSON.parse(await readFile(asmConfigPath, "utf8"));

    assert.equal(applyResponse.status, 200);
    assert.equal(applied.results[0].ok, true);
    assert.equal(updatedConfig.providers.find((item) => item.name === "codex").enabled, false);
  });
});

test("provider-level exposure actions disable, enable, and uninstall skill entries", async () => {
  await withServer(async ({ baseUrl }) => {
    const skills = await fetch(`${baseUrl}/api/skills`).then((response) => response.json());
    const skill = skills.items.find((item) => item.name === "defuddle");
    const codexProvider = skill.providers.find((item) => item.name === "codex");

    const disableResponse = await fetch(
      `${baseUrl}/api/skills/${skill.id}/providers/codex/action`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "disable" }),
      },
    );

    assert.equal(disableResponse.status, 200);

    const disabledSkills = await fetch(`${baseUrl}/api/skills`).then((response) => response.json());
    const disabledSkill = disabledSkills.items.find((item) => item.id === skill.id);
    const disabledProvider = disabledSkill.providers.find((item) => item.name === "codex");

    assert.equal(disabledProvider.exposureState, "disabled");

    const enableResponse = await fetch(
      `${baseUrl}/api/skills/${skill.id}/providers/codex/action`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "enable" }),
      },
    );

    assert.equal(enableResponse.status, 200);

    const enabledSkills = await fetch(`${baseUrl}/api/skills`).then((response) => response.json());
    const enabledSkill = enabledSkills.items.find((item) => item.id === skill.id);
    const enabledProvider = enabledSkill.providers.find((item) => item.name === "codex");

    assert.equal(enabledProvider.exposureState, "enabled");

    const uninstallResponse = await fetch(
      `${baseUrl}/api/skills/${skill.id}/providers/codex/action`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "uninstall" }),
      },
    );

    assert.equal(uninstallResponse.status, 200);

    const updatedSkills = await fetch(`${baseUrl}/api/skills`).then((response) => response.json());
    const updatedSkill = updatedSkills.items.find((item) => item.id === skill.id);

    assert.equal(updatedSkill.providers.some((item) => item.name === "codex"), false);
    assert.equal(codexProvider.path.includes("/.codex/skills/defuddle"), true);
  });
});

test("single-skill action applies to all provider exposures", async () => {
  await withServer(async ({ baseUrl }) => {
    const skills = await fetch(`${baseUrl}/api/skills`).then((response) => response.json());
    const skill = skills.items.find((item) => item.name === "defuddle");

    const disableResponse = await fetch(`${baseUrl}/api/skills/${skill.id}/action`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "disable" }),
    });
    const disabledPayload = await disableResponse.json();

    assert.equal(disableResponse.status, 200);
    assert.equal(disabledPayload.result.successCount, 2);

    const disabledSkills = await fetch(`${baseUrl}/api/skills`).then((response) => response.json());
    const disabledSkill = disabledSkills.items.find((item) => item.id === skill.id);
    assert.equal(
      disabledSkill.providers.every((provider) => provider.exposureState === "disabled"),
      true,
    );

    const enableResponse = await fetch(`${baseUrl}/api/skills/${skill.id}/action`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "enable" }),
    });
    const enabledPayload = await enableResponse.json();

    assert.equal(enableResponse.status, 200);
    assert.equal(enabledPayload.result.successCount, 2);

    const enabledSkills = await fetch(`${baseUrl}/api/skills`).then((response) => response.json());
    const enabledSkill = enabledSkills.items.find((item) => item.id === skill.id);
    assert.equal(
      enabledSkill.providers.every((provider) => provider.exposureState === "enabled"),
      true,
    );
  });
});

test("batch skill action aggregates success and failure per skill", async () => {
  await withServer(async ({ baseUrl }) => {
    const skills = await fetch(`${baseUrl}/api/skills`).then((response) => response.json());
    const defuddle = skills.items.find((item) => item.name === "defuddle");
    const smartSearch = skills.items.find((item) => item.name === "smart-search");

    const response = await fetch(`${baseUrl}/api/skills/batch-action`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "disable",
        skillIds: [defuddle.id, smartSearch.id, "missing-skill"],
      }),
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.summary.totalSkills, 3);
    assert.equal(payload.summary.successCount, 2);
    assert.equal(payload.summary.failureCount, 1);
    assert.equal(payload.results.find((item) => item.skillId === "missing-skill").ok, false);

    const refreshed = await fetch(`${baseUrl}/api/skills`).then((res) => res.json());
    assert.equal(
      refreshed.items
        .filter((item) => item.id === defuddle.id || item.id === smartSearch.id)
        .every((item) => item.providers.every((provider) => provider.exposureState === "disabled")),
      true,
    );
  });
});

test("translations are cached and attached to skill payloads", async () => {
  await withServer(
    async ({ baseUrl, metadataPath }) => {
      const skill = await waitFor(async () => {
        const payload = await fetch(`${baseUrl}/api/skills`).then((response) => response.json());
        return payload.items.find(
          (item) => item.name === "defuddle" && item.localization?.state === "ready",
        );
      });

      assert.equal(skill.localization.currentLocale, "zh-Hans");
      assert.equal(skill.localization.zhHans.name, "中文 defuddle");
      assert.equal(skill.runtimeSummary.enabledProviders, 2);
      assert.equal(skill.runtimeSummary.totalProviders, 2);

      const translationsPath = join(dirname(metadataPath), "translations.json");
      const stored = JSON.parse(await readFile(translationsPath, "utf8"));
      assert.equal(stored.skills[skill.id].zhHans.name, "中文 defuddle");
    },
    {
      translationEnabled: true,
      translateRunner: async (skill) => ({
        name: `中文 ${skill.name}`,
        description: `中文 ${skill.description}`,
      }),
    },
  );
});

test("favorite flag persists through metadata patch and refresh", async () => {
  await withServer(async ({ baseUrl }) => {
    const skills = await fetch(`${baseUrl}/api/skills`).then((response) => response.json());
    const skill = skills.items.find((item) => item.name === "smart-search");

    const patchResponse = await fetch(`${baseUrl}/api/metadata/${skill.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ favorite: true }),
    });

    assert.equal(patchResponse.status, 200);

    await fetch(`${baseUrl}/api/rescan`, { method: "POST" });
    const refreshed = await fetch(`${baseUrl}/api/skills`).then((response) => response.json());
    const updated = refreshed.items.find((item) => item.id === skill.id);

    assert.equal(updated.favorite, true);
    assert.equal(updated.metadata.favorite, true);
  });
});

test("runStatus becomes partial when provider exposures are mixed", async () => {
  await withServer(async ({ baseUrl }) => {
    const skills = await fetch(`${baseUrl}/api/skills`).then((response) => response.json());
    const defuddle = skills.items.find((item) => item.name === "defuddle");

    const disableResponse = await fetch(
      `${baseUrl}/api/skills/${defuddle.id}/providers/codex/action`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "disable" }),
      },
    );

    assert.equal(disableResponse.status, 200);

    const refreshed = await fetch(`${baseUrl}/api/skills`).then((response) => response.json());
    const updated = refreshed.items.find((item) => item.id === defuddle.id);

    assert.equal(updated.runStatus, "partial");
    assert.equal(updated.runtimeSummary.enabledProviders, 1);
    assert.equal(updated.runtimeSummary.totalProviders, 2);
  });
});

test("translation CLI selection respects environment setting", async () => {
  const calls = [];
  await withServer(
    async ({ baseUrl }) => {
      const skill = await waitFor(async () => {
        const payload = await fetch(`${baseUrl}/api/skills`).then((response) => response.json());
        return payload.items.find((item) => item.name === "defuddle" && item.localization?.state === "ready");
      });

      assert.equal(skill.localization.zhHans.name, "中文标题");
      assert.equal(calls[0]?.command, "codex");
    },
    {
      translationEnabled: true,
      translationCli: "codex",
      runTranslationCommand: async (command) => {
        calls.push({ command });
        return JSON.stringify({ last_message: '{"name":"中文标题","description":"中文描述"}' });
      },
    },
  );
});

test("translation CLI auto-detects codex environment", async () => {
  const calls = [];
  await withServer(
    async ({ baseUrl }) => {
      const skill = await waitFor(async () => {
        const payload = await fetch(`${baseUrl}/api/skills`).then((response) => response.json());
        return payload.items.find((item) => item.name === "defuddle" && item.localization?.state === "ready");
      });

      assert.equal(skill.localization.zhHans.name, "Codex 中文");
      assert.equal(calls[0]?.command, "codex");
    },
    {
      translationEnabled: true,
      env: {
        CODEX_SHELL: "1",
      },
      runTranslationCommand: async (command) => {
        calls.push({ command });
        return JSON.stringify({ last_message: '{"name":"Codex 中文","description":"Codex 描述"}' });
      },
    },
  );
});

test("translation CLI auto-detects claude environment", async () => {
  const calls = [];
  await withServer(
    async ({ baseUrl }) => {
      const skill = await waitFor(async () => {
        const payload = await fetch(`${baseUrl}/api/skills`).then((response) => response.json());
        return payload.items.find((item) => item.name === "defuddle" && item.localization?.state === "ready");
      });

      assert.equal(skill.localization.zhHans.name, "Claude 中文");
      assert.equal(calls[0]?.command, "claude");
    },
    {
      translationEnabled: true,
      env: {
        CODEX_SHELL: "",
        CODEX_THREAD_ID: "",
        CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "",
        __CFBundleIdentifier: "",
        CLAUDE_PROJECT_DIR: "/tmp/demo",
      },
      runTranslationCommand: async (command) => {
        calls.push({ command });
        return '{"name":"Claude 中文","description":"Claude 描述"}';
      },
    },
  );
});
