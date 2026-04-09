# asm Subset Used By skill-control-panel

This skill intentionally reuses a narrow subset of `asm`.

## Commands used directly

- `asm list --json`
- `asm inspect <skill-name> --json`
- `asm audit duplicates --json`
- `asm config path`
- `asm config show`
- `asm install <source> -y [-p <provider>]`
- `asm uninstall <skill-name> -y`

## Why this subset

- `list --json` is the primary inventory source
- `inspect --json` is available for detail refreshes
- `audit duplicates --json` provides duplicate groups and lets the dashboard distinguish:
  - provider-exposed duplicates
  - true copy duplicates
- `config path` and `config show` let the dashboard read and safely update provider enable flags
- `install` and `uninstall` are the only mutation commands used in v1

## Commands intentionally not reused

- `asm config edit`
  The dashboard edits the config JSON directly so provider toggles can be queued
- `asm audit --yes`
  v1 does not auto-remove duplicates
- `asm init`, `asm link`, `asm import`, `asm bundle`, `asm index`
  These are outside the v1 control-panel scope

## Operational assumptions

- `asm` is already installed and available on `PATH`, unless `ASM_BIN` is supplied
- The `asm` config file is JSON and writable at the path returned by `asm config path`
- `asm uninstall` removes the selected skill name without an interactive picker when `-y` is supplied
