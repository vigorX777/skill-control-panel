# Skill Control Panel V2 开发设计

## 1. 产品目标

Skill Control Panel V2 是一个面向个人开发者的本地 Skill 治理系统，覆盖 Codex、Claude Code、Antigravity 和 OpenCode。

系统只维护当前事实，不维护“期望状态”：

- 当前安装了什么 Skill
- Skill 的公共、Agent 或项目层级
- 当前版本、来源和详细能力说明
- 实际安装路径、路由路径和可见 Agent
- 最近一次更新检查结果
- 每次安装、接管、更新、迁移和卸载历史

所有会改变 Skill 文件、路由或 Agent 配置的操作都通过 Agent 对话调用 `skillctl` 完成。浏览器页面保持只读，只提供库存、详情、更新状态、环境诊断、历史和管理规范。

## 2. 范围与边界

### 2.1 V2 支持

- 公共层：四个 Agent 和所有项目共用
- Agent 层：只供一个 Agent 使用
- 项目层：只在一个项目目录中使用，默认向四个 Agent 暴露
- 总表和追加式历史日志
- Git/GitHub、插件、本地目录和未知来源
- 当前版本识别与更新检查
- 完整 `SKILL.md` 查看与复制
- 只读前端和复制聊天指令

### 2.2 V2 不支持

- 项目层和 Agent 层交叉组合
- 页面直接安装、更新、停用、卸载或迁移
- desired state、自动收敛或自动更新
- 自动删除无法识别的目录
- 使用页面修改 `SKILL.md`

## 3. 目录与路由

| 层级 | 规范主路径 | 说明 |
|---|---|---|
| 公共 | `~/.agents/skills/<name>` | 唯一真实副本，兼容 Agent 使用路由发现 |
| Agent | `~/.config/agents/agent-skills/<agent>/<name>` | 只向指定 Agent 暴露；Codex/Claude 可使用私有插件适配 |
| 项目 | `<project>/.agents/skills/<name>` | 项目内唯一真实副本 |

相同真实路径的多入口只计一个 Skill；同名但真实路径不同必须诊断为冲突。

Claude Code 逐 Skill 符号链接要求 2.1.203 或更高版本。具体本机版本属于每次运行时检测证据，不是永久设计常量；扫描器在版本不足时报告兼容性问题，管理器不得替换当前整目录链接。

## 4. 数据模型

### 4.1 总表

路径：`~/.config/agents/skills-registry.yaml`

每条记录包含：

- `id`：规范化真实路径的稳定摘要
- `name`
- `lifecycle`：`active | removed`
- `ownership`：`managed | adopted | plugin | system | unmanaged`
- `capability_summary`
- `scope.level`：`public | agent | project`
- `scope.agent`
- `scope.project_root`
- `install.canonical_path`
- `install.skill_md_path`
- `install.routes[]`
- `source.type`：`github | git | plugin | local | unknown`
- `source.url/repository/subpath/ref/revision/content_digest`
- `version.current/kind/basis`
- `update.status/latest/checked_at/error`
- `installed_at/updated_at`

缺少来源或版本时保存 `null`，前端统一显示 `--`。总表只保存当前事实，不保存期望版本。

### 4.2 历史

路径：`~/.config/agents/skills-history.jsonl`

事件类型：

- `install`
- `adopt_existing`
- `update_check`
- `update`
- `uninstall`
- `scope_change`
- `route_change`
- `source_change`
- `validation_failed`

历史记录事件 ID、时间、执行 Agent、Skill ID、动作、前后版本/来源/层级、受影响路径、结果和错误。历史只追加，不保存聊天全文和敏感信息。

## 5. 能力说明、版本与更新

能力说明优先使用总表中的 `capability_summary`。接管已有 Skill 时使用 frontmatter `description` 和正文第一个有效说明段落生成回退摘要；Agent 安装流程应基于完整 `SKILL.md` 生成 120–500 个中文字符的说明，覆盖用途、触发场景、主要输入输出和关键依赖。

版本依据优先级：

1. `SKILL.md` frontmatter
2. 插件或包清单
3. Git tag
4. commit SHA
5. 未知

来源依据优先级：

1. `SKILL.md` frontmatter `source` / `repository`，以及兼容的 `metadata.*.homepage`
2. Git `origin`，同时记录仓库根、Skill 子路径和当前 revision
3. `package.json` repository
4. 本地目录
5. 未知

更新状态：`up_to_date | update_available | not_checkable | unknown | error`。只有 `update_available` 进入“有更新数”。Git 更新检查在临时目录读取远端 ref 和对应 Skill 子目录，比较内容摘要；本地目录和未知来源不检查。

瞬时远端错误不得覆盖最近一次成功的 `up_to_date` / `update_available` 状态和 `latest`，但必须更新检查时间并记录 `error`。

