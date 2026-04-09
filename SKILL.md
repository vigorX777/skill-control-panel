---
name: skill-control-panel
description: Diagnose a user's skill environment, recommend a primary-repo governance strategy, preview consolidation steps, and then provide a local browser console for day-to-day skill management.
---

# skill-control-panel

Launch a local browser dashboard for skill governance.

## When to use

- The user wants to understand which skill providers exist in the current environment
- The user wants to compare provider counts, activity, and overlap before making changes
- The user wants a recommendation on whether to use one primary skill repo plus routed providers
- The user wants to pick the best provider to act as the primary repo
- The user wants to preview consolidation and migration steps before daily management
- The user wants a local console for provider toggles, install or uninstall actions, duplicate review, and metadata cleanup

## What this skill does

1. Scans the current provider environment and summarizes the structure
2. Diagnoses provider count, skill distribution, active providers, and current topology
3. Recommends whether the user should adopt a "one primary repo, other providers route to it" model
4. Suggests which provider should become the primary repo and explains the tradeoffs
5. Previews consolidation actions before exposing the management console
6. Serves a React UI for filtering, duplicate review, metadata edits, provider toggles, and queued management actions

## How to run

From this skill directory:

```bash
node scripts/launch.mjs
```

Optional environment variables:

- `ASM_BIN`
  Use a custom `asm` binary path
- `SKILL_CONTROL_PANEL_PORT`
  Prefer a specific port
- `NO_OPEN=1`
  Start the server without opening the browser

## Runtime behavior

- Metadata is stored in `~/.config/skill-control-panel/metadata.json`
- Server state is stored in `~/.config/skill-control-panel/server.json`
- Provider enable and disable actions edit the `asm` config JSON directly
- Install and uninstall actions are queued in the UI, then applied in order
- The homepage should lead with diagnosis, recommendation, and consolidation guidance before the management dashboard

## Boundaries

- This skill does not assume every user needs consolidation; it should diagnose first
- This skill does not auto-migrate or relink providers without explicit confirmation
- This skill does not edit `SKILL.md` files
- This skill does not auto-publish or auto-link itself into every provider

## References

- Reused `asm` surface area and constraints: `references/asm-subset.md`
- IA redesign and governance model: `docs/plans/2026-04-07-skill-governance-assistant-design.md`
