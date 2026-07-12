import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markTranslationError, markTranslationPending, readTranslations, syncTranslations, translationForInstance } from "../scripts/lib/translations.mjs";

test("stores ready translations and derives stale from a changed digest", async () => {
  const root = await mkdtemp(join(tmpdir(), "translations-"));
  try {
    const translationsPath = join(root, "translations.json");
    await markTranslationPending({ id: "skill-1", name: "demo", capabilitySummary: "Original", source: { content_digest: "a" } }, { translationsPath });
    const input = join(root, "input.json");
    await writeFile(input, JSON.stringify({ items: [{ instanceId: "skill-1", contentDigest: "a", translatedText: "中文介绍" }] }));
    await syncTranslations({ input, confirmed: true }, { translationsPath });
    const cache = await readTranslations({ translationsPath });
    assert.equal(translationForInstance({ id: "skill-1", source: { content_digest: "a" } }, cache).status, "ready");
    assert.equal(translationForInstance({ id: "skill-1", source: { content_digest: "b" } }, cache).status, "stale");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("persists translation errors for retry and rejects a digest that differs from the current scan", async () => {
  const root = await mkdtemp(join(tmpdir(), "translations-error-"));
  try {
    const translationsPath = join(root, "translations.json");
    const input = join(root, "input.json");
    const instance = { id: "id-1", name: "demo", capabilitySummary: "Original", source: { content_digest: "pending" } };
    await markTranslationPending(instance, { translationsPath });
    await markTranslationError(instance, new Error("translator failed"), { translationsPath });
    let cache = await readTranslations({ translationsPath });
    assert.equal(cache.items["id-1"].status, "error");
    assert.equal(cache.items["id-1"].error, "translator failed");
    await writeFile(input, JSON.stringify({ items: [{ instanceId: "id-1", contentDigest: "pending", translatedText: "中文" }] }));
    await assert.rejects(() => syncTranslations({ input, confirmed: true }, { translationsPath, currentDigests: new Map([["id-1", "changed"]]) }), /current digest/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a translation whose digest no longer matches the pending instance", async () => {
  const root = await mkdtemp(join(tmpdir(), "translations-digest-"));
  try {
    const translationsPath = join(root, "translations.json");
    const input = join(root, "input.json");
    await markTranslationPending({ id: "id-1", name: "demo", capabilitySummary: "Original", source: { content_digest: "current" } }, { translationsPath });
    await writeFile(input, JSON.stringify({ items: [{ instanceId: "id-1", contentDigest: "old", translatedText: "中文" }] }));
    await assert.rejects(() => syncTranslations({ input, confirmed: true }, { translationsPath }), /digest/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("syncs a scanned instance that has no cached translation record", async () => {
  const root = await mkdtemp(join(tmpdir(), "translations-scanned-"));
  try {
    const translationsPath = join(root, "translations.json");
    const input = join(root, "input.json");
    const instance = { id: "scan-1", name: "scanned", capabilitySummary: "Original", source: { content_digest: "digest-1" } };
    await writeFile(input, JSON.stringify({ items: [{ instanceId: instance.id, contentDigest: "digest-1", translatedText: "扫描发现的中文介绍" }] }));

    await syncTranslations({ input, confirmed: true }, {
      translationsPath,
      currentInstances: new Map([[instance.id, instance]]),
    });

    const cache = await readTranslations({ translationsPath });
    assert.equal(cache.items[instance.id].skillName, "scanned");
    assert.equal(cache.items[instance.id].contentDigest, "digest-1");
    assert.equal(cache.items[instance.id].sourceText, "Original");
    assert.equal(cache.items[instance.id].translatedText, "扫描发现的中文介绍");
    assert.equal(cache.items[instance.id].status, "ready");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects an unknown instance without changing cached translations", async () => {
  const root = await mkdtemp(join(tmpdir(), "translations-atomic-"));
  try {
    const translationsPath = join(root, "translations.json");
    const input = join(root, "input.json");
    const instance = { id: "scan-1", name: "scanned", capabilitySummary: "Original", source: { content_digest: "digest-1" } };
    await markTranslationPending(instance, { translationsPath });
    const before = await readFile(translationsPath, "utf8");
    await writeFile(input, JSON.stringify({ items: [
      { instanceId: instance.id, contentDigest: "digest-1", translatedText: "中文介绍" },
      { instanceId: "missing", contentDigest: "digest-2", translatedText: "不应写入" },
    ] }));

    await assert.rejects(() => syncTranslations({ input, confirmed: true }, {
      translationsPath,
      currentInstances: new Map([[instance.id, instance]]),
    }), /Unknown translation instance: missing/);
    assert.equal(await readFile(translationsPath, "utf8"), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
