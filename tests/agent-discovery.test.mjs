import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discoverAgentSkillRoots } from "../scripts/lib/agent-discovery.mjs";

async function skill(root, name) { const path = join(root, name); await mkdir(path, { recursive: true }); await writeFile(join(path, "SKILL.md"), `---\nname: ${name}\n---\n`); }

test("discovers only active agent system and plugin roots", async () => {
  const home = await mkdtemp(join(tmpdir(), "agent-discovery-"));
  try {
    await skill(join(home, ".agents/skills/.system"), "skill-creator");
    await skill(join(home, ".codex/plugins/cache/market/enabled/1.0.0/skills"), "enabled-skill");
    await skill(join(home, ".codex/plugins/cache/market/enabled/backup/skills"), "backup-skill");
    await skill(join(home, ".codex/plugins/cache/market/disabled/1.0.0/skills"), "disabled-skill");
    await writeFile(join(home, ".codex/config.toml"), '[plugins."enabled@market"]\nenabled = true\n[plugins."disabled@market"]\nenabled = false\n');
    const claudeInstall = join(home, ".claude/plugins/cache/official/live/1.0.0");
    await skill(join(claudeInstall, "skills"), "claude-skill");
    await mkdir(join(home, ".claude/plugins"), { recursive: true });
    await writeFile(join(home, ".claude/plugins/installed_plugins.json"), JSON.stringify({ plugins: { "live@official": [{ installPath: claudeInstall }] } }));
    await mkdir(join(home, ".config/opencode/node_modules/pkg/dist/skills"), { recursive: true });
    await skill(join(home, ".config/opencode/node_modules/pkg/dist/skills"), "open-skill");
    await writeFile(join(home, ".config/opencode/opencode.json"), JSON.stringify({ plugin: ["pkg@latest"] }));
    await skill(join(home, ".gemini/config/skills"), "anti-skill");
    await skill(join(home, ".codex/skills"), "codex-private");
    await skill(join(home, ".claude/skills"), "claude-private");
    await skill(join(home, ".gemini/skills"), "antigravity-private");
    await skill(join(home, ".gemini/antigravity/builtin/skills"), "antigravity-guide");
    await skill(join(home, ".gemini/antigravity-backup/skills"), "backup-skill");
    const result = await discoverAgentSkillRoots({ home });
    assert.deepEqual(result.roots.system.map((root) => root.agent).sort(), ["antigravity", "codex"]);
    assert.equal(result.roots.system.some((root) => root.path.includes("antigravity-backup")), false);
    assert.deepEqual(result.roots.plugin.map((root) => `${root.agent}:${root.pluginName}`).sort(), ["claude:live", "codex:enabled", "opencode:pkg"]);
    assert.match(result.roots.plugin.find((root) => root.agent === "codex").path, /enabled\/1\.0\.0\/skills$/);
    assert.deepEqual(result.roots.agent.map((root) => `${root.agent}:${root.path}`).sort(), [
      `antigravity:${join(home, ".gemini/config/skills")}`,
      `antigravity:${join(home, ".gemini/skills")}`,
      `claude:${join(home, ".claude/skills")}`,
      `codex:${join(home, ".codex/skills")}`,
    ]);
    assert.equal(result.roots.plugin.some((root) => root.pluginName === "disabled"), false);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("parses Codex TOML strictly and does not enable commented plugins", async () => {
  const home = await mkdtemp(join(tmpdir(), "agent-discovery-toml-"));
  try {
    await skill(join(home, ".codex/plugins/cache/market/commented/1.0.0/skills"), "commented-skill");
    await mkdir(join(home, ".codex"), { recursive: true });
    await writeFile(join(home, ".codex/config.toml"), '[plugins."commented@market"]\n# enabled = true\nnote = "enabled = true"\n');
    const result = await discoverAgentSkillRoots({ home });
    assert.equal(result.roots.plugin.some((root) => root.pluginName === "commented"), false);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("rejects dot-segment plugin identifiers before resolving paths", async () => {
  const home = await mkdtemp(join(tmpdir(), "agent-discovery-traversal-"));
  try {
    await mkdir(join(home, ".codex"), { recursive: true });
    await writeFile(join(home, ".codex/config.toml"), '[plugins."enabled@.."]\nenabled = true\n');
    await mkdir(join(home, ".config/opencode"), { recursive: true });
    await writeFile(join(home, ".config/opencode/opencode.json"), JSON.stringify({ plugin: ["@../..@latest"] }));
    const result = await discoverAgentSkillRoots({ home });
    assert.equal(result.roots.plugin.length, 0);
    assert.equal(result.diagnostics.filter((item) => /Invalid enabled plugin identifier/.test(item.message)).length, 2);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("rejects plugin roots that escape through intermediate symlinks", async () => {
  const home = await mkdtemp(join(tmpdir(), "agent-discovery-realpath-"));
  try {
    const outsideCodex = join(home, "outside-codex"), outsideOpen = join(home, "outside-open");
    await skill(join(outsideCodex, "1.0.0/skills"), "outside-codex-skill");
    await skill(join(outsideOpen, "dist/skills"), "outside-open-skill");
    await mkdir(join(home, ".codex/plugins/cache/market"), { recursive: true });
    await symlink(outsideCodex, join(home, ".codex/plugins/cache/market/enabled"));
    await writeFile(join(home, ".codex/config.toml"), '[plugins."enabled@market"]\nenabled = true\n');
    await mkdir(join(home, ".config/opencode/node_modules"), { recursive: true });
    await symlink(outsideOpen, join(home, ".config/opencode/node_modules/pkg"));
    await writeFile(join(home, ".config/opencode/opencode.json"), JSON.stringify({ plugin: ["pkg@latest"] }));
    const result = await discoverAgentSkillRoots({ home });
    assert.equal(result.roots.plugin.length, 0);
    assert.equal(result.diagnostics.filter((item) => /escapes its trusted root/.test(item.message)).length, 2);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("isolates malformed agent configuration as warnings", async () => {
  const home = await mkdtemp(join(tmpdir(), "agent-discovery-errors-"));
  try {
    await mkdir(join(home, ".claude/plugins"), { recursive: true });
    await writeFile(join(home, ".claude/plugins/installed_plugins.json"), "{");
    const result = await discoverAgentSkillRoots({ home });
    assert.ok(result.diagnostics.some((item) => item.code === "agent_skill_discovery_error" && item.agent === "claude"));
  } finally { await rm(home, { recursive: true, force: true }); }
});
