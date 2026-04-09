import React, { useDeferredValue, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";

const RUN_STATUS_OPTIONS = ["enabled", "disabled", "partial"];
const RUN_STATUS_LABELS = {
  enabled: "已启用",
  disabled: "已停用",
  partial: "部分启用",
};
const RUN_STATUS_CLASS_NAMES = {
  enabled: "active",
  disabled: "candidate",
  partial: "partial",
};
const ACTION_LABELS = {
  enable: "启用",
  disable: "停用",
  uninstall: "删除",
};
const PROVIDER_THEME_LABELS = {
  claude: "Claude Code",
  codex: "OpenAI Codex",
  gemini: "Gemini CLI",
  agents: "Agents",
  opencode: "OpenCode",
};
function useDashboardData(refreshTick) {
  const [state, setState] = useState({
    loading: true,
    error: null,
    scannedAt: null,
    summary: null,
    skills: [],
    providers: [],
  });

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setState((current) => ({ ...current, loading: true, error: null }));

      try {
        const [summaryRes, skillsRes, providersRes] = await Promise.all([
          fetch("/api/summary"),
          fetch("/api/skills"),
          fetch("/api/providers"),
        ]);

        const responses = [summaryRes, skillsRes, providersRes];
        const failing = responses.find((response) => !response.ok);

        if (failing) {
          const payload = await failing.json().catch(() => ({}));
          throw new Error(payload?.error?.message || "加载数据失败");
        }

        const [summary, skills, providers] = await Promise.all(
          responses.map((response) => response.json()),
        );

        if (cancelled) {
          return;
        }

        setState({
          loading: false,
          error: null,
          scannedAt: summary.scannedAt,
          summary: summary.summary,
          skills: skills.items,
          providers: providers.items,
        });
      } catch (error) {
        if (cancelled) {
          return;
        }

        setState((current) => ({
          ...current,
          loading: false,
          error: error.message,
        }));
      }
    }

    load();

    return () => {
      cancelled = true;
    };
  }, [refreshTick]);

  return state;
}

function formatScannedAt(iso) {
  if (!iso) {
    return "尚未扫描";
  }

  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(iso));
}

function runStatusBreakdown(skills) {
  const counts = new Map(RUN_STATUS_OPTIONS.map((status) => [status, 0]));

  for (const skill of skills) {
    const status = skill.runStatus || "enabled";
    counts.set(status, (counts.get(status) || 0) + 1);
  }

  return RUN_STATUS_OPTIONS.map((status) => ({
    key: status,
    label: RUN_STATUS_LABELS[status],
    count: counts.get(status) || 0,
  })).filter((item) => item.count > 0);
}

function providerThemeName(providerNames) {
  if (providerNames.length !== 1) {
    return "theme-default";
  }

  return `theme-${providerNames[0]}`;
}

function providerRuntimeLabel(skill) {
  return `${skill.runtimeSummary?.enabledProviders || 0}/${skill.runtimeSummary?.totalProviders || 0} 已启用`;
}

function statusLabelClass(runStatus) {
  return RUN_STATUS_CLASS_NAMES[runStatus] || RUN_STATUS_CLASS_NAMES.enabled;
}

function FavoriteButton({ active, onClick, title }) {
  return (
    <button
      className={`favorite-button ${active ? "is-active" : ""}`}
      onClick={onClick}
      title={title}
      aria-pressed={active}
    >
      <span aria-hidden="true">{active ? "★" : "☆"}</span>
    </button>
  );
}

