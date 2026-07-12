const defs = [
  ["skill-inventory-scan", "扫描 Skill 库存", "扫描 Hub、公共、Agent 和项目层的全部安装实例，并返回诊断与统计；在 Agent 对话中，扫描后必须批量补齐全部未就绪中文能力。", false, false, [], "调用 skill-inventory-scan", "skill-inventory-scan --json"],
  ["skill-environment-validate", "验证 Skill 环境", "验证实体路径、Registry、Hub 与 Agent 发现路由及扫描诊断，可限定单个实例。", false, false, ["skillId?"], "调用 skill-environment-validate，skillId 为 <id>", "skill-environment-validate --skill <id> --json"],
  ["skill-update-check", "检查 Skill 更新", "对指定或全部可检查来源执行远端更新检查，不修改 Skill 内容。", false, false, ["skillId?"], "调用 skill-update-check", "skill-update-check --json"],
  ["skill-install", "安装 Skill 并触发中文翻译", "从已审查来源事务式安装 Skill；成功后当前 Agent 必须在同一次对话中批量补齐全部未就绪中文能力。", true, false, ["source", "scope", "agent?", "projectRoot?", "vetted", "translationInput?"], "调用 skill-install，从 <source> 安装到 public", "skill-install --source <path> --scope public --vetted --json"],
  ["skill-update", "更新 Skill 并刷新中文翻译", "事务式更新指定安装实例；成功后当前 Agent 必须在同一次对话中批量补齐全部未就绪中文能力。", true, false, ["skillId", "source", "vetted", "translationInput?"], "调用 skill-update，skillId 为 <id>", "skill-update --skill <id> --source <path> --vetted --json"],
  ["skill-move", "移动 Skill 层级", "在公共、Agent 私有或项目层之间事务式移动安装实例及治理路由。", true, true, ["skillId", "scope", "agent?", "projectRoot?", "confirmed"], "确认调用 skill-move，将 <id> 移到项目层", "skill-move --skill <id> --scope project --project-root <path> --confirmed --json"],
  ["skill-uninstall", "卸载 Skill 到 Trash", "将指定实例移入 Trash 并保留补偿信息，不执行物理擦除。", true, true, ["skillId", "confirmed"], "确认调用 skill-uninstall，实例为 <id>", "skill-uninstall --skill <id> --confirmed --json"],
  ["skill-adopt", "纳管现有 Skill", "把扫描发现的未纳管实例写入 Registry；成功后当前 Agent 必须在同一次对话中批量补齐全部未就绪中文能力。", true, false, ["all|path"], "调用 skill-adopt，纳管全部未管理实例", "skill-adopt --all --json"],
  ["skill-reconcile", "刷新当前事实", "重新解析全部或指定实例的来源、版本、能力摘要和可更新语义；完成后当前 Agent 必须在同一次对话中批量补齐全部未就绪中文能力。", true, true, ["skillId?", "confirmed"], "确认调用 skill-reconcile，skillId 为 <id>", "skill-reconcile --skill <id> --confirmed --json"],
  ["skill-translation-sync", "同步中文能力缓存", "校验并写入一批由当前对话 Agent 生成的中文能力介绍，可为当前扫描仍存在但缓存缺失的实例初始化记录。", true, true, ["input", "confirmed"], "确认调用 skill-translation-sync，输入文件为 <json>", "skill-translation-sync --input <json-file> --confirmed --json"],
  ["skill-translation-retry", "获取待重试翻译", "返回全部 pending、error 或 stale 实例、当前摘要及原能力说明，供 Agent 批量补齐中文能力。", false, false, ["skillId?"], "调用 skill-translation-retry", "skill-translation-retry --json"],
  ["project-path-list", "查看项目路径", "读取人工维护的项目根目录清单，不触发磁盘变更。", false, false, [], "调用 project-path-list", "project-path-list --json"],
  ["project-path-add", "添加项目路径", "向人工项目清单添加规范绝对路径；不创建项目目录或 Skill 根。", true, true, ["path", "label?", "confirmed"], "确认调用 project-path-add，路径为 <path>", "project-path-add --path <absolute-path> --confirmed --json"],
  ["project-path-update", "调整项目扫描方式", "修改已登记项目的 Skill 扫描方式；仅改变清单，不移动或删除项目文件。", true, true, ["path|id", "scanMode", "confirmed"], "确认调用 project-path-update，将 <path> 设为 direct-skill-folders", "project-path-update --path <absolute-path> --scan-mode direct-skill-folders --confirmed --json"],
  ["project-path-remove", "删除项目路径记录", "仅从人工清单移除路径记录，不删除项目文件或其中的 Skill。", true, true, ["path|id", "confirmed"], "确认调用 project-path-remove，路径为 <path>", "project-path-remove --path <absolute-path> --confirmed --json"],
  ["project-path-scan", "扫描项目路径", "检查人工项目根是否存在、是否包含 .agents/skills，并返回扫描状态。", false, false, ["path|id?"], "调用 project-path-scan", "project-path-scan --json"],
  ["agent-route-migrate", "迁移 Agent 路由", "显式迁移指定 Agent 的治理路由，并保留可回滚的历史记录。", true, true, ["agent", "confirmed"], "确认调用 agent-route-migrate，Agent 为 codex", "agent-route-migrate --agent codex --confirmed --json"],
];

export const CHAT_FUNCTIONS = defs.map(([name, title, description, mutating, requiresConfirmation, parameters, example, cli]) => ({
  name, title, description, mutating, requiresConfirmation, parameters, example,
  cliExample: `npm run skillctl -- ${cli}`,
  handler: name,
}));

export function getChatFunction(name) {
  const found = CHAT_FUNCTIONS.find((item) => item.name === name);
  if (!found) throw new Error(`Unknown chat function: ${name}`);
  return found;
}