## 6. 聊天式管理

稳定命令入口：仓库内使用 `npm run skillctl -- <参数>`；下列 `skillctl` 是参数契约的简写。

```text
skillctl scan
skillctl adopt --all
skillctl adopt --path <path>
skillctl install --source <path> --scope public --vetted
skillctl install --source <path> --scope agent --agent <agent> --vetted
skillctl install --source <path> --scope project --project-root <absolute-path> --vetted
skillctl check-updates [--skill <id>]
skillctl update --skill <id> --source <path> --vetted
skillctl move --skill <id> --scope public --confirmed
skillctl move --skill <id> --scope project --project-root <absolute-path> --confirmed
skillctl move --skill <id> --scope agent --agent <agent> --confirmed
skillctl uninstall --skill <id> --confirmed
skillctl validate [--skill <id>]
skillctl reconcile --confirmed
skillctl migrate-routes --agent <agent> --confirmed
```

`--source` 必须是本地有效 Skill 目录。外部安装和更新前必须先执行安全审查并显式传入 `--vetted`。移动、卸载、reconcile 和路由迁移必须传入 `--confirmed`。操作准备临时目录，验证后原子替换；失败时回滚路径、路由、总表和历史。卸载默认移动到 `~/.config/agents/trash/<timestamp>/`，不直接永久删除。

Registry 写入使用 `<registry>.lock` 的跨进程独占锁。默认等待 10 秒；只有锁超过 30 秒且记录 PID 已不存在时才回收。跨文件系统移动采用复制、摘要校验、目标原子改名和源备份清理流程。

## 7. 只读 API

> 2026-07-11 扩展：CLI/scanner 继续输出路径级安装实例；Dashboard API 按精确 Skill 名称聚合逻辑记录并返回 `scopeLevels` 与 `instances[]`。项目 roots 自动发现自 `~/Documents`、`~/Vibecoding`，包含试用目录和 worktree，不跟随目录符号链接。

```text
GET /api/overview
GET /api/skills
GET /api/skills/:id
GET /api/updates
GET /api/diagnostics
GET /api/history
GET /api/governance
GET /api/health
```

现有 Skill action、batch action、basket、metadata PATCH 和 Provider 选择写接口全部移除。任意 `/api/*` 非 GET 方法返回 `405`，服务不配置通配 CORS。前端服务器不具备修改 Skill 文件和 Agent 配置的能力。

## 8. 前端设计

视觉基线为 Quiet Ledger：温和的纸张色背景、深蓝文字、青色正常状态、琥珀色更新提示、低阴影、细分隔线和高可读数据表格。

左侧导航：

- 全部 Skill
- 更新中心
- 环境诊断
- 操作历史
- 管理规范

库存页顶部只保留“总 Skill 数”和“有更新数”两张卡片。表格字段为 Skill、能力介绍、层级、Agent、版本、来源、更新。

来源存在时显示可点击链接；不存在时只显示普通 `--`。能力介绍单行省略，鼠标悬浮或键盘聚焦显示全文。

右侧详情抽屉提供名称和安装路径复制、当前版本、来源、层级、路由、最后检查时间、更新状态，以及完整 `SKILL.md` 原文和“复制全文”。Markdown 以安全纯文本方式展示，不执行 HTML。

更新中心、诊断页和历史页只提供查看、筛选和复制聊天指令，不提供写操作。

## 9. 迁移

第一阶段只扫描并接管当前 `~/.agents/skills` 中的 Skill，写入总表和历史，不改动现有路径。旧 `~/.config/skill-control-panel/metadata.json` 保留为备份。

第二阶段只有在 Claude Code 版本门禁通过、四个 Agent 的发现验证均成功后，才允许把整目录链接迁移为逐 Skill 路由。迁移不作为首次启动的自动动作。

路由迁移必须使用 `migrate-routes --agent <agent> --confirmed`，先把整目录链接移入 `trash/route-migrations/` 备份，再创建目录和逐 Skill链接；失败自动回滚。`uninstall` 的 Trash 内容通过相同 scope 的 `install --source <trash-path> ... --vetted` 恢复，恢复后必须再次运行 `validate`。

## 10. 验收

- 扫描出的每个有效 Skill 都可在库存表定位
- 相同真实路径只计一次
- 缺失来源和版本显示 `--`，不标红
- 能力说明完整且支持省略/悬浮查看
- 详情可复制名称、路径和完整 `SKILL.md`
- 页面只有两张统计卡
- 页面不存在任何 Skill 写操作或写接口
- 聊天操作后，总表、历史和实际路径一致
- 失败操作不留下半安装目录、断链或虚假成功记录
- `npm test` 与 UI 自测通过
