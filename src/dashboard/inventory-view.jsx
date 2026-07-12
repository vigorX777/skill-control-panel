import React, { useLayoutEffect, useMemo, useRef, useState } from "react";
import { agentLabel, formatUpdateStatus, getLogicalSourceHref, matchesInventoryFilters, scopeLabel } from "./formatters.js";
import { defaultColumnWidths, INVENTORY_COLUMNS, resizeColumn } from "./inventory-columns.js";

const COLUMN_LABELS = ["Skill 名称", "能力介绍", "层级", "项目", "可见 Agent", "来源", "状态"];

function projectLabel(path) {
  return path?.split("/").filter(Boolean).at(-1) || "--";
}

function activateRow(event, skill, onOpen) {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    onOpen(skill, event.currentTarget);
  }
}

export function InventoryView({ skills, projects = [], onOpen }) {
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState("all");
  const [agent, setAgent] = useState("all");
  const [project, setProject] = useState("all");
  const [kind, setKind] = useState("all");
  const [columnWidths, setColumnWidths] = useState(null);
  const [hoverTooltip, setHoverTooltip] = useState(null);
  const tableRef = useRef(null);
  const frameRef = useRef(null);
  const filtered = useMemo(() => {
    return skills.filter((skill) => matchesInventoryFilters(skill, { query, scope, agent, project, kind }));
  }, [skills, query, scope, agent, project, kind]);
  const hasFilters = query.trim() || scope !== "all" || agent !== "all" || project !== "all" || kind !== "all";

  useLayoutEffect(() => {
    const width = frameRef.current?.clientWidth || 0;
    if (width > 0) setColumnWidths(defaultColumnWidths(width));
  }, []);

  function beginColumnResize(event, index) {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startWidths = columnWidths || defaultColumnWidths(frameRef.current?.clientWidth || 0);
    const move = (moveEvent) => setColumnWidths(resizeColumn(startWidths, index, moveEvent.clientX - startX));
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      document.body.classList.remove("is-resizing-columns");
    };
    document.body.classList.add("is-resizing-columns");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
  }

  function showTooltip(event, text) {
    const rect = event.currentTarget.getBoundingClientRect();
    const hasPointerPosition = event.type.startsWith("pointer");
    const x = hasPointerPosition ? event.clientX : rect.left;
    const y = hasPointerPosition ? event.clientY : rect.bottom;
    setHoverTooltip({
      text,
      left: Math.max(8, Math.min(x + 14, window.innerWidth - 460)),
      top: Math.max(8, Math.min(y + 16, window.innerHeight - 140)),
    });
  }

  function tooltipHandlers(text) {
    return {
      onPointerEnter: (event) => showTooltip(event, text),
      onPointerMove: (event) => showTooltip(event, text),
      onPointerLeave: () => setHoverTooltip(null),
      onFocus: (event) => showTooltip(event, text),
      onBlur: () => setHoverTooltip(null),
    };
  }

  return (
    <section className="ledger-panel inventory-panel" aria-labelledby="inventory-heading">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Inventory / Current facts</p>
          <h2 id="inventory-heading">全部 Skill 库存</h2>
        </div>
        <div className="filters" aria-label="库存筛选">
          <label className="search-field">
            <span className="sr-only">搜索 Skill</span>
            <input aria-label="搜索 Skill" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索名称、能力、来源或路径…" />
          </label>
          <label>
            <span className="sr-only">层级</span>
            <select aria-label="层级" value={scope} onChange={(event) => setScope(event.target.value)}>
              <option value="all">全部层级</option><option value="hub">Hub</option><option value="public">公共</option>
              <option value="agent">Agent</option><option value="project">项目</option>
            </select>
          </label>
          <label><span className="sr-only">项目文件夹</span><select aria-label="项目文件夹" value={project} onChange={(event) => setProject(event.target.value)}><option value="all">所有项目文件夹</option>{projects.map((item) => <option key={item.id} value={item.path}>{item.label}</option>)}</select></label>
          <label><span className="sr-only">类型</span><select aria-label="类型" value={kind} onChange={(event) => setKind(event.target.value)}><option value="all">全部类型</option><option value="public_shared">公共共享</option><option value="project_shared">项目共享</option><option value="agent">Agent</option></select></label>
          <label>
            <span className="sr-only">Agent</span>
            <select aria-label="Agent" value={agent} onChange={(event) => setAgent(event.target.value)}>
              <option value="all">全部 Agent</option><option value="codex">Codex</option>
              <option value="claude">Claude</option><option value="antigravity">Antigravity</option><option value="opencode">OpenCode</option>
            </select>
          </label>
          <span className="filter-count">当前 {filtered.length} / 共 {skills.length}</span>
          {hasFilters && <button className="filter-clear" onClick={() => { setQuery(""); setScope("all"); setAgent("all"); setProject("all"); setKind("all"); }}>清除筛选</button>}
        </div>
      </div>

      <div ref={frameRef} className="table-frame">
        <table ref={tableRef} className="ledger-table inventory-table" style={columnWidths ? { width: `${columnWidths.reduce((sum, width) => sum + width, 0)}px` } : undefined}>
          <colgroup>
            {INVENTORY_COLUMNS.map((column, index) => <col key={column.key} className={`col-${column.key}`} style={columnWidths ? { width: `${columnWidths[index]}px` } : undefined} />)}
          </colgroup>
          <thead><tr>{COLUMN_LABELS.map((label, index) => <th key={INVENTORY_COLUMNS[index].key}>{label}{index < INVENTORY_COLUMNS.length - 1 && <span className="column-resizer" data-column={INVENTORY_COLUMNS[index].key} role="separator" aria-label={`调整${label}列宽`} aria-orientation="vertical" onPointerDown={(event) => beginColumnResize(event, index)} />}</th>)}</tr></thead>
          <tbody>
            {filtered.map((skill) => {
              const status = formatUpdateStatus(skill.update);
              const sourceHref = getLogicalSourceHref(skill);
              const capability = skill.capabilitySummaryZh || "中文介绍生成中";
              const projectPath = skill.projectRoots?.join("\n") || "";
              return (
                <tr
                  key={skill.id}
                  className="inventory-row"
                  data-detail-trigger="true"
                  tabIndex="0"
                  role="button"
                  aria-label={`查看 ${skill.name} 详情`}
                  onClick={(event) => onOpen(skill, event.currentTarget)}
                  onKeyDown={(event) => activateRow(event, skill, onOpen)}
                >
                  <td><span className="skill-name">{skill.name}</span></td>
                  <td>
                    <span className="capability-trigger" tabIndex="0" aria-label={capability} {...tooltipHandlers(capability)}>
                      {capability}
                    </span>
                  </td>
                  <td><div className="chip-list">{(skill.governanceLevels || skill.scopeLevels)?.map((level) => <span key={level} data-scope={level} className={`scope-chip scope-${level}`}>{scopeLabel(level)}</span>)}</div></td>
                  <td><span className="project-path-cell" tabIndex={projectPath ? "0" : undefined} {...(projectPath ? tooltipHandlers(projectPath) : {})}>{skill.projectRoots?.length ? `${projectLabel(skill.projectRoots[0])}${skill.projectRoots.length > 1 ? ` +${skill.projectRoots.length - 1}` : ""}` : "--"}</span></td>
                  <td><div className="chip-list agent-chip-list">{skill.hasSharedAvailability && <span className="shared-chip">声明共享</span>}{skill.agents?.map((name) => <span key={name} data-agent={name} className="agent-chip">{agentLabel(name)}</span>)}</div></td>
                  <td className="source-cell">
                    {skill.sources?.length > 1 ? "多个来源" : sourceHref ? <a href={sourceHref} target="_blank" rel="noreferrer" {...tooltipHandlers(sourceHref)} onClick={(event) => event.stopPropagation()}>查看来源 ↗</a> : "--"}
                  </td>
                  <td><span className={`status-mark tone-${status.tone}`} data-update-status={skill.update?.status || "unknown"}>{status.label}</span></td>
                </tr>
              );
            })}
            {filtered.length === 0 && <tr><td colSpan="7" className="empty-cell">没有符合筛选条件的 Skill</td></tr>}
          </tbody>
        </table>
      </div>
      {hoverTooltip && <div className="inventory-tooltip" role="tooltip" style={{ left: `${hoverTooltip.left}px`, top: `${hoverTooltip.top}px` }}>{hoverTooltip.text}</div>}
    </section>
  );
}
