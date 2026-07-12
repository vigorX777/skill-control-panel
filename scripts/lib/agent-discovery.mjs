import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";

async function directory(path) { try { return (await lstat(path)).isDirectory(); } catch { return false; } }
function pluginName(spec) { const at = spec.lastIndexOf("@"); return at > 0 ? spec.slice(0, at) : spec; }
function safePackage(value) {
  if (!/^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/.test(value)) return false;
  return value.replace(/^@/, "").split("/").every((segment) => segment !== "." && segment !== "..");
}
function inside(base, path) { const relation = relative(resolve(base), resolve(path)); return relation !== "" && !relation.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && relation !== ".."; }
async function insideReal(base, path) { try { return inside(await realpath(base), await realpath(path)); } catch { return false; } }
function validVersionDirectory(value) { return /^\d+(?:\.\d+){1,3}(?:[-+][A-Za-z0-9.-]+)?$/.test(value) || /^[a-f0-9]{7,64}$/i.test(value); }
function warning(agent, path, error) { return { code: "agent_skill_discovery_error", severity: "warning", agent, path, message: `Unable to discover ${agent} Skills: ${error.message}`, details: { code: error.code || null } }; }
function root(path, agent, ownership, extras = {}) { return { path, agent, ownership, ...extras }; }

async function codex(home) {
  const roots = { system: [], plugin: [], agent: [] }, diagnostics = [];
  const systemPath = join(home, ".agents", "skills", ".system");
  if (await directory(systemPath)) roots.system.push(root(systemPath, "codex", "system", { agentSkillKind: "system", provider: "codex", enabledBasis: "system_builtin" }));
  const privateSkillsPath = join(home, ".codex", "skills");
  if (await directory(privateSkillsPath)) roots.agent.push(root(privateSkillsPath, "codex", "managed", { agentSkillKind: "private", provider: "codex", enabledBasis: "managed_private" }));
  const configPath = join(home, ".codex", "config.toml");
  try {
    const config = parseToml(await readFile(configPath, "utf8"));
    const enabled = Object.entries(config.plugins || {}).filter(([, value]) => value?.enabled === true).map(([name]) => name);
    for (const spec of enabled) {
      const name = pluginName(spec), market = spec.slice(name.length + 1);
      if (!safePackage(name) || !safePackage(market)) { diagnostics.push(warning("codex", configPath, new Error(`Invalid enabled plugin identifier: ${spec}`))); continue; }
      const cacheRoot = join(home, ".codex", "plugins", "cache"), parent = join(cacheRoot, market, name);
      if (!inside(cacheRoot, parent)) { diagnostics.push(warning("codex", configPath, new Error(`Invalid enabled plugin path: ${spec}`))); continue; }
      let selected = null;
      try {
        const latest = join(parent, "latest"), latestStat = await lstat(latest);
        if (latestStat.isSymbolicLink()) { const target = await realpath(latest); if (dirname(target) === parent && validVersionDirectory(basename(target))) selected = target; }
      } catch {}
      if (!selected) {
        const versions = await readdir(parent, { withFileTypes: true }).catch(() => []);
        const candidates = versions.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && validVersionDirectory(entry.name));
        if (candidates.length === 1) selected = join(parent, candidates[0].name);
        else if (candidates.length > 1) { diagnostics.push(warning("codex", parent, new Error(`Enabled plugin version is ambiguous: ${spec}`))); continue; }
      }
      const skillsPath = selected && join(selected, "skills");
      if (skillsPath && await directory(skillsPath) && await insideReal(cacheRoot, skillsPath)) roots.plugin.push(root(skillsPath, "codex", "plugin", { pluginName: name, agentSkillKind: "plugin", provider: name, enabledBasis: "enabled_config" }));
      else if (skillsPath && await directory(skillsPath)) diagnostics.push(warning("codex", skillsPath, new Error(`Enabled plugin escapes its trusted root: ${spec}`)));
      else diagnostics.push(warning("codex", parent, new Error(`Enabled plugin has no Skill root: ${spec}`)));
    }
  } catch (error) { if (error.code !== "ENOENT") diagnostics.push(warning("codex", configPath, error)); }
  return { roots, diagnostics };
}

