import React, { useCallback, useEffect, useRef, useState } from "react";
import { fetchDashboard, fetchHistoryPage, fetchSkillDetail } from "./api.js";
import { DiagnosticsView } from "./diagnostics-view.jsx";
import { GovernanceView } from "./governance-view.jsx";
import { HistoryView } from "./history-view.jsx";
import { InventoryView } from "./inventory-view.jsx";
import { SkillDetailDrawer } from "./skill-detail-drawer.jsx";
import { UpdatesView } from "./updates-view.jsx";
import { ProjectsView } from "./projects-view.jsx";

const NAVIGATION = [
  ["inventory", "全部 Skill", "01"],
  ["updates", "更新中心", "02"],
  ["diagnostics", "环境诊断", "03"],
  ["history", "操作历史", "04"],
  ["governance", "管理规范", "05"],
  ["projects", "项目路径", "06"],
];

const SCOPE_METRICS = [
  ["hub", "Hub", "HUB"],
  ["public", "公共", "PUBLIC"],
  ["agent", "Agent", "AGENT"],
  ["project", "项目", "PROJECT"],
];

function countSkillsByScope(skills) {
  const counts = { hub: 0, public: 0, agent: 0, project: 0 };
  for (const skill of skills || []) {
    for (const level of skill.governanceLevels || skill.scopeLevels || []) {
      if (level in counts) counts[level] += 1;
    }
  }
  return counts;
}

export function AppShell() {
  const [view, setView] = useState("inventory");
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const returnFocusRef = useRef(null);

  const load = useCallback(async () => {
    const controller = new AbortController();
    setError(null);
    try { setData(await fetchDashboard(controller.signal)); }
    catch (loadError) { if (loadError.name !== "AbortError") setError(loadError.message); }
    return () => controller.abort();
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    setDetail(null);
    if (!selected) return undefined;
    const controller = new AbortController();
    fetchSkillDetail(selected.id, controller.signal)
      .then((nextDetail) => {
        if (!controller.signal.aborted) setDetail(nextDetail);
      })
      .catch((detailError) => {
        if (detailError.name !== "AbortError" && !controller.signal.aborted) setError(detailError.message);
      });
    return () => controller.abort();
  }, [selected]);

  function openDetail(skill, trigger) {
    returnFocusRef.current = trigger;
    setSelected(skill);
  }

  function handleWorkspaceClick(event) {
    if (!selected) return;
    if (event.target.closest("[data-detail-trigger], a, button, input, select, textarea, label, .column-resizer")) return;
    setSelected(null);
  }

  async function loadHistory(offset) {
    try { setData((current) => ({ ...current, history: { ...current.history, loading: true } }));
      const history = await fetchHistoryPage(offset);
      setData((current) => ({ ...current, history }));
    } catch (historyError) { setError(historyError.message); }
  }

  if (!data && !error) return <div className="center-state"><span className="loading-rule" /><p>正在核对 Skill 治理事实…</p></div>;
  if (error && !data) return <div className="center-state error-state"><p>读取失败：{error}</p><button onClick={load}>重试</button></div>;

  const updateCount = data.overview?.summary?.updateAvailable || 0;
  const errorCount = data.overview?.summary?.diagnostics?.error || 0;
  const scopeCounts = countSkillsByScope(data.skills);
  const visibleDetail = detail?.item?.id === selected?.id ? detail : null;
  return (
    <div className="app-shell" data-sidebar-collapsed={sidebarCollapsed ? "true" : "false"}>
      <aside className="sidebar">
        <button className="sidebar-toggle" aria-label={sidebarCollapsed ? "展开侧栏" : "折叠侧栏"} aria-expanded={!sidebarCollapsed} onClick={() => setSidebarCollapsed((value) => !value)}><span aria-hidden="true">{sidebarCollapsed ? "›" : "‹"}</span></button>
        <header className="brand-block"><span className="brand-index">SCP / 02</span><h1>Skill<br />Ledger</h1><p>统一治理 · 只读事实</p></header>
        <nav className="nav-stack" aria-label="主导航">
          {NAVIGATION.map(([key, label, index]) => <button key={key} title={sidebarCollapsed ? label : undefined} aria-label={label} className={`nav-link ${view === key ? "is-active" : ""}`} onClick={() => setView(key)}>
            <span className="nav-index">{index}</span><span className="nav-label">{label}</span>
            {key === "updates" && updateCount > 0 && <b>{updateCount}</b>}
            {key === "diagnostics" && errorCount > 0 && <b>{errorCount}</b>}
          </button>)}
        </nav>
        <footer className="sidebar-note"><span>LAST SCAN</span><time>{data.overview?.scannedAt ? new Date(data.overview.scannedAt).toLocaleTimeString("zh-CN", { hour12: false }) : "--"}</time><p>Registry 是当前事实总表</p></footer>
      </aside>

      <main className="workspace" onClick={handleWorkspaceClick}>
        <header className="metric-ribbon" aria-label="概览">
          <article className="metric-card"><span className="metric-label">总 Skill 数</span><strong>{data.overview?.summary?.totalSkills || 0}</strong><small>ALL CURRENT RECORDS</small></article>
          <article className="metric-card metric-update"><span className="metric-label">有更新数</span><strong>{updateCount}</strong><small>CONFIRMED UPDATES</small></article>
          <div className="scope-metric-group" aria-label="按层级统计的逻辑 Skill 数量">
            {SCOPE_METRICS.map(([scope, label, caption]) => <article key={scope} className="scope-metric-card" title="按逻辑 Skill 统计；跨层级 Skill 会分别计入">
              <span className="scope-metric-label">{label}</span><strong>{scopeCounts[scope]}</strong><small>{caption}</small>
            </article>)}
          </div>
        </header>

        <div className="view-stage">
          {view === "inventory" && <InventoryView skills={data.skills} projects={data.projects} onOpen={openDetail} />}
          {view === "updates" && <UpdatesView skills={data.skills} onOpen={openDetail} />}
          {view === "diagnostics" && <DiagnosticsView diagnostics={data.diagnostics} skills={data.skills} />}
          {view === "history" && <HistoryView history={data.history} onPage={loadHistory} />}
          {view === "governance" && <GovernanceView registry={data.registry} functions={data.chatFunctions} />}
          {view === "projects" && <ProjectsView projects={data.projects} />}
        </div>
      </main>

      {selected && <SkillDetailDrawer
        skill={visibleDetail?.item || selected}
        documents={visibleDetail?.documents || []}
        onClose={() => setSelected(null)}
        returnFocusRef={returnFocusRef}
      />}
      {error && data && <div className="toast" role="status">{error}<button aria-label="关闭提示" onClick={() => setError(null)}>×</button></div>}
    </div>
  );
}