function ProviderIcon({ name }) {
  if (name === "claude") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M17.304 3.541h-3.672l6.696 16.918H24Zm-10.608 0L0 20.459h3.744l1.369-3.553h7.006l1.369 3.553h3.744L10.536 3.54Zm-.371 10.223 2.291-5.946 2.291 5.946Z" />
      </svg>
    );
  }

  if (name === "codex") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M9.17 2.96a3.15 3.15 0 0 1 4.3 1.15l.47.8.86-.5a3.16 3.16 0 0 1 4.3 1.16 3.14 3.14 0 0 1-1.15 4.3l-.8.47.5.86a3.14 3.14 0 0 1-1.16 4.3 3.15 3.15 0 0 1-4.3-1.15l-.47-.8-.86.5a3.16 3.16 0 0 1-4.3-1.16 3.14 3.14 0 0 1 1.15-4.3l.8-.47-.5-.86A3.14 3.14 0 0 1 9.17 2.96Zm1.06 2.36a1.44 1.44 0 0 0-.52 1.97l1.28 2.22-2.22 1.28a1.44 1.44 0 0 0-.52 1.97 1.44 1.44 0 0 0 1.97.53l2.22-1.29 1.28 2.22a1.44 1.44 0 0 0 1.97.53 1.44 1.44 0 0 0 .53-1.98l-1.29-2.22 2.22-1.28a1.44 1.44 0 0 0 .53-1.97 1.44 1.44 0 0 0-1.98-.53l-2.22 1.29-1.28-2.22a1.44 1.44 0 0 0-1.97-.53Z" />
      </svg>
    );
  }

  if (name === "gemini") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81" />
      </svg>
    );
  }

  if (name === "agents") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M6.5 9.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Zm11 0a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Zm-5.5 10a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Zm-3.39-8.4 2.11 3.1m4.67 0 2.11-3.1M9 7h6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }

  if (name === "opencode") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M7.2 6.2 3 10.5l4.2 4.3M16.8 6.2 21 10.5l-4.2 4.3M13.6 4.8l-3.2 11.4" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="7" />
    </svg>
  );
}