async function claude(home) {
  const roots = { system: [], plugin: [], agent: [] }, diagnostics = [], configPath = join(home, ".claude", "plugins", "installed_plugins.json");
  const privateSkillsPath = join(home, ".claude", "skills");
  if (await directory(privateSkillsPath)) roots.agent.push(root(privateSkillsPath, "claude", "managed", { agentSkillKind: "private", provider: "claude", enabledBasis: "managed_private" }));
  try {
    const config = JSON.parse(await readFile(configPath, "utf8"));
    for (const [spec, installs] of Object.entries(config.plugins || {})) for (const install of installs || []) {
      const path = join(install.installPath, "skills");
      if (await directory(path)) roots.plugin.push(root(path, "claude", "plugin", { pluginName: pluginName(spec), agentSkillKind: "plugin", provider: pluginName(spec), enabledBasis: "installed_manifest" }));
    }
  } catch (error) { if (error.code !== "ENOENT") diagnostics.push(warning("claude", configPath, error)); }
  return { roots, diagnostics };
}

async function antigravity(home) {
  const roots = { system: [], plugin: [], agent: [] }, diagnostics = [], path = join(home, ".gemini", "config", "skills");
  const routedSkillsPath = join(home, ".gemini", "skills");
  const builtinPath = join(home, ".gemini", "antigravity", "builtin", "skills");
  if (await directory(builtinPath)) roots.system.push(root(builtinPath, "antigravity", "system", { agentSkillKind: "system", provider: "antigravity", enabledBasis: "system_builtin", ignoreBrokenEntries: true }));
  if (await directory(path)) roots.agent.push(root(path, "antigravity", "system", { agentSkillKind: "system", provider: "antigravity", enabledBasis: "managed_private", ignoreBrokenEntries: true }));
  if (await directory(routedSkillsPath)) roots.agent.push(root(routedSkillsPath, "antigravity", "managed", { agentSkillKind: "private", provider: "antigravity", enabledBasis: "managed_private", ignoreBrokenEntries: true }));
  return { roots, diagnostics };
}

async function opencode(home) {
  const roots = { system: [], plugin: [], agent: [] }, diagnostics = [], configPath = join(home, ".config", "opencode", "opencode.json");
  try {
    const config = JSON.parse(await readFile(configPath, "utf8"));
    for (const spec of config.plugin || []) {
      const name = pluginName(spec), modulesRoot = join(home, ".config", "opencode", "node_modules"), path = join(modulesRoot, name, "dist", "skills");
      if (!safePackage(name)) { diagnostics.push(warning("opencode", configPath, new Error(`Invalid enabled plugin identifier: ${spec}`))); continue; }
      if (!inside(modulesRoot, path)) { diagnostics.push(warning("opencode", configPath, new Error(`Invalid enabled plugin path: ${spec}`))); continue; }
      if (await directory(path) && await insideReal(modulesRoot, path)) roots.plugin.push(root(path, "opencode", "plugin", { pluginName: name, agentSkillKind: "plugin", provider: name, enabledBasis: "enabled_config" }));
      else if (await directory(path)) diagnostics.push(warning("opencode", path, new Error(`Enabled plugin escapes its trusted root: ${spec}`)));
      else diagnostics.push(warning("opencode", path, new Error(`Enabled plugin has no exposed Skill root: ${spec}`)));
    }
  } catch (error) { if (error.code !== "ENOENT") diagnostics.push(warning("opencode", configPath, error)); }
  const routedSkillsPath = join(home, ".config", "opencode", "skills");
  if (await directory(routedSkillsPath)) roots.agent.push(root(routedSkillsPath, "opencode", "managed", { agentSkillKind: "private", provider: "opencode", enabledBasis: "managed_private", ignoreBrokenEntries: true }));
  return { roots, diagnostics };
}

export async function discoverAgentSkillRoots(options = {}) {
  const home = options.home || process.env.SKILL_CONTROL_PANEL_AGENT_DISCOVERY_HOME || homedir();
  const settled = await Promise.all([codex(home), claude(home), antigravity(home), opencode(home)]);
  return settled.reduce((all, item) => ({ roots: { system: [...all.roots.system, ...item.roots.system], plugin: [...all.roots.plugin, ...item.roots.plugin], agent: [...all.roots.agent, ...item.roots.agent] }, diagnostics: [...all.diagnostics, ...item.diagnostics] }), { roots: { system: [], plugin: [], agent: [] }, diagnostics: [] });
}
