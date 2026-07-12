# 本地 Skill 管理与治理规范（V2）

## 1. 管理模型

系统只管理**当前事实**，不保存期望版本、期望层级、自动收敛或自动更新策略。

| 标签 / scope | 实体源或语义 | 使用范围 |
|---|---|---|
| `hub` | `~/Vibecoding/skill-hub/skills/{public,agents,collections}/<name>` | 个人长期 Skill 的唯一可编辑实体源；可与下列 scope 并列展示 |
| `public` | Hub 的 `skills/public`、`skills/collections` 或兼容公共根 | 跨 Agent 共享范围，不等同于发现入口 |
| `agent` | Hub 的 `skills/agents/<agent>` 或 Agent 已启用实体 | 仅指定 Agent |
| `project` | `<project_root>/.agents/skills/<name>` | 仅当前项目 |

同一个安装实例只属于一个底层 scope（`public | agent | project`）；`hub` 是从实体路径派生的展示标签，不改变 Registry 或 CLI 的 scope 契约。CLI 与 Registry 按真实路径保存实例；Dashboard 按精确名称聚合逻辑 Skill，并用多个标签展示 Hub、public、agent、project。版本、来源或内容不同只报告 `instance_difference` warning，不把合法多实例无条件视为冲突。

Agent 层细分为 `system | plugin | private`。system 和 plugin 由 Agent 适配器读取当前启用配置派生，不写入 Registry；private 继续由 `~/.config/agents/agent-skills/<agent>` 和 Registry 管理。缓存、市场、备份、隐藏、禁用及无法确认启用状态的目录均不进入库存。

项目发现递归扫描 `~/Documents` 和 `~/Vibecoding` 下所有 `.agents/skills`，包括 `Skill试用`；跳过 `.git`、`.worktrees`、`node_modules`、`vendor`、`dist`、`build`、`.cache`，且不跟随目录符号链接。Git worktree 是临时分支副本，不进入默认库存；合并后的主工作区 Skill 才纳管。`SKILL_CONTROL_PANEL_WORKSPACE_ROOTS` 可覆盖默认工作区。发现入口 `~/.agents/skills/`、`~/.codex/skills/`、`~/.claude/skills/`、`~/.gemini/skills/`、`~/.config/opencode/skills/` 只表示可见性，不重复计算为 Agent 层安装。Hub 更新后必须在控制台项目根执行 `node scripts/private-skill-hub.mjs --apply --confirmed` 重新应用逐 Skill 软路由并回填 Registry；不得直接编辑发现入口。

人工项目根记录在 `~/.config/agents/project-roots.yaml`，与自动发现结果按规范绝对路径合并。人工根只扫描直属 `.agents/skills`，不递归猜测内部项目；清单允许记录暂不存在或暂无 Skill 的目录。添加、删除使用独立锁、原子替换和 History 补偿，删除记录不删除任何项目文件。

## 2. 总表与历史

- Registry：`~/.config/agents/skills-registry.yaml`
- History：`~/.config/agents/skills-history.jsonl`
- Trash：`~/.config/agents/trash/`
- 人工项目根：`~/.config/agents/project-roots.yaml`
- 中文能力缓存：`~/.config/agents/skill-capability-translations.json`

Registry 每条记录包含稳定 ID、名称、生命周期、权属、详细能力说明、scope、规范路径、`SKILL.md` 路径、实际路由、来源、当前版本、更新检查结果和时间戳。未知来源或版本使用 `null`，页面显示中性 `--`。

History 只追加事件，记录动作、前后事实、受影响路径、结果和错误。写入前按字段白名单过滤，不保存聊天全文、prompt、message 或其他大段敏感文本。

中文能力缓存按安装实例 ID 保存原文、内容摘要、译文和 `ready | pending | error | stale` 状态。只有 `ready` 且摘要匹配的译文可进入列表与详情；扫描只派生 stale，不隐式写缓存。原能力说明和完整 `SKILL.md` 始终保留，译文不回写 Skill 文件。翻译失败不得回滚安装、更新或纳管事务。

## 3. 事实解析优先级

扫描展示时，Registry 中已有的非空事实优先；`adopt`、`install`、`update` 和 `reconcile` 使用下列规则解析磁盘事实。

能力说明：

1. Registry `capability_summary`
2. `SKILL.md` frontmatter `description`
3. 正文第一个有效说明段落

