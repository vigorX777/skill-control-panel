import React from "react";

const COMMANDS = [
  ["扫描当前事实", "npm run skillctl -- scan --json"],
  ["接管现有 Skill", "npm run skillctl -- adopt --all"],
  ["安装公共 Skill", "npm run skillctl -- install --source <path> --scope public --vetted"],
  ["更新指定 Skill", "npm run skillctl -- update --skill <id> --source <path> --vetted"],
  ["移动到项目层", "npm run skillctl -- move --skill <id> --scope project --project-root <absolute-path> --confirmed"],
  ["卸载到 Trash", "npm run skillctl -- uninstall --skill <id> --confirmed"],
  ["重建来源事实", "npm run skillctl -- reconcile --confirmed"],
];

const DISCOVERY_ROUTES = [
  ["通用", "~/.agents/skills/"],
  ["Codex", "~/.codex/skills/"],
  ["Claude", "~/.claude/skills/"],
  ["Antigravity", "~/.gemini/skills/"],
  ["OpenCode", "~/.config/opencode/skills/"],
];

export function GovernanceView({ registry, functions = [] }) {
  return (
    <section className="ledger-panel" aria-labelledby="governance-heading">
      <div className="panel-heading"><div><p className="eyebrow">Governance / Read-only console</p><h2 id="governance-heading">管理规范</h2></div></div>
      <div className="governance-docs">
        <div className="governance-intro">
          <p className="folio">01</p><div><h3>实体源与发现入口分离</h3><p>Registry 记录当前安装事实；Hub、公共、项目、Agent 标签可以并列出现。Hub 表示可同步的真实实体源，其他标签说明其共享或使用范围；发现目录只通过软路由决定 Agent 可见性。</p></div>
        </div>
        <h3 className="governance-subheading">实体源与层级标签</h3>
        <dl className="scope-definitions scope-definitions-four">
          <div><dt>HUB</dt><dd><code>~/Vibecoding/skill-hub/skills/</code><span>个人长期 Skill 的唯一实体源；可与公共或 Agent 标签并列。</span></dd></div>
          <div><dt>PUBLIC</dt><dd><code>skills/public/ · collections/</code><span>按声明共享；并不等同于任一 Agent 的发现目录。</span></dd></div>
          <div><dt>AGENT</dt><dd><code>skills/agents/&lt;agent&gt;/</code><span>指定 Agent 的私有实体或已启用系统能力。</span></dd></div>
          <div><dt>PROJECT</dt><dd><code>&lt;project_root&gt;/.agents/skills/</code><span>随项目代码和上下文维护，不进入个人 Hub。</span></dd></div>
        </dl>
        <h3 className="governance-subheading">Agent 发现入口（软路由）</h3>
        <dl className="route-definitions">
          {DISCOVERY_ROUTES.map(([agent, path]) => <div key={agent}><dt>{agent}</dt><dd><code>{path}</code></dd></div>)}
        </dl>
        <div className="hub-apply-note"><strong>Hub 更新后的固定动作</strong><p>在 Hub 拉取或手动修改实体后，重新应用软路由并回填 Registry；不要直接编辑任一发现入口中的链接。</p><code>node scripts/private-skill-hub.mjs --apply --confirmed</code></div>
        <div className="command-book">
          {COMMANDS.map(([label, command]) => <div key={command}><span>{label}</span><code>{command}</code></div>)}
        </div>
        <h3 className="function-heading">聊天功能目录</h3>
        <div className="command-book function-book">{functions.map((item) => <div key={item.name}>
          <span>{item.title}</span><code>{item.name}</code>
          <p>{item.description}</p>
          <small>{item.mutating ? "写操作" : "只读"} · {item.requiresConfirmation ? "需要确认" : "无需确认"} · 参数：{item.parameters.length ? item.parameters.join("、") : "无"}</small>
          <code title="聊天示例">{item.example}</code><code title="CLI 示例">{item.cliExample}</code>
        </div>)}</div>
        <p className="registry-note">Registry schema v{registry?.schemaVersion || 1} · 页面不提供安装、更新、移动或卸载按钮。</p>
      </div>
    </section>
  );
}
