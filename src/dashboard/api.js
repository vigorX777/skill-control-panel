async function fetchJson(path, options = {}) {
  const response = await fetch(path, { ...options, method: "GET" });
  if (!response.ok) throw new Error(`读取 ${path} 失败（${response.status}）`);
  return response.json();
}

export async function fetchDashboard(signal) {
  const request = { signal };
  const [overview, skills, diagnostics, governance, history, projects, chatFunctions] = await Promise.all([
    fetchJson("/api/overview", request),
    fetchJson("/api/skills", request),
    fetchJson("/api/diagnostics", request),
    fetchJson("/api/governance", request),
    fetchJson("/api/history?limit=50", request),
    fetchJson("/api/projects", request),
    fetchJson("/api/chat-functions", request),
  ]);
  return {
    overview,
    skills: skills.items || [],
    diagnostics: diagnostics.diagnostics || [],
    registry: governance.registry || null,
    history,
    projects: projects.items || [],
    chatFunctions: chatFunctions.items || [],
  };
}

export function fetchSkillDetail(skillId, signal) {
  return fetchJson(`/api/skills/${encodeURIComponent(skillId)}`, { signal });
}

export function fetchHistoryPage(offset, signal) {
  return fetchJson(`/api/history?offset=${offset}&limit=50`, { signal });
}
