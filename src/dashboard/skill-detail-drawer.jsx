import React, { useEffect, useId, useRef, useState } from "react";
import { agentLabel, formatDate, formatUpdateStatus, getSourceHref, scopeLabel } from "./formatters.js";

export function SkillDetailDrawer({ skill, documents = [], onClose, returnFocusRef }) {
  const headingId = useId();
  const closeRef = useRef(null);
  const onCloseRef = useRef(onClose);
  const [copied, setCopied] = useState(null);
  const [selectedInstanceId, setSelectedInstanceId] = useState(skill.instances?.[0]?.id || null);
  const updateStatus = formatUpdateStatus(skill.update);
  const installPath = skill.instances?.[0]?.realPath || skill.realPath || "--";
  const selectedDocument = documents.find((item) => item.instanceId === selectedInstanceId) || null;

  useEffect(() => setSelectedInstanceId(skill.instances?.[0]?.id || null), [skill.id]);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  useEffect(() => {
    closeRef.current?.focus();
    function handleKeydown(event) {
      if (event.key === "Escape") { event.preventDefault(); onCloseRef.current(); }
    }
    window.addEventListener("keydown", handleKeydown);
    return () => { window.removeEventListener("keydown", handleKeydown); returnFocusRef?.current?.focus(); };
  }, [returnFocusRef]);

  async function copy(value, key) {
    await navigator.clipboard.writeText(value || "");
    setCopied(key);
    window.setTimeout(() => setCopied(null), 1400);
  }

  return <div className="drawer-overlay">
    <aside className="detail-drawer is-open" role="dialog" aria-labelledby={headingId}>
      <header className="drawer-header">
        <div><p className="eyebrow">Skill / Current fact</p><h2 id={headingId}>{skill.name}</h2><p className="instance-count">{skill.instanceCount || 1} 个安装实例</p></div>
        <button className="close-button" ref={closeRef} aria-label="关闭详情" onClick={onClose}>×</button>
      </header>

      <div className="drawer-content">
        <section className="capability-detail"><p className="eyebrow">中文能力介绍</p><p>{skill.capabilitySummaryZh || "中文介绍生成中"}</p><details><summary>查看原文</summary><p>{skill.capabilitySummaryOriginal || skill.capabilitySummary || "--"}</p></details></section>
        <section className="identity-strip" aria-label="名称与路径">
          <div><span>名称</span><strong>{skill.name}</strong></div>
          <button aria-label="复制名称" onClick={() => copy(skill.name, "name")}>{copied === "name" ? "已复制" : "复制名称"}</button>
          <div className="path-value"><span>{skill.instances?.[0]?.hubEntity ? "Hub 实体路径" : "首个安装路径"}</span><code>{installPath}</code></div>
          <button aria-label="复制安装路径" onClick={() => copy(installPath, "path")}>{copied === "path" ? "已复制" : "复制路径"}</button>
        </section>

        <section className="fact-section">
          <h3>逻辑 Skill 事实</h3>
          <dl className="fact-grid">
            <div><dt>ID</dt><dd><code>{skill.id}</code></dd></div>
            <div><dt>层级</dt><dd><span className="chip-list">{(skill.governanceLevels || skill.scopeLevels)?.map((level) => <span key={level} className={`scope-chip scope-${level}`}>{scopeLabel(level)}</span>)}</span></dd></div>
            <div><dt>当前版本</dt><dd><code>{skill.versions?.length > 1 ? "多个版本" : skill.versions?.[0] || "--"}</code></dd></div>
            <div><dt>更新状态</dt><dd><span className={`status-mark tone-${updateStatus.tone}`}>{updateStatus.label}</span></dd></div>
            <div><dt>实例数量</dt><dd>{skill.instanceCount || 1}</dd></div>
            <div><dt>检查时间</dt><dd>{formatDate(skill.update?.checked_at)}</dd></div>
            <div className="fact-wide"><dt>可用范围</dt><dd><span className="chip-list">{skill.hasSharedAvailability && <span className="shared-chip">声明共享</span>}{skill.agents?.map((agent) => <span key={agent} className="agent-chip">{agentLabel(agent)}</span>)}</span></dd></div>
          </dl>
        </section>

        <section className="instance-section">
          <div className="instance-heading"><h3>安装实例</h3>{skill.hasInstanceDifferences && <span className="difference-note">不同实例的版本、来源或内容存在差异</span>}</div>
          <div className="instance-list">
            {skill.instances?.map((instance) => {
              const source = getSourceHref(instance.source);
              const status = formatUpdateStatus(instance.update);
              return <article className="instance-card" data-instance-id={instance.id} key={instance.id}>
                <header><span className="chip-list">{(instance.governanceLevels || [instance.scope?.level]).map((level) => <span key={level} className={`scope-chip scope-${level}`}>{scopeLabel(level)}</span>)}</span><code>{instance.version?.current || "--"}</code></header>
                <dl>
                  <div className="instance-wide"><dt>中文能力</dt><dd>{instance.capabilitySummaryZh || "中文介绍生成中"}</dd></div>
                  <div className="instance-wide"><dt>原始能力</dt><dd>{instance.capabilitySummaryOriginal || instance.capabilitySummary || "--"}</dd></div>
                  <div><dt>权属</dt><dd>{instance.ownership || "--"}</dd></div>
                  <div><dt>更新状态</dt><dd><span className={`status-mark tone-${status.tone}`}>{status.label}</span></dd></div>
                  <div><dt>翻译状态</dt><dd><span className="status-mark tone-neutral">{{ ready: "中文已就绪", pending: "中文介绍生成中", error: "翻译失败，可重试", stale: "译文已过期" }[instance.translationStatus] || "中文介绍生成中"}</span></dd></div>
                  {instance.scope?.agent && <div><dt>专属 Agent</dt><dd>{agentLabel(instance.scope.agent)}</dd></div>}
                  {instance.scope?.level === "agent" && instance.agentSkillKind && <div><dt>Agent 类型</dt><dd>{{ system: "系统", plugin: "插件", private: "私有" }[instance.agentSkillKind]}</dd></div>}
                  {instance.scope?.level === "agent" && instance.provider && <div><dt>Provider</dt><dd>{instance.provider}</dd></div>}
                  {instance.scope?.level === "agent" && instance.enabledBasis && <div><dt>启用依据</dt><dd>{instance.enabledBasis}</dd></div>}
                  {instance.scope?.project_root && <div className="instance-wide"><dt>项目根</dt><dd><code>{instance.scope.project_root}</code></dd></div>}
                  {instance.hubEntity && <div className="instance-wide"><dt>Hub 实体</dt><dd><code>{instance.hubEntity.path}</code>{instance.hubEntity.kind !== "unknown" && <span className="hub-kind-note"> · {({ public: "公共共享", agent: "Agent 专用", superpower: "Superpowers 集合" })[instance.hubEntity.kind] || instance.hubEntity.kind}</span>}</dd></div>}
                  {instance.hubEntity?.entry?.projectPath && <div className="instance-wide"><dt>实现项目</dt><dd><code>{instance.hubEntity.entry.projectPath}</code><span className="hub-kind-note"> · {instance.hubEntity.entry.syncNote || "项目行为变化时同步复核公共入口"}</span></dd></div>}
                  <div className="instance-wide"><dt>安装路径</dt><dd className="instance-path"><code>{instance.realPath}</code><button aria-label={`复制实例路径 ${instance.id}`} onClick={() => copy(instance.realPath, `path-${instance.id}`)}>{copied === `path-${instance.id}` ? "已复制" : "复制路径"}</button></dd></div>
                  <div className="instance-wide"><dt>来源</dt><dd>{source ? <a href={source} target="_blank" rel="noreferrer">{source}</a> : "--"}</dd></div>
                  <div className="instance-wide"><dt>暴露路由</dt><dd>{instance.routes?.length ? instance.routes.map((route) => <code className="route-line" key={route}>{route}</code>) : "--"}</dd></div>
                </dl>
              </article>;
            })}
          </div>
          <p className="registry-note">按目录和启用配置推导，未做运行调用验证。</p>
        </section>

        <section className="document-section">
          <div className="document-heading">
            <div><p className="eyebrow">Source document</p><h3>SKILL.md</h3></div>
            <label className="document-select"><span>安装实例</span><select aria-label="SKILL.md 安装实例" value={selectedInstanceId || ""} onChange={(event) => setSelectedInstanceId(event.target.value)}>{skill.instances?.map((instance) => <option key={instance.id} value={instance.id}>{scopeLabel(instance.scope?.level)} · {instance.realPath}</option>)}</select></label>
            <button className="btn-copy-skill-md" aria-label="复制当前 SKILL.md" disabled={!selectedDocument?.content} onClick={() => copy(selectedDocument.content, "document")}>{copied === "document" ? "已复制全文" : "复制全文"}</button>
          </div>
          {selectedDocument?.error ? <p className="document-empty" role="alert">无法读取：{selectedDocument.error}</p> : selectedDocument?.content ? <pre className="skill-md-source">{selectedDocument.content}</pre> : <p className="document-empty">正在读取完整文档…</p>}
        </section>
      </div>
    </aside>
  </div>;
}
