# Skill Control Panel V2

面向 Codex、Claude Code、Antigravity 和 OpenCode 的本地 Skill 治理工具。它用一个 Registry 记录 Hub、公共、Agent、项目的**当前事实**：Hub 是可同步的实体源，公共、Agent、项目表示共享或使用范围，逻辑 Skill 可同时带多个标签；追加式 History 记录变更。浏览器控制台始终只读，安装、更新、移动和卸载只通过 `skillctl` 执行。

## 核心能力

- 扫描公共与 Agent 受管根，并自动发现 `~/Documents`、`~/Vibecoding` 下全部项目 `.agents/skills`，包括试用目录和 worktree。
- 合并自动发现项目与 `~/.config/agents/project-roots.yaml` 人工项目清单；人工根可暂时不存在或暂无 Skill。
- 用实例级中文缓存展示能力介绍；内容摘要变化时旧译文自动失效，不污染原始 `SKILL.md`。
- 通过稳定聊天功能名统一 Codex、Claude Code、Antigravity 与 OpenCode 的管理调用。
- 读取四个 Agent 的真实启用配置，展示 Codex 系统 Skill、已启用 Codex/OpenCode/Claude 插件和 Agent 私有 Skill；禁用、缓存、市场及备份内容不进入库存。
- Dashboard 按精确名称聚合同名安装实例，展示全部层级、Agent、版本差异、路径、来源、路由和各自完整 `SKILL.md`。
- 从 frontmatter、清单和 Git 解析来源与当前版本；通过临时浅克隆检查 Git 来源是否更新。
- 对 Registry 写入使用跨进程文件锁；对文件、路由、Registry 和 History 变更使用补偿事务。
- `uninstall` 只把目录移动到 Trash，不直接永久删除。
- Quiet Ledger 前端只调用 GET API，不提供安装、更新、移动或卸载按钮。

## 目录与数据

| 用途 | 路径 |
|---|---|
| 个人 Hub 实体源 | `~/Vibecoding/skill-hub/skills/{public,agents,collections}/<name>` |
| 公共与 Agent 发现入口 | `~/.agents/skills/`、`~/.codex/skills/`、`~/.claude/skills/`、`~/.gemini/skills/`、`~/.config/opencode/skills/` |
| 项目 Skill | `<project_root>/.agents/skills/<name>` |
| 当前事实总表 | `~/.config/agents/skills-registry.yaml` |
| 追加式历史 | `~/.config/agents/skills-history.jsonl` |
| 人工项目根 | `~/.config/agents/project-roots.yaml` |
| 中文能力缓存 | `~/.config/agents/skill-capability-translations.json` |
| 卸载暂存 | `~/.config/agents/trash/<timestamp>/<name>` |

Hub 目录保存唯一可编辑实体；发现入口只保存逐 Skill 软路由。更新 Hub 后，在本项目根运行：

```bash
node scripts/private-skill-hub.mjs --apply --confirmed
```

详细契约见 [docs/skill-management-standard.md](docs/skill-management-standard.md)。

## 安装与启动

要求 Node.js 18+ 和本机可用的 Git CLI。

```bash
npm install
npm run build
node scripts/launch.mjs
```

默认地址为 `http://127.0.0.1:42873`，可用 `SKILL_CONTROL_PANEL_PORT` 覆盖端口。

项目发现默认工作区可用路径分隔符连接的 `SKILL_CONTROL_PANEL_WORKSPACE_ROOTS` 覆盖。CLI `scan/validate` 仍按安装实例输出；Dashboard 的“总 Skill 数”按同名聚合后的逻辑 Skill 统计。

“声明共享”只表示 Skill 处于公共或项目共享范围，不表示已逐个 Agent 运行验证；Agent 标签只来自系统内置、已启用插件、私有安装或实际治理路由。库存中的 Hub 标签只表示实体位于已配置的私有 Hub，不改变底层 public、agent、project scope。

## skillctl 命令契约

所有命令都可追加 `--json`；JSON 输出固定包含 `ok`、`command`，以及 `result` 或 `error`。参数错误退出码为 `2`，验证或操作失败为 `1`，成功为 `0`。

```bash
# 推荐：稳定聊天功能名
npm run skillctl -- skill-inventory-scan --json
npm run skillctl -- project-path-list --json
npm run skillctl -- project-path-add --path <absolute-path> --label <label> --confirmed --json
npm run skillctl -- project-path-update --path <absolute-path> --scan-mode direct-skill-folders --confirmed --json
npm run skillctl -- project-path-remove --path <absolute-path> --confirmed --json
npm run skillctl -- project-path-scan --json
npm run skillctl -- skill-translation-retry --json
npm run skillctl -- skill-translation-sync --input <json-file> --confirmed --json

# 只读
npm run skillctl -- scan --json
npm run skillctl -- validate --json
npm run skillctl -- validate --skill <id> --json
npm run skillctl -- check-updates --json
npm run skillctl -- check-updates --skill <id> --json

# 纳管和事实回填
npm run skillctl -- adopt --all --json
npm run skillctl -- adopt --path <path> --json
npm run skillctl -- reconcile --skill <id> --confirmed --json # omit --skill to refresh all active records

# 写事务；安装和更新必须先完成安全审查
npm run skillctl -- install --source <path> --scope public --vetted --json
npm run skillctl -- install --source <path> --scope agent --agent codex --vetted --json
npm run skillctl -- install --source <path> --scope project --project-root <absolute-path> --vetted --json
npm run skillctl -- update --skill <id> --source <path> --vetted --json
npm run skillctl -- move --skill <id> --scope project --project-root <absolute-path> --confirmed --json
npm run skillctl -- move --skill <id> --scope agent --agent claude --confirmed --json
npm run skillctl -- uninstall --skill <id> --confirmed --json

# 仅用于把旧的整目录链接显式迁移成逐 Skill 路由
npm run skillctl -- migrate-routes --agent claude --confirmed --json
```

`<path>` 当前必须是包含有效 `SKILL.md` 的本地目录；CLI 不把 URL 当作安装路径。外部仓库应先由 Agent 拉取到临时目录并完成安全审查，再把该目录交给 `--source`。

## 只读 API

服务只开放：

```text
GET /api/overview
GET /api/skills
GET /api/skills/:id
GET /api/updates
GET /api/diagnostics
GET /api/history
GET /api/governance
GET /api/health
GET /api/projects
GET /api/chat-functions
GET /api/translations/status
```

任何 `/api/*` 的 POST、PUT、PATCH、DELETE 或 OPTIONS 请求均返回 `405`。服务不配置通配 CORS，不通过 HTTP 修改 Registry、History、Skill 目录或 Agent 路由。

## 验证

```bash
npm test          # Node 单元、集成、事务与只读 smoke
npm run test:ui   # 自包含 Playwright UI 回归
npm run test:all  # 全量验证
```

## 故障恢复

- 锁等待超时：确认没有仍在运行的 `skillctl`；锁只会在超过 30 秒且记录 PID 已不存在时回收，禁止在进程存活时手工删除。
- 更新检查失败：查看 `update.error`；最近一次成功状态和版本不会被瞬时网络错误覆盖。
- 卸载恢复：在 Trash 找到目录，重新执行相同 scope 的 `install --source <trash-path> ... --vetted`，再运行 `validate`。
- 路由迁移失败：迁移会保留备份并自动回滚；不要手工覆盖 Agent 的整目录链接。