function MultiSelectField({
  label,
  placeholder,
  options,
  selectedValues,
  onToggle,
  summaryText,
  isOpen,
  onOpen,
  onClose,
  single = false,
}) {
  const selectedOptions = options.filter((option) => selectedValues.includes(option.value));
  const summaryLabel = selectedOptions.length
    ? summaryText || `已选 ${selectedOptions.length} 项`
    : placeholder;

  return (
    <div className="field field-multi">
      <span>{label}</span>
      <div
        className={`multi-select ${isOpen ? "is-open" : ""}`}
        onClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          className="multi-select-trigger"
          aria-expanded={isOpen}
          onClick={() => (isOpen ? onClose() : onOpen())}
        >
          <span
            className={`multi-select-value ${selectedOptions.length ? "has-value" : "is-placeholder"}`}
          >
            {summaryLabel}
          </span>
          <span className={`multi-select-caret ${isOpen ? "is-open" : ""}`} aria-hidden="true">
            ▾
          </span>
        </button>

        {isOpen ? (
          <div className="multi-select-panel">
            {options.map((option) => (
              <label
                key={option.value}
                className={`multi-select-option ${single ? "is-single" : ""} ${
                  selectedValues.includes(option.value) ? "is-selected" : ""
                }`}
              >
                <input
                  type={single ? "radio" : "checkbox"}
                  name={single ? `${label}-single-select` : undefined}
                  checked={selectedValues.includes(option.value)}
                  onChange={() => {
                    onToggle(option.value);
                    if (single) {
                      onClose();
                    }
                  }}
                />
                {option.icon ? <span className="multi-select-icon">{option.icon}</span> : null}
                <span className="multi-select-label">{option.label}</span>
              </label>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function App() {
  const [refreshTick, setRefreshTick] = useState(0);
  const { loading, error, scannedAt, summary, skills, providers } = useDashboardData(refreshTick);
  const [selectedId, setSelectedId] = useState(null);
  const [favoriteOverrides, setFavoriteOverrides] = useState({});
  const [openFilterKey, setOpenFilterKey] = useState("");
  const [filters, setFilters] = useState({
    query: "",
    statuses: [],
    tags: [],
    provider: "",
    favoritesOnly: false,
  });
  const [pendingKey, setPendingKey] = useState(null);
  const [feedback, setFeedback] = useState({
    message: "",
    error: "",
  });
  const deferredQuery = useDeferredValue(filters.query);
  const skillsWithOverrides = useMemo(
    () =>
      skills.map((skill) =>
        Object.prototype.hasOwnProperty.call(favoriteOverrides, skill.id)
          ? { ...skill, favorite: favoriteOverrides[skill.id] }
          : skill,
      ),
    [favoriteOverrides, skills],
  );

  const visibleProviders = useMemo(
    () => providers.filter((provider) => provider.uniqueSkillCount > 0),
    [providers],
  );

  useEffect(() => {
    function closeFilters() {
      setOpenFilterKey("");
    }

    document.addEventListener("click", closeFilters);
    return () => document.removeEventListener("click", closeFilters);
  }, []);

  const tagOptions = useMemo(() => {
    return [...new Set(skillsWithOverrides.flatMap((skill) => skill.tags || []).filter(Boolean))].sort((a, b) =>
      a.localeCompare(b, "zh-Hans-CN"),
    );
  }, [skillsWithOverrides]);
  const activeThemeClass = providerThemeName(filters.provider ? [filters.provider] : []);
  const activeThemeLabel =
    filters.provider ? PROVIDER_THEME_LABELS[filters.provider] || "" : "";

  const visibleSkills = useMemo(() => {
    const query = deferredQuery.trim().toLowerCase();

    return skillsWithOverrides.filter((skill) => {
      if (filters.favoritesOnly && !skill.favorite) {
        return false;
      }

      if (query) {
        const haystack = [
          skill.name,
          skill.description,
          ...(skill.tags || []),
          ...skill.providers.map((provider) => provider.label),
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();

        if (!haystack.includes(query)) {
          return false;
        }
      }

      if (filters.statuses.length && !filters.statuses.includes(skill.runStatus)) {
        return false;
      }

      if (filters.tags.length && !filters.tags.some((tag) => (skill.tags || []).includes(tag))) {
        return false;
      }

      if (
        filters.provider &&
        !skill.providers.some((provider) => provider.name === filters.provider)
      ) {
        return false;
      }

      return true;
    });
  }, [deferredQuery, filters, skillsWithOverrides]);

  const selectedSkill =
    visibleSkills.find((skill) => skill.id === selectedId) ||
    visibleSkills[0] ||
    skillsWithOverrides.find((skill) => skill.id === selectedId) ||
    skillsWithOverrides[0] ||
    null;

  useEffect(() => {
    if (!selectedSkill) {
      return;
    }

    if (selectedId !== selectedSkill.id) {
      setSelectedId(selectedSkill.id);
    }
  }, [selectedId, selectedSkill]);

  function updateFilters(patch) {
    setFilters((current) => ({
      ...current,
      ...patch,
    }));
  }

  function toggleMultiFilter(key, value) {
    setFilters((current) => {
      const next = current[key].includes(value)
        ? current[key].filter((item) => item !== value)
        : [...current[key], value];

      return {
        ...current,
        [key]: next,
      };
    });
  }

  function clearAllFilters() {
    setFilters({
      query: "",
      statuses: [],
      tags: [],
      provider: "",
      favoritesOnly: false,
    });
  }

  async function performProviderAction(skillId, providerName, action) {
    const response = await fetch(
      `/api/skills/${encodeURIComponent(skillId)}/providers/${encodeURIComponent(providerName)}/action`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      },
    );
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload?.error?.message || "操作失败");
    }
    return payload;
  }

  async function performSkillAction(skillId, action) {
    const response = await fetch(`/api/skills/${encodeURIComponent(skillId)}/action`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action }),
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload?.error?.message || "操作失败");
    }
    return payload;
  }

  async function patchSkillMetadata(skillId, patch) {
    const response = await fetch(`/api/metadata/${encodeURIComponent(skillId)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload?.error?.message || "更新失败");
    }
    return payload;
  }

  async function handleFavoriteToggle(skill, nextFavorite) {
    const actionKey = `favorite:${skill.id}`;
    setPendingKey(actionKey);
    setFeedback({ message: "", error: "" });
    setFavoriteOverrides((current) => ({
      ...current,
      [skill.id]: nextFavorite,
    }));

    try {
      await patchSkillMetadata(skill.id, { favorite: nextFavorite });
      setFeedback({
        message: nextFavorite ? `${skill.name} 已加入收藏` : `${skill.name} 已取消收藏`,
        error: "",
      });
    } catch (actionError) {
      setFavoriteOverrides((current) => {
        const next = { ...current };
        delete next[skill.id];
        return next;
      });
      setFeedback({
        message: "",
        error: actionError.message,
      });
    } finally {
      setPendingKey(null);
    }
  }

  async function handleSkillAction(action) {
    if (!selectedSkill) {
      return;
    }

    if (
      action === "uninstall" &&
      !window.confirm(
        `确认删除 ${selectedSkill.name} 在全部 ${selectedSkill.runtimeSummary?.totalProviders || 0} 个 provider 下的暴露吗？`,
      )
    ) {
      return;
    }

    const actionKey = `skill:${selectedSkill.id}:${action}`;
    setPendingKey(actionKey);
    setFeedback({ message: "", error: "" });

    try {
      const payload = await performSkillAction(selectedSkill.id, action);
      setFeedback({
        message: `${selectedSkill.name} ${ACTION_LABELS[action]}完成：${payload.result.successCount}/${payload.result.affectedProviderCount} 个 provider 成功`,
        error: "",
      });
      setRefreshTick((value) => value + 1);
    } catch (actionError) {
      setFeedback({
        message: "",
        error: actionError.message,
      });
    } finally {
      setPendingKey(null);
    }
  }

  async function handleProviderAction(provider, action) {
    if (!selectedSkill) {
      return;
    }

    if (
      action === "uninstall" &&
      !window.confirm(`确认删除 ${selectedSkill.name} 在 ${provider.label} 下的暴露吗？`)
    ) {
      return;
    }

    const actionKey = `${selectedSkill.id}:${provider.name}:${action}`;
    setPendingKey(actionKey);
    setFeedback({ message: "", error: "" });

    try {
      await performProviderAction(selectedSkill.id, provider.name, action);
      setFeedback({
        message: `${provider.label} · ${action === "enable" ? "启用" : action === "disable" ? "停用" : "删除"}已完成`,
        error: "",
      });
      setRefreshTick((value) => value + 1);
    } catch (actionError) {
      setFeedback({
        message: "",
        error: actionError.message,
      });
    } finally {
      setPendingKey(null);
    }
  }

  const hasActiveFilters = Boolean(
    filters.query ||
      filters.statuses.length ||
      filters.tags.length ||
      filters.provider ||
      filters.favoritesOnly,
  );

  const overviewCards = useMemo(() => {
    return [
      {
        label: "去重 Skill",
        value: `${summary?.uniqueSkills || skills.length}`,
        note: "总量",
      },
      {
        label: "实例",
        value: `${summary?.totalSkillInstances || 0}`,
        note: "全部暴露",
      },
      {
        label: "启用数",
        value: `${skillsWithOverrides.filter((skill) => skill.runStatus !== "disabled").length}`,
        note: "已启用 + 部分启用",
      },
      {
        label: "Provider",
        value: `${visibleProviders.length}`,
        note: "可见来源",
      },
      {
        label: "停用数",
        value: `${skillsWithOverrides.filter((skill) => skill.runStatus === "disabled").length}`,
        note: "完全停用",
      },
      {
        label: "收藏",
        value: `${skillsWithOverrides.filter((skill) => skill.favorite).length}`,
        note: "已星标",
      },
    ];
  }, [hasActiveFilters, skillsWithOverrides, summary, visibleProviders.length, visibleSkills.length]);

  const activeFilterItems = useMemo(() => {
    const items = [];

    if (filters.query) {
      items.push({
        key: `query:${filters.query}`,
        label: `搜索：${filters.query}`,
        onClear: () => updateFilters({ query: "" }),
      });
    }

    for (const status of filters.statuses) {
      items.push({
        key: `status:${status}`,
        label: `状态：${RUN_STATUS_LABELS[status]}`,
        onClear: () => toggleMultiFilter("statuses", status),
      });
    }

    for (const tag of filters.tags) {
      items.push({
        key: `tag:${tag}`,
        label: `标签：${tag}`,
        onClear: () => toggleMultiFilter("tags", tag),
      });
    }

    if (filters.provider) {
      const provider = filters.provider;
      items.push({
        key: `provider:${provider}`,
        label: `Provider：${PROVIDER_THEME_LABELS[provider] || provider}`,
        onClear: () => updateFilters({ provider: "" }),
      });
    }

    if (filters.favoritesOnly) {
      items.push({
        key: "favorites",
        label: "仅看收藏",
        onClear: () => updateFilters({ favoritesOnly: false }),
      });
    }

    return items;
  }, [filters]);

  if (loading) {
    return <div className="loading-state">正在加载 Skill 控制台…</div>;
  }

  if (error) {
    return (
      <div className="app-shell">
        <div className="error-state card">
          <h2>Skill 控制台暂不可用</h2>
          <p>{error}</p>
          <button className="button button-primary" onClick={() => setRefreshTick((value) => value + 1)}>
            重新扫描
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={`app-shell ${activeThemeClass}`}>
      <header className="topbar">
        <div>
          <div className="topbar-title">Skill 控制台</div>
          <div className="topbar-meta">
            最近扫描：{formatScannedAt(scannedAt)}
            {activeThemeLabel ? ` · 当前 Provider：${activeThemeLabel}` : ""}
          </div>
        </div>
        <button className="button button-primary button-icon" onClick={() => setRefreshTick((value) => value + 1)}>
          <span aria-hidden="true">↻</span>
          <span>重新扫描</span>
        </button>
      </header>

      <main className="workspace">
        <section className="browser card">
          <div className="browser-head">
            <div className="browser-head-main">
              <div>
                <h2>Skill 列表</h2>
                <div className="section-meta">状态只表示当前 skill 在全部 provider 维度上的聚合运行结果。</div>
              </div>
              <div className="section-meta">
                当前显示 {visibleSkills.length} / {summary?.uniqueSkills || skills.length} 个 Skill
              </div>
            </div>

            <div className="stats-rail" aria-label="当前概况">
              {overviewCards.map((card) => (
                <div key={card.label} className="stats-chip">
                  <span className="stats-chip-label">{card.label}</span>
                  <strong className="stats-chip-value">{card.value}</strong>
                  <span className="stats-chip-note">{card.note}</span>
                </div>
              ))}
            </div>

            <div className="browser-insights">
              <div className="insight-strip">
                <span className="insight-label">Provider</span>
                {visibleProviders.map((provider) => (
                  <button
                    key={provider.name}
                    className={`provider-filter-chip ${
                      filters.provider === provider.name ? "is-active" : ""
                    }`}
                    onClick={() =>
                      updateFilters({
                        provider: filters.provider === provider.name ? "" : provider.name,
                      })
                    }
                  >
                    <span className={`provider-mark provider-mark-icon provider-mark-${provider.name}`}>
                      <ProviderIcon name={provider.name} />
                    </span>
                    <span>{provider.label}</span>
                    <strong>{provider.uniqueSkillCount}</strong>
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="filter-toolbar">
            <label className="field field-search">
              <span>搜索</span>
              <input
                value={filters.query}
                onChange={(event) => updateFilters({ query: event.target.value })}
                placeholder="搜索名称、简介、标签、Provider"
              />
            </label>

            <MultiSelectField
              label="状态"
              placeholder="全部状态"
              options={RUN_STATUS_OPTIONS.map((status) => ({
                value: status,
                label: RUN_STATUS_LABELS[status],
              }))}
              selectedValues={filters.statuses}
              onToggle={(value) => toggleMultiFilter("statuses", value)}
              summaryText={filters.statuses.length ? `已选 ${filters.statuses.length} 项` : ""}
              isOpen={openFilterKey === "statuses"}
              onOpen={() => setOpenFilterKey("statuses")}
              onClose={() => setOpenFilterKey("")}
            />

            <MultiSelectField
              label="标签"
              placeholder="全部标签"
              options={tagOptions.map((tag) => ({
                value: tag,
                label: tag,
              }))}
              selectedValues={filters.tags}
              onToggle={(value) => toggleMultiFilter("tags", value)}
              summaryText={filters.tags.length ? `已选 ${filters.tags.length} 项` : ""}
              isOpen={openFilterKey === "tags"}
              onOpen={() => setOpenFilterKey("tags")}
              onClose={() => setOpenFilterKey("")}
            />

            <MultiSelectField
              label="Provider"
              placeholder="全部 Provider"
              options={visibleProviders.map((provider) => ({
                value: provider.name,
                label: provider.label,
                icon: <ProviderIcon name={provider.name} />,
              }))}
              selectedValues={filters.provider ? [filters.provider] : []}
              onToggle={(value) =>
                updateFilters({
                  provider: filters.provider === value ? "" : value,
                })
              }
              summaryText={filters.provider ? PROVIDER_THEME_LABELS[filters.provider] || filters.provider : ""}
              isOpen={openFilterKey === "provider"}
              onOpen={() => setOpenFilterKey("provider")}
              onClose={() => setOpenFilterKey("")}
              single
            />

            <div className="filter-tools">
              <button
                className={`button button-secondary ${filters.favoritesOnly ? "is-toggle-active" : ""}`}
                onClick={() => updateFilters({ favoritesOnly: !filters.favoritesOnly })}
              >
                {filters.favoritesOnly ? "只看收藏中" : "只看收藏"}
              </button>
            </div>
          </div>

          {activeFilterItems.length ? (
            <div className="active-filter-list" aria-label="当前筛选条件">
              {activeFilterItems.map((item) => (
                <button key={item.key} className="active-filter-pill" onClick={item.onClear}>
                  <span>{item.label}</span>
                  <span aria-hidden="true">×</span>
                </button>
              ))}
              {hasActiveFilters ? (
                <button className="text-link clear-all-button" onClick={clearAllFilters}>
                  清除全部
                </button>
              ) : null}
            </div>
          ) : null}

          {visibleSkills.length ? (
            <div className="skill-grid">
              {visibleSkills.map((skill) => (
                <article
                  key={skill.id}
                  className={`skill-card ${selectedSkill?.id === skill.id ? "is-selected" : ""}`}
                  role="button"
                  tabIndex={0}
                  aria-pressed={selectedSkill?.id === skill.id}
                  onClick={() => setSelectedId(skill.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setSelectedId(skill.id);
                    }
                  }}
                >
                  <div className="skill-card-header">
                    <div>
                      <div className="skill-title-row">
                        <h3>{skill.name}</h3>
                        <FavoriteButton
                          active={skill.favorite}
                          title={skill.favorite ? "取消收藏" : "加入收藏"}
                          onClick={(event) => {
                            event.stopPropagation();
                            handleFavoriteToggle(skill, !skill.favorite);
                          }}
                        />
                      </div>
                      <div className="skill-card-runtime">{providerRuntimeLabel(skill)}</div>
                    </div>
                    <span className={`status-badge status-badge-${statusLabelClass(skill.runStatus)}`}>
                      <span className="status-dot" />
                      <span>{RUN_STATUS_LABELS[skill.runStatus]}</span>
                    </span>
                  </div>

                  <div className="skill-card-body">
                    <p className="line-clamp-3" title={skill.description || "暂无描述"}>
                      {skill.description || "暂无描述"}
                    </p>
                  </div>

                  <div className="skill-card-footer">
                    <div className="tag-row">
                      {(skill.tags || []).map((tag) => (
                        <span key={`${skill.id}-${tag}`} className="tag-chip tag-chip-strong">
                          {tag}
                        </span>
                      ))}
                    </div>

                    <div className="provider-row">
                      {skill.providers.map((provider) => (
                        <span
                          key={`${skill.id}-${provider.name}`}
                          className={`provider-inline ${provider.exposureState === "disabled" ? "is-disabled" : ""}`}
                        >
                          <span className={`provider-mark provider-mark-icon provider-mark-${provider.name}`}>
                            <ProviderIcon name={provider.name} />
                          </span>
                          <span>{provider.label}</span>
                        </span>
                      ))}
                    </div>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="empty-block">当前筛选条件下没有 Skill，可尝试清空筛选或切换收藏视图。</div>
          )}
        </section>

        <aside className="detail detail-pane card">
          {selectedSkill ? (
            <>
              <div className="detail-header">
                <div className="detail-title-row">
                  <div>
                    <div className="detail-title-main">
                      <h2>{selectedSkill.name}</h2>
                      <FavoriteButton
                        active={selectedSkill.favorite}
                        title={selectedSkill.favorite ? "取消收藏" : "加入收藏"}
                        onClick={() => handleFavoriteToggle(selectedSkill, !selectedSkill.favorite)}
                      />
                    </div>
                  </div>
                  <span className={`status-badge status-badge-${statusLabelClass(selectedSkill.runStatus)}`}>
                    <span className="status-dot" />
                    <span>{RUN_STATUS_LABELS[selectedSkill.runStatus]}</span>
                  </span>
                </div>

                <p className="detail-description">{selectedSkill.description || "暂无描述"}</p>
              </div>

              <section className="detail-section detail-section-spaced">
                <div className="detail-label">功能标签</div>
                <div className="tag-row">
                  {(selectedSkill.tags || []).map((tag) => (
                    <span key={`${selectedSkill.id}-detail-${tag}`} className="tag-chip tag-chip-strong">
                      {tag}
                    </span>
                  ))}
                </div>
              </section>

              <section className="detail-section">
                <div className="detail-label">真实路径</div>
                <code>{selectedSkill.realPath}</code>
              </section>

              <section className="detail-section">
                <div className="detail-section-head">
                  <div>
                    <div className="detail-label">Provider 运行明细</div>
                    <div className="section-meta">以下操作将同时作用于该 Skill 的所有 Provider 暴露。</div>
                  </div>
                  <div className="run-status-panel">
                    <div className="inline-actions">
                      <button
                        className="button button-primary"
                        disabled={pendingKey === `skill:${selectedSkill.id}:enable`}
                        onClick={() => handleSkillAction("enable")}
                      >
                        {pendingKey === `skill:${selectedSkill.id}:enable` ? "处理中..." : ACTION_LABELS.enable}
                      </button>
                      <button
                        className="button button-secondary"
                        disabled={pendingKey === `skill:${selectedSkill.id}:disable`}
                        onClick={() => handleSkillAction("disable")}
                      >
                        {pendingKey === `skill:${selectedSkill.id}:disable` ? "处理中..." : ACTION_LABELS.disable}
                      </button>
                      <button
                        className="button button-danger"
                        disabled={pendingKey === `skill:${selectedSkill.id}:uninstall`}
                        onClick={() => handleSkillAction("uninstall")}
                      >
                        {pendingKey === `skill:${selectedSkill.id}:uninstall` ? "处理中..." : ACTION_LABELS.uninstall}
                      </button>
                    </div>
                  </div>
                </div>

                <div className="provider-detail-list">
                  {selectedSkill.providers.map((provider) => {
                    const enableKey = `${selectedSkill.id}:${provider.name}:enable`;
                    const disableKey = `${selectedSkill.id}:${provider.name}:disable`;
                    const uninstallKey = `${selectedSkill.id}:${provider.name}:uninstall`;
                    const isDisabled = provider.exposureState === "disabled";

                    return (
                      <article
                        key={`${selectedSkill.id}-${provider.name}-${provider.path}`}
                        className={`provider-detail-card ${isDisabled ? "is-muted" : ""}`}
                      >
                        <div className="provider-detail-head">
                          <div>
                            <div className="provider-heading">
                              <span className={`provider-mark provider-mark-icon provider-mark-${provider.name}`}>
                                <ProviderIcon name={provider.name} />
                              </span>
                              <strong>{provider.label}</strong>
                            </div>
                            <div className="detail-copy">
                              {formatScannedAt(provider.disabledAt) !== "尚未扫描" && isDisabled
                                ? `停用时间：${formatScannedAt(provider.disabledAt)}`
                                : provider.exposureState === "enabled"
                                  ? "当前处于启用状态"
                                  : "当前处于停用状态"}
                            </div>
                          </div>
                          <span className={`status-text status-text-${isDisabled ? "candidate" : "active"}`}>
                            <span className="status-dot" />
                            <span>{isDisabled ? "已停用" : "已启用"}</span>
                          </span>
                        </div>

                        <div className="path-block">
                          <div className="path-subitem">
                            <div className="path-label">{provider.label} 暴露路径</div>
                            <code>{provider.path}</code>
                          </div>
                        </div>

                        <div className="action-row">
                          <button
                            className="button button-primary action-button"
                            disabled={provider.exposureState === "enabled" || pendingKey !== null}
                            onClick={() => handleProviderAction(provider, "enable")}
                          >
                            {pendingKey === enableKey ? "处理中..." : "启用"}
                          </button>
                          <button
                            className="button button-secondary action-button"
                            disabled={provider.exposureState === "disabled" || pendingKey !== null}
                            onClick={() => handleProviderAction(provider, "disable")}
                          >
                            {pendingKey === disableKey ? "处理中..." : "停用"}
                          </button>
                          <button
                            className="button button-danger action-button"
                            disabled={pendingKey !== null}
                            onClick={() => handleProviderAction(provider, "uninstall")}
                          >
                            {pendingKey === uninstallKey ? "处理中..." : "删除"}
                          </button>
                        </div>
                      </article>
                    );
                  })}
                </div>

                <div className="sr-only" aria-live="polite">
                  {feedback.message}
                </div>
                <div className="sr-only" aria-live="assertive">
                  {feedback.error}
                </div>
                {feedback.message ? (
                  <div className="inline-note success" role="status">
                    {feedback.message}
                  </div>
                ) : null}
                {feedback.error ? (
                  <div className="inline-note error" role="alert">
                    {feedback.error}
                  </div>
                ) : null}
              </section>
            </>
          ) : (
            <div className="empty-block">请选择一个 Skill 查看详情。</div>
          )}
        </aside>
      </main>
    </div>
  );
}

const root = createRoot(document.getElementById("root"));
root.render(<App />);
