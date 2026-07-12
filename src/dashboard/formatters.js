const UPDATE_STATES = {
  update_available: { label: "有更新", tone: "warning", countsAsCurrent: false },
  up_to_date: { label: "已是最新", tone: "success", countsAsCurrent: true },
  not_checkable: { label: "不可检查", tone: "neutral", countsAsCurrent: false },
  unknown: { label: "未检查", tone: "neutral", countsAsCurrent: false },
  error: { label: "检查失败", tone: "danger", countsAsCurrent: false },
};

export function formatUpdateStatus(update) {
  if (update?.error) return UPDATE_STATES.error;
  return UPDATE_STATES[update?.status] || UPDATE_STATES.unknown;
}

export function getSourceHref(source) {
  const value = source?.url || source?.repository || null;
  if (!value) return null;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

export function getLogicalSourceHref(skill) {
  if (skill?.sources?.length === 1) return getSourceHref({ url: skill.sources[0] });
  return getSourceHref(skill?.source);
}

export function getUpdateInstances(skill) {
  return (skill?.instances || []).filter((instance) => instance.update?.status === "update_available");
}

export function formatDate(value) {
  if (!value) return "--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  }).format(date);
}

export function formatAgents(agents = []) {
  if (agents.length === 0) return "--";
  if (agents.length <= 2) return agents.join(" · ");
  return `${agents.slice(0, 2).join(" · ")} +${agents.length - 2}`;
}

export function scopeLabel(scope) {
  return { hub: "Hub", public: "公共", agent: "Agent", project: "项目" }[scope] || scope || "--";
}

export function agentLabel(agent) {
  return { codex: "Codex", claude: "Claude", antigravity: "Antigravity", opencode: "OpenCode" }[agent] || agent;
}

export function getSkillSearchText(skill) {
  return [
    skill.name,
    skill.capabilitySummary,
    skill.capabilitySummaryZh,
    ...(skill.projectRoots || []),
    ...(skill.instances || []).flatMap((item) => [
      item.realPath,
      item.scope?.project_root,
      item.source?.url,
      item.source?.repository,
      item.provider,
      item.agentSkillKind,
      item.enabledBasis,
    ]),
  ].filter(Boolean).join(" ").toLocaleLowerCase();
}

export function matchesInventoryFilters(skill, { query = "", scope = "all", agent = "all", project = "all", kind = "all" } = {}) {
  const needle = query.trim().toLocaleLowerCase();
  const kindMatches = kind === "all" || (skill.instances || []).some((item) =>
    (kind === "public_shared" && item.scope?.level === "public") ||
    (kind === "project_shared" && item.scope?.level === "project") ||
    (kind === "agent" && item.scope?.level === "agent") ||
    (kind === `agent_${item.agentSkillKind}`));
  return (!needle || getSkillSearchText(skill).includes(needle))
    && (scope === "all" || (skill.governanceLevels || skill.scopeLevels || []).includes(scope))
    && (agent === "all" || (skill.agents || []).includes(agent))
    && (project === "all" || (skill.projectRoots || []).includes(project))
    && kindMatches;
}

export function updateCommand(skill) {
  const target = skill.instances?.find((instance) => instance.update?.status === "update_available") || skill.instances?.[0] || skill;
  return `npm run skillctl -- update --skill ${target.id} --source <path> --vetted`;
}
