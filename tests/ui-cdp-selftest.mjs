import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSkillControlServer } from "../scripts/lib/server-app.mjs";

const PROXY_BASE_URL = "http://127.0.0.1:3456";

async function withMockServer(fn) {
  const tempRoot = await mkdtemp(join(tmpdir(), "skill-control-panel-ui-"));
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
  });
  await app.refreshSnapshot();
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const address = app.server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await fn({ baseUrl });
  } finally {
    await new Promise((resolve, reject) => app.server.close((error) => (error ? reject(error) : resolve())));
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function getJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`Request failed: ${url} (${response.status})`);
  }
  return response.json();
}

async function cdpEval(targetId, expression) {
  const response = await fetch(`${PROXY_BASE_URL}/eval?target=${encodeURIComponent(targetId)}`, {
    method: "POST",
    body: expression,
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || `CDP eval failed (${response.status})`);
  }
  const payload = await response.json();
  return payload.value;
}

async function cdpClick(targetId, selector) {
  const response = await fetch(`${PROXY_BASE_URL}/click?target=${encodeURIComponent(targetId)}`, {
    method: "POST",
    body: selector,
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || `CDP click failed (${response.status})`);
  }
  return response.json();
}

async function waitFor(check, timeoutMs = 10000, intervalMs = 150) {
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

async function ensureCdpReady() {
  const health = await getJson(`${PROXY_BASE_URL}/health`);
  if (health.status !== "ok") {
    throw new Error("CDP proxy is not healthy");
  }
  await getJson(`${PROXY_BASE_URL}/targets`);
}

async function runUiSelfTest() {
  await ensureCdpReady();

  await withMockServer(async ({ baseUrl }) => {
    const logStep = (message) => console.log(`[ui-selftest] ${message}`);

    logStep(`mock server ready: ${baseUrl}`);
    const created = await getJson(
      `${PROXY_BASE_URL}/new?url=${encodeURIComponent(baseUrl)}`,
    );
    const targetId = created.targetId;
    logStep(`created target: ${targetId}`);

    try {
      logStep("waiting for page title");
      await waitFor(async () => {
        const info = await getJson(`${PROXY_BASE_URL}/info?target=${encodeURIComponent(targetId)}`);
        return info.title === "Skill 控制台";
      });
      logStep("page loaded");

      logStep("checking stats rail");
      assert.equal(await cdpEval(targetId, 'document.querySelectorAll(".stats-chip").length'), 6);
      assert.equal(await cdpEval(targetId, 'document.querySelectorAll(".stats-chip-note").length'), 6);
      assert.equal(await cdpEval(targetId, 'document.querySelectorAll(".provider-mark svg").length >= 3'), true);

      logStep("checking filter trigger chrome");
      assert.equal(
        await cdpEval(
          targetId,
          `(() => {
            const trigger = document.querySelector('.multi-select-trigger');
            const style = getComputedStyle(trigger);
            return style.borderTopWidth !== '0px' && style.borderStyle !== 'none' && style.borderColor !== 'rgba(0, 0, 0, 0)';
          })()`,
        ),
        true,
      );

      logStep("checking filter dropdown alignment");
      await cdpEval(
        targetId,
        `(() => {
          document.querySelectorAll('.multi-select-trigger')[0]?.click();
          return true;
        })()`,
      );
      await waitFor(async () => (await cdpEval(targetId, '!!document.querySelector(".multi-select-panel")')) === true);
      assert.equal(
        await cdpEval(
          targetId,
          `(() => {
            const trigger = document.querySelectorAll('.multi-select-trigger')[0];
            const panel = document.querySelector('.multi-select-panel');
            const option = panel?.querySelector('.multi-select-option');
            const input = option?.querySelector('input');
            const label = option?.querySelector('.multi-select-label');
            if (!trigger || !panel || !input || !label) {
              return false;
            }
             const triggerRect = trigger.getBoundingClientRect();
             const panelRect = panel.getBoundingClientRect();
             const inputRect = input.getBoundingClientRect();
             const labelRect = label.getBoundingClientRect();
             const inputStyle = getComputedStyle(input);
             const panelAttached = Math.abs(panelRect.top - triggerRect.bottom - 6) < 2;
             const rowAligned = Math.abs((inputRect.top + inputRect.height / 2) - (labelRect.top + labelRect.height / 2)) < 6;
             const inputKeepsNativeSize = parseFloat(inputStyle.width) < 32;
             return panelAttached && rowAligned && inputKeepsNativeSize;
           })()`,
         ),
         true,
       );
      await cdpEval(targetId, "document.body.click(); true");

      logStep("applying search filter");
      await cdpEval(
        targetId,
        `(() => {
          const input = document.querySelector('.field-search input');
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          setter.call(input, 'defuddle');
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        })()`,
      );

      await waitFor(async () => (await cdpEval(targetId, 'document.querySelectorAll(".skill-card").length')) === 1);
      logStep("search filter applied");

      logStep("checking active filter row placement");
      assert.equal(
        await cdpEval(
          targetId,
          `(() => {
            const toolbar = document.querySelector('.filter-toolbar');
            const activeRow = document.querySelector('.active-filter-list');
            const clearAll = document.querySelector('.clear-all-button');
            if (!toolbar || !activeRow || !clearAll) {
              return false;
            }
            return !toolbar.contains(clearAll) && activeRow.contains(clearAll);
          })()`,
        ),
        true,
      );

      logStep("switching provider theme");
      await cdpEval(
        targetId,
        `(() => {
          const chip = Array.from(document.querySelectorAll('.provider-filter-chip')).find((item) =>
            item.textContent.includes('Claude Code')
          );
          chip?.click();
          return document.querySelector('.app-shell').className;
        })()`,
      );

      await waitFor(async () =>
        (await cdpEval(targetId, 'document.querySelector(".app-shell").className')).includes("theme-claude"),
      );

      assert.equal(
        await cdpEval(targetId, 'document.querySelector(".topbar-meta").textContent.includes("Claude Code")'),
        true,
      );
      logStep("provider theme switched");

      logStep("clearing filters");
      await cdpEval(
        targetId,
        `(() => {
          const input = document.querySelector('.field-search input');
          const inputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          inputSetter.call(input, '');
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          document.querySelector('.text-link')?.click();
          return true;
        })()`,
      );

      await waitFor(async () => (await cdpEval(targetId, 'document.querySelectorAll(".skill-card").length')) === 2);
      logStep("filters cleared");

      logStep("opening smart-search detail");
      await cdpEval(
        targetId,
        `(() => {
          const card = Array.from(document.querySelectorAll('.skill-card')).find((item) =>
            item.querySelector('h3')?.textContent?.includes('smart-search')
          );
          card?.click();
          return true;
        })()`,
      );

      await waitFor(async () =>
        (await cdpEval(targetId, 'document.querySelector(".detail-header h2").textContent')) === "smart-search",
      );
      logStep("smart-search detail opened");

      logStep("opening defuddle detail");
      await cdpEval(
        targetId,
        `(() => {
          const card = Array.from(document.querySelectorAll('.skill-card')).find((item) =>
            item.querySelector('h3')?.textContent?.includes('defuddle')
          );
          card?.click();
          return true;
        })()`,
      );

      await waitFor(async () =>
        (await cdpEval(targetId, 'document.querySelector(".detail-header h2").textContent')) === "defuddle",
      );
      logStep("defuddle detail opened");

      logStep("checking card status text");
      assert.equal(
        await cdpEval(
          targetId,
          `Array.from(document.querySelectorAll('.skill-card .status-badge')).every((item) =>
            item.textContent.includes('已启用') || item.textContent.includes('已停用') || item.textContent.includes('部分启用')
          )`,
        ),
        true,
      );

      logStep("checking detail header cleanup");
      assert.equal(await cdpEval(targetId, 'document.querySelector(".locale-toolbar") === null'), true);
      assert.equal(
        await cdpEval(
          targetId,
          `Array.from(document.querySelectorAll('.run-status-panel button')).map((item) => item.textContent.trim()).join('|')`,
        ),
        "启用|停用|删除",
      );
      assert.equal(
        await cdpEval(
          targetId,
          `(() => {
            const detailHeader = document.querySelector('.detail-header');
            const sectionHead = document.querySelector('.detail-section-head');
            const bulkPanel = document.querySelector('.run-status-panel');
            if (!detailHeader || !sectionHead || !bulkPanel) {
              return false;
            }
            return !detailHeader.contains(bulkPanel) && sectionHead.contains(bulkPanel);
          })()`,
        ),
        true,
      );

      logStep("checking keyboard focus feedback");
      const borderBeforeFocus = await cdpEval(
        targetId,
        `getComputedStyle(document.querySelector('.detail-pane')).boxShadow`,
      );

      await cdpEval(
        targetId,
        `(() => {
          const codexCard = Array.from(document.querySelectorAll('.provider-detail-card')).find((item) =>
            item.textContent.includes('Codex')
          );
          codexCard.querySelector('.button-danger')?.focus();
          return document.activeElement?.textContent || '';
        })()`,
      );

      const borderAfterFocus = await cdpEval(
        targetId,
        `getComputedStyle(document.querySelector('.detail-pane')).boxShadow`,
      );
      assert.notEqual(borderBeforeFocus, borderAfterFocus);
      logStep("keyboard focus feedback active");

      logStep("disabling all providers from bulk toolbar");
      await cdpEval(
        targetId,
        `(() => {
          const button = Array.from(document.querySelectorAll('.run-status-panel button')).find((item) =>
            item.textContent.includes('停用')
          );
          button?.click();
          return true;
        })()`,
      );

      await waitFor(async () =>
        (await cdpEval(
          targetId,
          `Array.from(document.querySelectorAll('.provider-detail-card .status-text')).every((item) =>
            item.textContent.includes('已停用')
          )`,
        )) === true,
      );
      logStep("all providers disabled");

      logStep("re-enabling all providers from bulk toolbar");
      await cdpEval(
        targetId,
        `(() => {
          const button = Array.from(document.querySelectorAll('.run-status-panel button')).find((item) =>
            item.textContent.includes('启用')
          );
          button?.click();
          return true;
        })()`,
      );

      await waitFor(async () =>
        (await cdpEval(
          targetId,
          `Array.from(document.querySelectorAll('.provider-detail-card .status-text')).every((item) =>
            item.textContent.includes('已启用')
          )`,
        )) === true,
      );
      logStep("all providers enabled");

      logStep("deleting smart-search from bulk toolbar");
      await cdpEval(
        targetId,
        `(() => {
          const card = Array.from(document.querySelectorAll('.skill-card')).find((item) =>
            item.querySelector('h3')?.textContent?.includes('smart-search')
          );
          card?.click();
          return true;
        })()`,
      );

      await waitFor(async () =>
        (await cdpEval(targetId, 'document.querySelector(".detail-header h2").textContent')) === "smart-search",
      );

      await cdpEval(targetId, "window.confirm = () => true");
      await cdpEval(
        targetId,
        `(() => {
          const button = Array.from(document.querySelectorAll('.run-status-panel button')).find((item) =>
            item.textContent.includes('删除')
          );
          button?.click();
          return true;
        })()`,
      );

      await waitFor(async () =>
        (await cdpEval(
          targetId,
          `Array.from(document.querySelectorAll('.skill-card h3')).some((item) =>
            item.textContent.includes('smart-search')
          )`,
        )) === false,
      );
      logStep("smart-search removed");

      logStep("checking accessibility live regions");
      assert.equal(await cdpEval(targetId, '!!document.querySelector(".sr-only[aria-live=\\"polite\\"]")'), true);
      assert.equal(await cdpEval(targetId, '!!document.querySelector(".sr-only[aria-live=\\"assertive\\"]")'), true);

      console.log("UI CDP self-test passed");
    } finally {
      await getJson(`${PROXY_BASE_URL}/close?target=${encodeURIComponent(targetId)}`);
    }
  });
}

runUiSelfTest().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
