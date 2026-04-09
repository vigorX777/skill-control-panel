import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

import { METADATA_PATH } from "./constants.mjs";
import {
  AsmUnavailableError,
  buildDefaultMetadata,
  disableSkillExposure,
  enableSkillExposure,
  installAsmSkill,
  inspectAsmSkill,
  loadDashboardState,
  sanitizeMetadata,
  stableId,
  uninstallSkillExposure,
  uninstallAsmSkill,
  updateAsmProviderEnabled,
} from "./asm.mjs";
import { readJsonFile, writeJsonFile } from "./metadata.mjs";

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

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  if (!chunks.length) {
    return {};
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function notFound(response) {
  jsonResponse(response, 404, { error: { message: "Not found" } });
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

function errorResponse(response, error) {
  const message =
    error instanceof AsmUnavailableError
      ? "asm is unavailable. Install agent-skill-manager first."
      : error.message;
  const statusCode = error instanceof AsmUnavailableError ? 503 : 500;
  jsonResponse(response, statusCode, {
    error: {
      message,
      name: error.name,
    },
  });
}

export function createSkillControlServer(options = {}) {
  const state = {
    snapshot: null,
    basket: [],
    lastApplyResults: [],
  };

  async function refreshSnapshot() {
    const rawSnapshot = await loadDashboardState({
      ...options,
      metadataPath: options.metadataPath || METADATA_PATH,
    });
    state.snapshot = rawSnapshot;

    return state.snapshot;
  }

  async function getSkillById(skillId) {
    const snapshot = state.snapshot || (await refreshSnapshot());
    const skill = snapshot.managedSkills.find((item) => item.id === skillId);
    if (!skill) {
      const error = new Error(`Unknown skill id: ${skillId}`);
      error.statusCode = 404;
      throw error;
    }
    return skill;
  }

  async function saveMetadata(skillId, patch) {
    const snapshot = state.snapshot || (await refreshSnapshot());
    const skill = await getSkillById(skillId);
    const store = await readJsonFile(options.metadataPath || METADATA_PATH, {
      version: 1,
      skills: {},
    });
    const merged = sanitizeMetadata(patch, skill.metadata || buildDefaultMetadata(skill));

    store.skills[skillId] = merged;
    await writeJsonFile(options.metadataPath || METADATA_PATH, store);
    return merged;
  }

  async function applyProviderAction(skillId, providerName, action) {
    if (action === "enable") {
      return enableSkillExposure(skillId, providerName, options);
    }

    if (action === "disable") {
      return disableSkillExposure(skillId, providerName, options);
    }

    if (action === "uninstall") {
      return uninstallSkillExposure(skillId, providerName, options);
    }

    throw new Error(`Unsupported provider action: ${action}`);
  }

  async function applySkillAction(skillId, action) {
    const skill = await getSkillById(skillId);
    const providerNames = [...new Set(skill.providers.map((provider) => provider.name))];

    if (!providerNames.length) {
      throw new Error(`Skill ${skill.name} has no provider exposures`);
    }

    const providerResults = [];

    for (const providerName of providerNames) {
      try {
        const result = await applyProviderAction(skillId, providerName, action);
        providerResults.push({
          providerName,
          ok: true,
          result,
        });
      } catch (error) {
        providerResults.push({
          providerName,
          ok: false,
          message: error.message,
        });
      }
    }

    const successCount = providerResults.filter((item) => item.ok).length;
    const failureCount = providerResults.length - successCount;

    return {
      skillId,
      skillName: skill.name,
      action,
      ok: failureCount === 0,
      successCount,
      failureCount,
      affectedProviderCount: providerResults.length,
      providerResults,
    };
  }

  function basketItemFromBody(body) {
    const type = body?.type;
    if (!["set-provider-enabled", "install-skill", "uninstall-skill"].includes(type)) {
      throw new Error(`Unsupported basket action: ${type}`);
    }

    if (type === "set-provider-enabled") {
      if (typeof body?.target !== "string" || typeof body?.payload?.enabled !== "boolean") {
        throw new Error("Provider toggle action needs target and payload.enabled");
      }
    }

    if (type === "install-skill") {
      if (typeof body?.payload?.source !== "string" || !body.payload.source.trim()) {
        throw new Error("Install action needs payload.source");
      }
    }

    if (type === "uninstall-skill") {
      if (typeof body?.target !== "string" || !body.target.trim()) {
        throw new Error("Uninstall action needs target");
      }
    }

    return {
      id: stableId(`${type}:${body.target || body.payload?.source}:${Date.now()}:${Math.random()}`),
      type,
      target: body.target || null,
      payload: body.payload || {},
      createdAt: new Date().toISOString(),
    };
  }

  async function applyBasket() {
    const results = [];

    for (const item of state.basket) {
      try {
        if (item.type === "set-provider-enabled") {
          await updateAsmProviderEnabled(item.target, item.payload.enabled, options);
        } else if (item.type === "install-skill") {
          await installAsmSkill(item.payload.source, item.payload.provider || null, options);
        } else if (item.type === "uninstall-skill") {
          await uninstallAsmSkill(item.target, options);
        }

        results.push({
          id: item.id,
          type: item.type,
          ok: true,
        });
      } catch (error) {
        results.push({
          id: item.id,
          type: item.type,
          ok: false,
          message: error.message,
        });
      }
    }

    state.basket = [];
    state.lastApplyResults = results;
    await refreshSnapshot();

    return results;
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");

    try {
      if (request.method === "GET" && url.pathname === "/api/summary") {
        const snapshot = state.snapshot || (await refreshSnapshot());
        jsonResponse(response, 200, {
          scannedAt: snapshot.scannedAt,
          summary: snapshot.summary,
          lastApplyResults: state.lastApplyResults,
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/skills") {
        const snapshot = state.snapshot || (await refreshSnapshot());
        jsonResponse(response, 200, {
          scannedAt: snapshot.scannedAt,
          items: snapshot.managedSkills,
        });
        return;
      }

      if (request.method === "GET" && url.pathname.startsWith("/api/skills/")) {
        const snapshot = state.snapshot || (await refreshSnapshot());
        const skillId = decodeURIComponent(url.pathname.replace("/api/skills/", ""));
        const skill = snapshot.managedSkills.find((item) => item.id === skillId);

        if (!skill) {
          notFound(response);
          return;
        }

        const inspect = await inspectAsmSkill(skill.name, options);
        jsonResponse(response, 200, {
          item: skill,
          inspect,
        });
        return;
      }

      if (
        request.method === "POST" &&
        /^\/api\/skills\/[^/]+\/providers\/[^/]+\/action$/.test(url.pathname)
      ) {
        const [, , , rawSkillId, , rawProviderName] = url.pathname.split("/");
        const skillId = decodeURIComponent(rawSkillId);
        const providerName = decodeURIComponent(rawProviderName);
        const body = await readBody(request);
        const action = body?.action;
        const result = await applyProviderAction(skillId, providerName, action);

        const snapshot = await refreshSnapshot();
        const skill = snapshot.managedSkills.find((item) => item.id === skillId) || null;

        jsonResponse(response, 200, {
          result,
          item: skill,
          scannedAt: snapshot.scannedAt,
          summary: snapshot.summary,
        });
        return;
      }

      if (
        request.method === "POST" &&
        /^\/api\/skills\/[^/]+\/action$/.test(url.pathname)
      ) {
        const [, , , rawSkillId] = url.pathname.split("/");
        const skillId = decodeURIComponent(rawSkillId);
        const body = await readBody(request);
        const action = body?.action;
        const result = await applySkillAction(skillId, action);

        const snapshot = await refreshSnapshot();
        const skill = snapshot.managedSkills.find((item) => item.id === skillId) || null;

        jsonResponse(response, 200, {
          result,
          item: skill,
          scannedAt: snapshot.scannedAt,
          summary: snapshot.summary,
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/skills/batch-action") {
        const body = await readBody(request);
        const action = body?.action;
        const skillIds = Array.isArray(body?.skillIds)
          ? [...new Set(body.skillIds.filter((item) => typeof item === "string" && item.trim()))]
          : [];

        if (!skillIds.length) {
          throw new Error("Batch action needs at least one skill id");
        }

        const results = [];
        for (const skillId of skillIds) {
          try {
            results.push(await applySkillAction(skillId, action));
          } catch (error) {
            results.push({
              skillId,
              action,
              ok: false,
              successCount: 0,
              failureCount: 1,
              affectedProviderCount: 0,
              providerResults: [],
              message: error.message,
            });
          }
        }

        const snapshot = await refreshSnapshot();
        jsonResponse(response, 200, {
          action,
          results,
          summary: {
            totalSkills: results.length,
            successCount: results.filter((item) => item.ok).length,
            failureCount: results.filter((item) => !item.ok).length,
            affectedProviderCount: results.reduce(
              (count, item) => count + item.affectedProviderCount,
              0,
            ),
          },
          scannedAt: snapshot.scannedAt,
          snapshotSummary: snapshot.summary,
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/duplicates") {
        const snapshot = state.snapshot || (await refreshSnapshot());
        jsonResponse(response, 200, {
          scannedAt: snapshot.scannedAt,
          items: snapshot.duplicates,
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/providers") {
        const snapshot = state.snapshot || (await refreshSnapshot());
        jsonResponse(response, 200, {
          scannedAt: snapshot.scannedAt,
          items: snapshot.providers,
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/rescan") {
        const snapshot = await refreshSnapshot();
        jsonResponse(response, 200, {
          scannedAt: snapshot.scannedAt,
          summary: snapshot.summary,
        });
        return;
      }

      if (request.method === "PATCH" && url.pathname.startsWith("/api/metadata/")) {
        const skillId = decodeURIComponent(url.pathname.replace("/api/metadata/", ""));
        const body = await readBody(request);
        const metadata = await saveMetadata(skillId, body);
        await refreshSnapshot();
        jsonResponse(response, 200, { id: skillId, metadata });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/basket/items") {
        const body = await readBody(request);
        const item = basketItemFromBody(body);
        state.basket.push(item);
        jsonResponse(response, 201, { item });
        return;
      }

      if (request.method === "DELETE" && url.pathname.startsWith("/api/basket/items/")) {
        const itemId = decodeURIComponent(url.pathname.replace("/api/basket/items/", ""));
        state.basket = state.basket.filter((item) => item.id !== itemId);
        jsonResponse(response, 200, { ok: true });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/basket/apply") {
        const results = await applyBasket();
        jsonResponse(response, 200, {
          results,
          scannedAt: state.snapshot.scannedAt,
          summary: state.snapshot.summary,
        });
        return;
      }

      if (url.pathname.startsWith("/api/")) {
        notFound(response);
        return;
      }

      await serveStatic(url.pathname, response);
    } catch (error) {
      if (error?.statusCode === 404) {
        notFound(response);
        return;
      }
      errorResponse(response, error);
    }
  });

  return {
    server,
    state,
    refreshSnapshot,
  };
}
