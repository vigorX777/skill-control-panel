import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";

import { HISTORY_PATH } from "./constants.mjs";

const DEFAULT_LIMIT = 50;
const CHAT_CONTENT_KEYS = new Set(["chattext", "message", "prompt"]);

function resolveNow(now) {
  const value = typeof now === "function" ? now() : now;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  return new Date().toISOString();
}

function sanitizeValue(value) {
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (value === null || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !CHAT_CONTENT_KEYS.has(key.toLowerCase()))
      .map(([key, item]) => [key, sanitizeValue(item)]),
  );
}

function sanitizeActor(actor) {
  if (actor === null || typeof actor !== "object" || Array.isArray(actor)) {
    return { agent: null, sessionId: null };
  }
  return {
    agent: actor.agent ?? null,
    sessionId: actor.sessionId ?? null,
  };
}

function normalizeNonNegativeInteger(value, fallback) {
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

function normalizePositiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export async function appendHistoryEvent(event, options = {}) {
  const [storedEvent] = await appendHistoryEvents([event], options);
  return storedEvent;
}

export async function appendHistoryEvents(events, options = {}) {
  const historyPath = options.historyPath || HISTORY_PATH;
  const storedEvents = events.map((event) => ({
    schemaVersion: 1,
    id: event.id || randomUUID(),
    timestamp: event.timestamp || resolveNow(options.now),
    actor: sanitizeActor(event.actor),
    skillId: event.skillId ?? null,
    skillName: event.skillName ?? null,
    action: event.action ?? null,
    before: sanitizeValue(event.before ?? null),
    after: sanitizeValue(event.after ?? null),
    affectedPaths: sanitizeValue(event.affectedPaths ?? []),
    result: sanitizeValue(event.result ?? null),
    error: sanitizeValue(event.error ?? null),
  }));

  await mkdir(dirname(historyPath), { recursive: true });
  const existed = await lstat(historyPath).then(() => true).catch((error) => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
  const handle = await open(historyPath, "a+", 0o600);
  const beforeSize = (await handle.stat()).size;
  const data = Buffer.from(storedEvents.map((event) => JSON.stringify(event)).join("\n") + "\n", "utf8");
  try {
    if (options.historyWrite) await options.historyWrite(handle, data);
    else await handle.writeFile(data);
    await handle.sync();
  } catch (error) {
    const rollbackErrors = [];
    try {
      if (options.historyTruncate) await options.historyTruncate(handle, beforeSize);
      else await handle.truncate(beforeSize);
      await handle.sync();
    } catch (rollbackError) {
      rollbackErrors.push(`History rollback failed: ${rollbackError.message}`);
    }
    await handle.close().catch((closeError) => rollbackErrors.push(`History close failed: ${closeError.message}`));
    if (!existed && rollbackErrors.length === 0) {
      await rm(historyPath, { force: true }).catch((removeError) => rollbackErrors.push(`History cleanup failed: ${removeError.message}`));
    }
    if (rollbackErrors.length > 0) error.rollbackErrors = rollbackErrors;
    throw error;
  }
  await handle.close();
  return storedEvents;
}

export async function readHistory(query = {}, options = {}) {
  const historyPath = options.historyPath || HISTORY_PATH;
  const offset = normalizeNonNegativeInteger(query.offset, 0);
  const limit = normalizePositiveInteger(query.limit, DEFAULT_LIMIT);

  let source;
  try {
    source = await readFile(historyPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return { items: [], total: 0, offset, limit, nextOffset: null };
    }
    throw error;
  }

  const events = source
    .split("\n")
    .map((line, index) => {
      if (line.trim() === "") return null;
      try {
        const event = JSON.parse(line);
        if (event === null || typeof event !== "object" || Array.isArray(event)) return null;
        return { event, index };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .filter(({ event }) => query.skillId === undefined || event.skillId === query.skillId)
    .filter(({ event }) => query.action === undefined || event.action === query.action)
    .filter(({ event }) => query.result === undefined || event.result === query.result)
    .sort((left, right) => {
      const timestampOrder = Date.parse(right.event.timestamp) - Date.parse(left.event.timestamp);
      return timestampOrder || right.index - left.index;
    });

  const total = events.length;
  const items = events.slice(offset, offset + limit).map(({ event }) => event);
  const consumed = offset + items.length;

  return {
    items,
    total,
    offset,
    limit,
    nextOffset: consumed < total ? consumed : null,
  };
}
