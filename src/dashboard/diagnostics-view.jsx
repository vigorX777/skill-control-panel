import React from "react";

function DiagnosticLines({ diagnostics }) {
  return diagnostics.map((item, index) => (
    <article className={`diagnostic-line severity-${item.severity}`} key={`${item.code}-${index}`}>
      <span className="diagnostic-severity">{item.severity}</span>
      <div><strong>{item.code}</strong><p>{item.message}</p>{item.path && <code>{item.path}</code>}</div>
    </article>
  ));
}

export function DiagnosticsView({ diagnostics, skills = [] }) {
  const hubSkills = skills.filter((skill) => skill.governanceLevels?.includes("hub"));
  const hubRoutes = hubSkills.reduce((count, skill) => count + (skill.instances || []).reduce((sum, instance) => sum + (instance.routes?.length || 0), 0), 0);
  const unmanaged = diagnostics.filter((item) => item.code === "unmanaged_skill");
  const actionable = diagnostics.filter((item) => item.code !== "unmanaged_skill" && item.severity !== "info");
  const observed = diagnostics.filter((item) => item.code !== "unmanaged_skill" && item.severity === "info");
  return (
    <section className="ledger-panel" aria-labelledby="diagnostics-heading">
      <div className="panel-heading"><div><p className="eyebrow">Diagnostics / Observed</p><h2 id="diagnostics-heading">环境诊断</h2></div></div>
      <div className="diagnostic-ledger">
        <section className="diagnostic-summary" aria-label="Hub 当前事实"><strong>Hub 当前事实</strong><p>已扫描到 {hubSkills.length} 个 Hub 逻辑 Skill、{hubRoutes} 条声明发现路由；该数字只反映路径与配置，不代表逐 Agent 调用验证。</p></section>
        {actionable.length > 0 && <section className="diagnostic-group"><h3>需要处理</h3><DiagnosticLines diagnostics={actionable} /></section>}
        {unmanaged.length > 0 && <section className="diagnostic-group"><h3>待纳管或保留观察</h3><p className="diagnostic-group-note">这类目录不由当前 Registry 管理；试用和既有项目可继续保留，不会阻断 Hub 路由。</p><DiagnosticLines diagnostics={unmanaged} /></section>}
        {observed.length > 0 && <section className="diagnostic-group"><h3>其他观察</h3><DiagnosticLines diagnostics={observed} /></section>}
        {diagnostics.length === 0 && <div className="quiet-empty"><span>✓</span><p>未发现环境冲突或配置错误</p></div>}
      </div>
    </section>
  );
}
