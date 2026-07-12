import { upsertRegistrySkill } from "../../scripts/lib/registry.mjs";

const [registryPath, indexValue] = process.argv.slice(2);
const index = Number(indexValue);
const now = "2026-07-10T00:00:00.000Z";
const canonicalPath = `/tmp/concurrent-skill-${index}`;

await upsertRegistrySkill(
  {
    id: `skill-${index}`,
    name: `skill-${index}`,
    lifecycle: "active",
    ownership: "managed",
    capability_summary: `Skill ${index}`,
    scope: { level: "public", agent: null, project_root: null },
    install: { canonical_path: canonicalPath, skill_md_path: `${canonicalPath}/SKILL.md`, routes: [] },
    source: { type: "unknown", url: null, repository: null, subpath: null, ref: null, revision: null, content_digest: null },
    version: { current: null, kind: "unknown", basis: "unknown" },
    update: { status: "unknown", latest: null, checked_at: null, error: null },
    installed_at: now,
    updated_at: now,
  },
  { registryPath, now },
);
