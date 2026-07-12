import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { CAPABILITY_TRANSLATIONS_PATH } from "./constants.mjs";
import { withFileLock } from "./file-lock.mjs";

const empty = () => ({ schemaVersion: 1, updatedAt: null, items: {} });
const STATUSES = new Set(["ready", "pending", "error", "stale"]);
function validTimestamp(value) { return value === null || (typeof value === "string" && !Number.isNaN(Date.parse(value))); }
function validateCache(value) {
  if (!value || value.schemaVersion !== 1 || !validTimestamp(value.updatedAt) || !value.items || typeof value.items !== "object" || Array.isArray(value.items)) throw new Error("Invalid translations schema");
  for (const [id, item] of Object.entries(value.items)) {
    if (!id || !item || typeof item.skillName !== "string" || typeof item.sourceText !== "string" || !STATUSES.has(item.status) || !validTimestamp(item.translatedAt) || ![null, "string"].includes(item.error === null ? null : typeof item.error) || ![null, "string"].includes(item.translatedText === null ? null : typeof item.translatedText) || ![null, "string"].includes(item.contentDigest === null ? null : typeof item.contentDigest)) throw new Error(`Invalid translation record: ${id}`);
    if (item.status === "ready" && !item.translatedText?.trim()) throw new Error(`Invalid ready translation: ${id}`);
  }
}
export async function readTranslations(options = {}) {
  const path = options.translationsPath || CAPABILITY_TRANSLATIONS_PATH;
  try { const value = JSON.parse(await readFile(path, "utf8")); validateCache(value); return value; }
  catch (error) { if (error.code === "ENOENT") return empty(); throw error; }
}
async function writeCache(cache, path) { await mkdir(dirname(path), { recursive: true }); const tmp = `${path}.${randomUUID()}.tmp`; await writeFile(tmp, JSON.stringify(cache, null, 2), { mode: 0o600 }); try { await rename(tmp, path); } finally { await rm(tmp, { force: true }); } }
export function translationForInstance(instance, cache) {
  const item = cache.items[instance.id];
  if (!item) return { status: "pending", translatedText: null };
  if (item.contentDigest !== instance.source?.content_digest) return { ...item, status: "stale", translatedText: null };
  return item.status === "ready" ? item : { ...item, translatedText: null };
}
export async function markTranslationPending(instance, options = {}) {
  const path = options.translationsPath || CAPABILITY_TRANSLATIONS_PATH;
  return withFileLock(`${path}.lock`, options, async () => { const cache = await readTranslations({ translationsPath: path }); const now = new Date().toISOString(); cache.items[instance.id] = { skillName: instance.name, contentDigest: instance.source?.content_digest || null, sourceText: instance.capabilitySummary || "", translatedText: null, status: "pending", error: null, translatedAt: null }; cache.updatedAt = now; await writeCache(cache, path); return cache.items[instance.id]; });
}
export async function markTranslationError(instance, error, options = {}) {
  const path = options.translationsPath || CAPABILITY_TRANSLATIONS_PATH;
  return withFileLock(`${path}.lock`, options, async () => {
    const cache = await readTranslations({ translationsPath: path });
    const current = cache.items[instance.id];
    if (!current) return null;
    cache.items[instance.id] = { ...current, status: "error", translatedText: null, error: error.message || String(error), translatedAt: null };
    cache.updatedAt = new Date().toISOString();
    await writeCache(cache, path);
    return cache.items[instance.id];
  });
}
export async function syncTranslations(params, options = {}) {
  if (!params.confirmed) throw new Error("skill-translation-sync requires --confirmed");
  const path = options.translationsPath || CAPABILITY_TRANSLATIONS_PATH;
  const input = JSON.parse(await readFile(params.input, "utf8"));
  return withFileLock(`${path}.lock`, options, async () => {
    const cache = await readTranslations({ translationsPath: path });
    const nextItems = { ...cache.items };
    const now = new Date().toISOString();
    for (const item of input.items || []) {
      if (!item.instanceId || !item.translatedText?.trim()) throw new Error("Translation items require instanceId and translatedText");
      const currentInstance = options.currentInstances?.get(item.instanceId);
      if (options.currentDigests && options.currentDigests.get(item.instanceId) !== item.contentDigest) throw new Error(`Translation current digest mismatch: ${item.instanceId}`);
      if (currentInstance && currentInstance.source?.content_digest !== item.contentDigest) throw new Error(`Translation current digest mismatch: ${item.instanceId}`);
      let current = nextItems[item.instanceId];
      if (!current) {
        if (!currentInstance) throw new Error(`Unknown translation instance: ${item.instanceId}`);
        current = {
          skillName: currentInstance.name,
          contentDigest: currentInstance.source?.content_digest || null,
          sourceText: currentInstance.capabilitySummary || "",
          translatedText: null,
          status: "pending",
          error: null,
          translatedAt: null,
        };
      }
      if (current.contentDigest !== item.contentDigest) throw new Error(`Translation digest mismatch: ${item.instanceId}`);
      nextItems[item.instanceId] = { ...current, translatedText: item.translatedText.trim(), status: "ready", error: null, translatedAt: now };
    }
    cache.items = nextItems;
    cache.updatedAt = now;
    await writeCache(cache, path);
    return { ok: true, updated: (input.items || []).length };
  });
}
