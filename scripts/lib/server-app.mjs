import { createServer } from "node:http";
import { lstat, readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

import { readRegistry } from "./registry.mjs";
import { readHistory } from "./history.mjs";
import { scan } from "./manager.mjs";
import { readSkillDocument } from "./scanner.mjs";
import { aggregateSkillInstances, summarizeLogicalSkills } from "./skill-aggregation.mjs";
import { readTranslations, translationForInstance } from "./translations.mjs";
import { listProjectRoots, projectRootId } from "./project-roots.mjs";
import { CHAT_FUNCTIONS } from "./chat-functions.mjs";
import { governanceLevelsForInstance, hubFactForInstance, readSkillHubModel } from "./skill-hub-model.mjs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ASSET_DIR = normalize(join(__dirname, "..", "..", "assets", "dashboard"));

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function jsonResponse(response, statusCode, body) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

function notFound(response) {
  jsonResponse(response, 404, { error: { message: "Not found" } });
}

function methodNotAllowed(response) {
  jsonResponse(response, 405, { error: { message: "Method not allowed" } });
}

async function serveStatic(pathname, response) {
  const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const filePath = join(ASSET_DIR, relativePath);
  const normalized = normalize(filePath);

  if (!normalized.startsWith(ASSET_DIR)) {
    notFound(response);
    return;
  }

  try {
    const file = await readFile(normalized);
    response.writeHead(200, {
      "content-type": MIME_TYPES[extname(normalized)] || "application/octet-stream",
      "cache-control": "no-store",
    });
    response.end(file);
  } catch (error) {
    if (pathname !== "/" && pathname !== "/index.html") {
      await serveStatic("/", response);
      return;
    }
    notFound(response);
  }
}

export function createSkillControlServer(options = {}) {
  let scanCache = null;
  let lastScanTime = 0;
  let scanPromise = null;
  const scanFn = options.scanFn || scan;
  const cacheTtlMs = options.cacheTtlMs ?? 2000;

  function startScan() {
    let pending;
    pending = Promise.resolve()
      .then(() => scanFn(options))
      .then(async (result) => {
        const [translations, hub] = await Promise.all([readTranslations(options), readSkillHubModel(options)]);
        const instances = result.skills.map((instance) => {
          const translation = translationForInstance(instance, translations);
          const shared = instance.scope.level === "public" || instance.scope.level === "project";
          const basis = instance.scope.level === "public" ? "public_shared" : instance.scope.level === "project" ? "project_shared" : instance.agentSkillKind === "system" ? "agent_system" : instance.agentSkillKind === "plugin" ? "agent_plugin" : "agent_private";
          const visibilityBasis = [basis];
          if (instance.routes?.length) visibilityBasis.push("routed");
          const availabilityLabel = shared ? "声明共享" : `${({ codex: "Codex", claude: "Claude", antigravity: "Antigravity", opencode: "OpenCode" })[instance.scope.agent] || instance.scope.agent} 专属`;
          const hubEntity = hubFactForInstance(instance, hub);
          return {
            ...instance,
            capabilitySummaryOriginal: instance.capabilitySummary,
            capabilitySummaryZh: translation.translatedText,
            translationStatus: translation.status,
            visibilityBasis,
            availabilityLabel,
            governanceLevels: governanceLevelsForInstance(instance, hub),
            hubEntity,
          };
        });
        const skills = aggregateSkillInstances(instances).map((skill) => ({
          ...skill,
          governanceLevels: [...new Set(skill.instances.flatMap((item) => item.governanceLevels || []))],
          projectRoots: [...new Set(skill.instances.map((item) => item.scope?.project_root).filter(Boolean))],
          capabilitySummaryZh: skill.instances.find((item) => item.capabilitySummaryZh)?.capabilitySummaryZh || null,
          capabilityTranslationStatus: skill.instances.every((item) => item.translationStatus === "ready") ? "ready" : skill.instances.some((item) => item.translationStatus === "stale") ? "stale" : skill.instances.some((item) => item.translationStatus === "error") ? "error" : "pending",
          visibilityBasis: [...new Set(skill.instances.flatMap((item) => item.visibilityBasis))],
          availabilityLabels: [...new Set(skill.instances.map((item) => item.availabilityLabel))],
        }));
        const dashboardResult = {
          ...result,
          skills,
          summary: summarizeLogicalSkills(skills, result.summary.diagnostics),
        };
        scanCache = dashboardResult;
        lastScanTime = Date.now();
        return dashboardResult;
      })
      .finally(() => {
        if (scanPromise === pending) scanPromise = null;
      });
    scanPromise = pending;
    return pending;
  }

  function getScanCache() {
    if (scanCache && Date.now() - lastScanTime <= cacheTtlMs) return Promise.resolve(scanCache);
    return scanPromise || startScan();
  }

  async function refreshSnapshot() {
    while (scanPromise) await scanPromise.catch(() => {});
    return startScan();
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");

    try {
      if (url.pathname.startsWith("/api/")) {
        if (request.method !== "GET") {
          for await (const _chunk of request) {
            // Drain rejected request bodies so the connection closes cleanly.
          }
          methodNotAllowed(response);
          return;
        }

        if (url.pathname === "/api/overview") {
          const scanResult = await getScanCache();
          jsonResponse(response, 200, {
            scannedAt: scanResult.scannedAt,
            summary: scanResult.summary,
          });
          return;
        }

        if (url.pathname === "/api/skills") {
          const scanResult = await getScanCache();
          jsonResponse(response, 200, {
            scannedAt: scanResult.scannedAt,
            items: scanResult.skills,
          });
          return;
        }

        if (url.pathname.startsWith("/api/skills/")) {
          const skillId = decodeURIComponent(url.pathname.replace("/api/skills/", ""));
          const scanResult = await getScanCache();
          const skill = scanResult.skills.find((s) => s.id === skillId);

          if (!skill) {
            notFound(response);
            return;
          }

          const documents = await Promise.all(skill.instances.map(async (instance) => {
            try {
              return {
                instanceId: instance.id,
                path: instance.skillMdPath,
                ...(await readSkillDocument(instance)),
                error: null,
              };
            } catch (error) {
              return { instanceId: instance.id, path: instance.skillMdPath, content: null, byteSize: 0, error: error.message };
            }
          }));

          jsonResponse(response, 200, {
            item: skill,
            documents,
          });
          return;
        }

        if (url.pathname === "/api/updates") {
          const scanResult = await getScanCache();
          const items = scanResult.skills.filter(
            (s) => s.update && s.update.status === "update_available",
          );
          jsonResponse(response, 200, {
            scannedAt: scanResult.scannedAt,
            items,
          });
          return;
        }

        if (url.pathname === "/api/diagnostics") {
          const scanResult = await getScanCache();
          jsonResponse(response, 200, {
            scannedAt: scanResult.scannedAt,
            diagnostics: scanResult.diagnostics,
          });
          return;
        }

        if (url.pathname === "/api/history") {
          const offset = url.searchParams.has("offset")
            ? parseInt(url.searchParams.get("offset"), 10)
            : 0;
          const limit = url.searchParams.has("limit")
            ? parseInt(url.searchParams.get("limit"), 10)
            : 50;
          const skillId = url.searchParams.get("skillId") || undefined;
          const action = url.searchParams.get("action") || undefined;
          const result = url.searchParams.get("result") || undefined;

          const query = { offset, limit, skillId, action, result };
          const historyResult = await readHistory(query, options);
          jsonResponse(response, 200, historyResult);
          return;
        }

        if (url.pathname === "/api/governance") {
          const registry = await readRegistry(options);
          jsonResponse(response, 200, {
            registry,
          });
          return;
        }

        if (url.pathname === "/api/chat-functions") {
          jsonResponse(response, 200, { items: CHAT_FUNCTIONS });
          return;
        }

        if (url.pathname === "/api/translations/status") {
          const scanResult = await getScanCache();
          const counts = { ready: 0, pending: 0, error: 0, stale: 0 };
          for (const skill of scanResult.skills) for (const instance of skill.instances) counts[instance.translationStatus] = (counts[instance.translationStatus] || 0) + 1;
          jsonResponse(response, 200, { summary: counts });
          return;
        }

        if (url.pathname === "/api/projects") {
          const scanResult = await getScanCache();
          const manual = await listProjectRoots(options);
          const projects = new Map();
          for (const skill of scanResult.skills) for (const instance of skill.instances) if (instance.scope?.project_root) {
            const path = instance.scope.project_root;
            const current = projects.get(path) || { id: projectRootId(path), path, label: path.split("/").at(-1), origins: ["discovered"], instanceCount: 0 };
            current.instanceCount += 1; projects.set(path, current);
          }
          for (const root of manual.roots) { const current = projects.get(root.path) || { ...root, origins: [], instanceCount: 0 }; if (!current.origins.includes("manual")) current.origins.push("manual"); projects.set(root.path, current); }
          const items = await Promise.all([...projects.values()].map(async (item) => ({ ...item, exists: await lstat(item.path).then((s) => s.isDirectory()).catch(() => false), hasSkillRoot: await lstat(join(item.path, ".agents", "skills")).then((s) => s.isDirectory()).catch(() => false) })));
          jsonResponse(response, 200, { items: items.sort((a, b) => a.path.localeCompare(b.path)) });
          return;
        }

        if (url.pathname === "/api/health") {
          jsonResponse(response, 200, {
            status: "ok",
          });
          return;
        }

        notFound(response);
        return;
      }

      await serveStatic(url.pathname, response);
    } catch (error) {
      jsonResponse(response, 500, {
        error: {
          message: error.message,
          name: error.name,
        },
      });
    }
  });

  return {
    server,
    getScanCache,
    refreshSnapshot,
  };
}
