# skill-control-panel

A local skill management dashboard for inspecting installed skills, filtering by provider and status, reviewing details, and applying enable, disable, or delete actions from a browser UI.

## What It Does

- Scans the local skill environment and summarizes available skills
- Shows provider coverage, runtime status, and per-skill details
- Supports search and filtering by keyword, status, tag, provider, and favorites
- Exposes a local dashboard for day-to-day skill management

## Project Structure

- `SKILL.md`: skill definition used by Codex/Claude-style skill environments
- `src/dashboard/`: dashboard source code
- `assets/dashboard/`: built browser assets served at runtime
- `scripts/`: local server, launcher, and build scripts
- `tests/`: server and UI self-tests

## Requirements

- Node.js 18+
- npm
- For `npm run test:ui`: a local Chrome/Chromium setup compatible with the existing CDP-based test harness

## Install

```bash
npm install
```

## Run

```bash
node scripts/launch.mjs
```

Optional environment variables:

- `ASM_BIN`: use a custom `asm` binary path
- `SKILL_CONTROL_PANEL_PORT`: prefer a specific local port
- `NO_OPEN=1`: start without opening a browser window

## Build

```bash
npm run build
```

This rebuilds `assets/dashboard/` from `src/dashboard/`.

## Test

```bash
npm test
npm run test:ui
```

Or run the full suite:

```bash
npm run test:all
```

## Notes

- The server listens on `127.0.0.1` and is intended for local use.
- Runtime state is stored under `~/.config/skill-control-panel/`.
- This repository is the standalone project version of the skill. `SKILL.md` remains in-tree so the same codebase can still be used from a skill environment.