当前版本：

1. `SKILL.md` frontmatter `version`
2. `package.json` `version`
3. 当前 HEAD 的精确 Git tag
4. Git commit SHA
5. `null / unknown`

来源：

1. frontmatter `source` 或 `repository`
2. `metadata.openclaw.homepage` 或 `metadata.clawdbot.homepage`
3. Git `origin`；同时记录仓库根、Skill 子路径和当前 revision
4. `package.json` `repository`
5. 有 `SKILL.md` 时为 `local`，否则为 `unknown`

页面链接按 `source.url`、`source.repository` 的顺序回退；仅 `http:` 和 `https:` 地址可点击，两者都没有时显示 `--`。

## 4. 更新检查

更新状态只有：`up_to_date | update_available | not_checkable | unknown | error`。顶部“有更新数”只统计 `update_available`。

Git/GitHub 来源在临时目录执行浅克隆，按 `ref` 和 `subpath` 计算远端目录摘要，与本地摘要比较，并记录远端 revision。临时目录无论成功或失败都必须清理。本地、插件和未知来源返回 `not_checkable`。瞬时检查错误不得覆盖最近一次成功的状态和 `latest`，错误原因写入 `update.error`。

## 5. CLI 管理规范

跨 Agent 对话优先使用统一功能注册表中的稳定名称：

```text
skill-inventory-scan | skill-environment-validate | skill-update-check
skill-install | skill-update | skill-move | skill-uninstall | skill-adopt | skill-reconcile
skill-translation-sync | skill-translation-retry
project-path-list | project-path-add | project-path-update | project-path-remove | project-path-scan
agent-route-migrate
```

注册表同时生成 CLI 契约、`GET /api/chat-functions` 和管理规范页。每项明确用途、参数、是否写操作及是否需要确认；旧命令继续作为兼容别名。

### Agent 翻译闭环

在 Agent 对话中完成 `skill-install`、`skill-update`、`skill-adopt`、`skill-reconcile`、`project-path-scan` 或 `skill-inventory-scan` 后，当前 Agent 必须在报告完成前：

1. 调用 `skill-translation-retry --json` 读取全部 `pending | error | stale` 实例；
2. 依据每条记录的原能力说明生成中文能力介绍；
3. 用 `instanceId`、`contentDigest`、`translatedText` 组成输入，调用 `skill-translation-sync --input <json-file> --confirmed --json`；
4. 再次调用 `skill-translation-retry --json`，确认队列为空。

`skill-translation-retry` 始终只读。`skill-translation-sync` 是唯一写入入口：它会校验当前内容摘要，并可为当前扫描仍存在但缓存缺失的实例初始化翻译记录；任何实例不存在、摘要不一致或译文为空时，整个批次不写入。翻译失败不回滚已有 Skill 文件事务，但 Agent 必须报告未就绪项。

人工项目根默认只扫描 `<projectRoot>/.agents/skills`。需要试用一组直接放在项目根下的独立 Skill 时，显式使用 `project-path-update --scan-mode direct-skill-folders --confirmed`；该模式仅额外扫描直系、包含 `SKILL.md` 的目录，不递归扫描其他内容。

严格命令格式如下。仓库内的实际执行入口统一为 `npm run skillctl -- <参数>`，下列 `skillctl` 是参数契约的简写：

```text
skillctl scan [--json]
skillctl adopt (--all | --path <path>) [--json]
skillctl validate [--skill <id>] [--json]
skillctl check-updates [--skill <id>] [--json]
skillctl reconcile [--skill <id>] --confirmed [--json]
skillctl install --source <path> --scope public --vetted [--json]
skillctl install --source <path> --scope project --project-root <absolute-path> --vetted [--json]
skillctl install --source <path> --scope agent --agent <agent> --vetted [--json]
skillctl update --skill <id> --source <path> --vetted [--json]
skillctl move --skill <id> --scope public --confirmed [--json]
skillctl move --skill <id> --scope project --project-root <absolute-path> --confirmed [--json]
skillctl move --skill <id> --scope agent --agent <agent> --confirmed [--json]
skillctl uninstall --skill <id> --confirmed [--json]
skillctl migrate-routes --agent <agent> --confirmed [--json]
```

