import test from "node:test";
import assert from "node:assert/strict";
import { finalizeTranslation } from "../scripts/skillctl.mjs";

const skill = { id: "skill-id", name: "demo", capability_summary: "Demo", source: { content_digest: "abc" } };

test("reports translation errors without changing the successful skill result", async () => {
  let errorSaved = false;
  const result = await finalizeTranslation(skill, "/tmp/input.json", { markPending: async () => ({ status: "pending" }), sync: async () => { throw new Error("cache unavailable"); }, markError: async () => { errorSaved = true; } });
  assert.equal(errorSaved, true);
  assert.deepEqual(result, { translation: "error", translationError: "cache unavailable" });
});

test("reports ready only after the supplied translation batch is synced", async () => {
  let synced = false;
  const result = await finalizeTranslation(skill, "/tmp/input.json", {
    markPending: async () => ({ status: "pending" }),
    sync: async () => { synced = true; },
  });
  assert.equal(synced, true);
  assert.deepEqual(result, { translation: "ready" });
});
