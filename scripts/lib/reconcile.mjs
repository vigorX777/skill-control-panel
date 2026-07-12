import { appendHistoryEvents } from "./history.mjs";
import { readRegistry, withRegistryLock, writeRegistryUnlocked } from "./registry.mjs";
import { resolveSkillFacts } from "./source.mjs";
import { runMutationTransaction } from "./mutation-transaction.mjs";

function sameFacts(left, right) {
  return JSON.stringify({
    capability_summary: left.capability_summary,
    source: left.source,
    version: left.version,
  }) === JSON.stringify({
    capability_summary: right.capability_summary,
    source: right.source,
    version: right.version,
  });
}

export async function reconcileCurrentFacts(options = {}) {
  const now = options.now || new Date().toISOString();
  const skillId = options.skillId || null;
  return withRegistryLock(options, async () => runMutationTransaction(async ({ onRollback }) => {
    const registry = await readRegistry(options);
    const events = [];
    const skills = [];
    let changed = 0;

    for (const skill of registry.skills) {
      if (skill.lifecycle !== "active" || (skillId && skill.id !== skillId)) {
        skills.push(skill);
        continue;
      }
      try {
        const facts = await resolveSkillFacts(skill.install.canonical_path);
        const nextFacts = {
          ...skill,
          capability_summary: facts.capabilitySummary || skill.capability_summary,
          source: facts.source,
          version: facts.version,
        };
        const factsChanged = !sameFacts(skill, nextFacts);
        const expectedUpdateStatus = ["github", "git"].includes(facts.source.type) ? "unknown" : "not_checkable";
        const statusChanged = skill.update.status === "unknown" && expectedUpdateStatus === "not_checkable";
        const recordChanged = factsChanged || statusChanged;
        const updated = recordChanged ? {
          ...nextFacts,
          update: {
            status: expectedUpdateStatus,
            latest: null,
            checked_at: null,
            error: null,
          },
          updated_at: now,
        } : skill;
        if (recordChanged) {
          changed += 1;
          events.push({
            action: "source_change", skillId: skill.id, skillName: skill.name,
            before: skill, after: updated, affectedPaths: [skill.install.canonical_path],
            result: "success", timestamp: now, actor: options.actor || null,
          });
        }
        skills.push(updated);
      } catch (error) {
        skills.push(skill);
        events.push({
          action: "validation_failed", skillId: skill.id, skillName: skill.name,
          before: skill, after: skill, affectedPaths: [skill.install.canonical_path],
          result: "error", error: error.message, timestamp: now, actor: options.actor || null,
        });
      }
    }

    if (changed > 0) {
      const updatedRegistry = { ...registry, updatedAt: now, skills };
      await writeRegistryUnlocked(updatedRegistry, options);
      onRollback(() => writeRegistryUnlocked(registry, options));
    }
    if (events.length > 0) await appendHistoryEvents(events, options);
    return { ok: true, action: "reconcile", changed, events: events.length, rolledBack: false };
  }));
}