`<agent>` 仅允许 `codex | claude | antigravity | opencode`。项目层必须显式传入绝对 `--project-root`，不能依赖控制台仓库的当前工作目录。未知参数、重复参数、缺值、非法枚举或互斥参数同时出现时退出码为 `2`；操作或验证失败为 `1`；成功为 `0`。

安全约束：

- `--source` 必须是已落到本地且包含有效 `SKILL.md` 的目录。
- 外部内容在使用 `--vetted` 前必须完成安全审查；该参数是明确确认，不会自动执行审查。
- `--confirmed` 表示用户已确认影响路径和恢复方法。
- Skill 名称不得包含路径分隔符、`.`、`..` 或逃逸目标根目录。

## 6. 锁、事务与跨文件系统移动

所有 Registry 写事务使用 `<registry>.lock` 的独占创建锁。默认最多等待 10 秒；锁超过 30 秒且其 PID 已不存在时才允许回收。存活进程持有的锁不得被时间阈值单独抢占。

安装、更新、移动、卸载、Agent 路由和 reconcile 在同一锁内执行。实现顺序为 staging、验证、文件/路由变更、原子 Registry 替换、History 追加；任一步失败都按逆序补偿。跨文件系统移动在目标侧复制、校验摘要并原子改名，源目录先改名为备份，提交后再清理。

## 7. Agent 路由迁移

Agent 私有 Skill 使用逐 Skill 符号链接暴露到各 Agent 的发现目录。若发现目录本身仍是整目录符号链接，管理器拒绝隐式替换，并要求显式运行：

```bash
npm run skillctl -- migrate-routes --agent <agent> --confirmed --json
```

迁移只接受受支持 Agent，先把整目录链接移动到 `trash/route-migrations/` 备份，再创建目录和逐 Skill 路由；失败自动恢复。Claude Code 逐 Skill 路由的最低版本是 `2.1.203`。本机当前检测版本属于运行时证据，不写成永久产品契约；低于门槛时只报告诊断，不替换现有链接。

Hub 公共 Skill 的 `~/.agents/skills/<name>` 也是受管发现路由。`move`、`uninstall` 与路由更新可安全处理“Agent 入口 → 通用入口 → 实体源”的逐 Skill 链式链接：仅当链条最终仍指向 Registry 记录的原实体时才删除，避免误删同名外部路由。

## 8. Trash 恢复

`uninstall` 把规范目录移动到 `~/.config/agents/trash/<timestamp>/<name>`，并把 Registry 生命周期改为 `removed`，不做永久删除。

恢复流程：

1. 确认 Trash 目录中的 `SKILL.md` 和内容完整。
2. 按原 scope 运行 `install --source <trash-path> ... --vetted`；Agent scope 同时指定原 `--agent`。
3. 运行 `validate --skill <id> --json`，确认路径、路由、Registry 和 History 一致。
4. 验证完成前不要手工删除 Trash 副本。

## 9. 只读服务边界

浏览器只允许 GET API：overview、skills、skill detail、updates、diagnostics、history、governance、health、projects、chat-functions、translations/status。任何 `/api/*` 非 GET 请求返回 `405`；服务不配置通配 CORS。启动、读取详情、刷新缓存和浏览各视图不得改写 Registry、History、项目清单、翻译缓存、Skill 文件或 Agent 路由。

“可见 Agent”按启用配置、实例目录和治理路由推导：public/project 只显示“声明共享”，不自动生成四个 Agent 标签；system/plugin/private 只显示真实所属 Agent，实际路由可补充 routed。Codex 以 `.system` 和 `config.toml enabled=true` 为准，Claude 以 `installed_plugins.json` 为准，OpenCode 以 `opencode.json plugin[]` 为准，Antigravity 只扫描独立配置 Skill 根。该字段不代表已逐个 Agent 运行验证。

## 10. 常见故障

- `Timed out acquiring lock`：确认是否有仍在运行的 CLI；不要删除存活进程的锁。
- `DIRECTORY_ROUTE_MIGRATION_REQUIRED`：先核对 Agent 版本和整目录链接，再显式执行 `migrate-routes`。
- `instance_difference`：同名实例的版本、来源或内容不同；在详情逐项核对，不会阻止只读库存展示。
- 更新检查 `error`：查看网络、仓库权限、ref 和 subpath；本地已安装内容不会因此变化。
- 页面显示 `--`：表示当前事实中没有可靠来源或版本，不是错误，也不需要标红。
