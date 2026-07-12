---
name: skill-control-panel
description: Diagnose and govern Hub, public, agent-private, and project Skill installations through a read-only dashboard and transactional skillctl commands.
version: 0.2.0
source: https://github.com/vigorX777/skill-control-panel
---

# Skill Control Panel

用于统一查看和管理 Codex、Claude Code、Antigravity、OpenCode 的本地 Skill。页面负责读取事实；任何文件、路由、Registry 或 History 变更必须通过本仓库的 `scripts/skillctl.mjs` 完成。

## 何时使用

- 盘点 Hub、公共、Agent 私有和项目 Skill，检查来源、版本、实体路径、发现路由与可见 Agent。
- 查看完整 `SKILL.md`，复制名称或安装路径。
- 检查 Git 来源是否有更新，诊断断链、冲突和不兼容路由。
- 在 Agent 聊天中执行接管、安装、更新、移动、卸载或事实回填。
- 人工维护项目根目录，并生成、同步或重试实例级中文能力介绍。
- 识别四个 Agent 的系统、已启用插件和私有 Skill，并区分“声明共享”与真实 Agent 归属。

## 操作规则

1. 先运行 `npm run skillctl -- scan --json` 和 `validate --json` 获取安装实例事实；Dashboard 会把精确同名实例聚合为逻辑 Skill。
2. 外部安装或更新必须先完成安全审查，再传入本地 `--source <path>`，并显式添加 `--vetted`。
3. 移动、卸载、路由迁移和 reconcile 必须显式添加 `--confirmed`。
4. Agent 层操作必须指定 `--agent codex|claude|antigravity|opencode`。
5. 不得通过浏览器或自行编辑 Registry 模拟成功；以 CLI 返回、实际路径、Registry 与 History 四者一致为完成标准。
6. 优先使用下列稳定聊天功能名；旧 `scan/install/update/...` 只作为兼容别名。
7. Agent 官方或插件 Skill 只从启用配置派生，不因缓存或市场目录存在而展示，也不写入 Registry。
8. Hub 是可同步的实体源，公共、Agent、项目是可并列的范围标签；Hub 更新后执行 `node scripts/private-skill-hub.mjs --apply --confirmed`，不得直接编辑 Agent 发现入口。

## 稳定聊天功能

库存与校验：`skill-inventory-scan`、`skill-environment-validate`、`skill-update-check`。

Skill 事务：`skill-install`、`skill-update`、`skill-move`、`skill-uninstall`、`skill-adopt`、`skill-reconcile`、`agent-route-migrate`。

中文能力：`skill-translation-sync`、`skill-translation-retry`。安装、更新、纳管、reconcile、项目扫描或库存扫描完成后，当前 Agent 不得直接报告完成，必须在同一次对话中执行：

1. 调用 `skill-translation-retry --json` 读取全部非 `ready` 实例；
2. 为每条记录生成简洁、准确的中文能力介绍；
3. 调用 `skill-translation-sync --input <json-file> --confirmed --json` 批量同步；
4. 再次调用 `skill-translation-retry --json` 验证队列为空。

`skill-translation-sync` 可为当前扫描仍存在但缓存缺失的实例初始化记录。翻译同步失败不回滚已成功的 Skill 文件事务，但 Agent 必须明确报告未就绪项，不能把该次操作描述为全部完成。

项目路径：`project-path-list`、`project-path-add`、`project-path-update`、`project-path-remove`、`project-path-scan`。`project-path-update --scan-mode direct-skill-folders` 只增加项目根的直系 `SKILL.md` 文件夹扫描；删除只移除人工记录，不删除项目目录或 Skill。

常用入口：

```bash
node scripts/launch.mjs
npm run skillctl -- scan --json
npm run skillctl -- check-updates --json
npm run skillctl -- install --source <path> --scope public --vetted --json
npm run skillctl -- update --skill <id> --source <path> --vetted --json
npm run skillctl -- move --skill <id> --scope project --project-root <absolute-path> --confirmed --json
npm run skillctl -- uninstall --skill <id> --confirmed --json
npm run skillctl -- project-path-add --path <absolute-path> --confirmed --json
npm run skillctl -- project-path-update --path <absolute-path> --scan-mode direct-skill-folders --confirmed --json
npm run skillctl -- skill-translation-retry --json
npm run skillctl -- skill-translation-sync --input <json-file> --confirmed --json
```

完整规范见 `docs/skill-management-standard.md`。
