import { homedir } from "node:os";
import { join } from "node:path";

export const APP_NAME = "skill-control-panel";
export const DEFAULT_PORT = Number.parseInt(
  process.env.SKILL_CONTROL_PANEL_PORT || "42873",
  10,
);

export const APP_CONFIG_DIR =
  process.env.SKILL_CONTROL_PANEL_CONFIG_DIR ||
  join(homedir(), ".config", APP_NAME);

export const AGENTS_CONFIG_DIR = process.env.AGENTS_CONFIG_DIR || join(homedir(), ".config", "agents");
export const REGISTRY_PATH = join(AGENTS_CONFIG_DIR, "skills-registry.yaml");
export const HISTORY_PATH = join(AGENTS_CONFIG_DIR, "skills-history.jsonl");
export const TRASH_DIR = join(AGENTS_CONFIG_DIR, "trash");
export const PROJECT_ROOTS_PATH = join(AGENTS_CONFIG_DIR, "project-roots.yaml");
export const CAPABILITY_TRANSLATIONS_PATH = join(AGENTS_CONFIG_DIR, "skill-capability-translations.json");
export const SKILL_HUB_CONFIG_PATH = join(AGENTS_CONFIG_DIR, "skill-hub.yaml");

export const METADATA_PATH = join(APP_CONFIG_DIR, "metadata.json");
export const TRANSLATIONS_PATH = join(APP_CONFIG_DIR, "translations.json");
export const SERVER_STATE_PATH = join(APP_CONFIG_DIR, "server.json");
export const SERVER_LOG_PATH = join(APP_CONFIG_DIR, "server.log");
export const EXPOSURE_STATE_PATH = join(APP_CONFIG_DIR, "exposures.json");
export const DISABLED_EXPOSURE_DIR = join(APP_CONFIG_DIR, "disabled-exposures");
export const GOVERNANCE_STATE_PATH = join(APP_CONFIG_DIR, "governance.json");

export const PRIMARY_PROVIDER_PRIORITY = [
  "claude",
  "agents",
  "codex",
  "opencode",
  "gemini",
];

export const CATEGORY_OPTIONS = [
  "core-writing-distribution",
  "research-collection",
  "design-media",
  "docs-productivity",
  "automation-system",
  "vertical-analysis",
  "other",
];

export const CATEGORY_LABELS = {
  "core-writing-distribution": "写作与分发",
  "research-collection": "研究与采集",
  "design-media": "设计与媒体",
  "docs-productivity": "文档与效率",
  "automation-system": "自动化与系统",
  "vertical-analysis": "垂直分析",
  other: "其他",
};

export const STATUS_OPTIONS = [
  "core",
  "active",
  "hidden",
  "candidate-remove",
];

export const STATUS_LABELS = {
  core: "核心",
  active: "已启用",
  hidden: "已隐藏",
  "candidate-remove": "候选移除",
};

export const PRIORITY_OPTIONS = ["high", "medium", "low"];

export const PRIORITY_LABELS = {
  high: "高",
  medium: "中",
  low: "低",
};

export const CORE_SKILL_NAMES = new Set([
  "deep-writer",
  "humanizer-zh",
  "defuddle",
  "wechat-article-formatter",
  "wechat-illustration-pipeline",
  "x-tweet-fetcher",
  "x-tweet-writer",
  "xhs-content-pipeline",
]);

export const CATEGORY_RULES = [
  {
    category: "core-writing-distribution",
    pattern:
      /writer|writing|copywriting|seo|humanizer|wechat|xhs|tweet|social-content|blog|content-strategy|formatter/i,
  },
  {
    category: "research-collection",
    pattern:
      /search|fetch|collector|defuddle|open-link|websearch|browser|opencli|web-access|webapp|favorites|chat-history|doc|perm|send-file|screenshot|digest/i,
  },
  {
    category: "design-media",
    pattern:
      /design|image|illustrat|comic|cover|infographic|slide|canvas|art|ppt|diagram|mermaid|excalidraw|video|pdf|docx|pptx|xlsx|ui|ux/i,
  },
  {
    category: "docs-productivity",
    pattern:
      /obsidian|markdown|json-canvas|bases|doc-coauthoring|doc-image-sync|internal-comms|memory/i,
  },
  {
    category: "automation-system",
    pattern:
      /automation|workflow|1password|git|tmux|controller|self-reflection|reflection|skill|mcp|plugin|plan|debug|test-runner|code\b/i,
  },
  {
    category: "vertical-analysis",
    pattern:
      /stock|tvscreener|backtest|aminer|research-paper|security|architecture|interview|supabase|market/i,
  },
];

export const CATEGORY_TAG_LABELS = {
  "core-writing-distribution": "写作与分发",
  "research-collection": "研究与采集",
  "design-media": "设计与媒体",
  "docs-productivity": "文档与效率",
  "automation-system": "自动化与系统",
  "vertical-analysis": "垂直分析",
  other: "其他",
};

export const TAG_RULES = [
  { tag: "写作", pattern: /writer|writing|copywriting|humanizer|formatter|article/i },
  { tag: "内容分发", pattern: /wechat|tweet|twitter|xhs|social-content|blog|content-strategy|post/i },
  { tag: "搜索", pattern: /search|smart-search|find/i },
  { tag: "抓取", pattern: /fetch|collector|defuddle|open-link|favorites|screenshot|digest/i },
  { tag: "浏览器", pattern: /browser|opencli|web-access|webapp/i },
  { tag: "文档", pattern: /doc|markdown|internal-comms|docx|pdf|pptx|xlsx/i },
  { tag: "知识库", pattern: /obsidian|memory|canvas|bases|json-canvas/i },
  { tag: "设计", pattern: /design|brand|theme|diagram|mermaid|excalidraw|ui|ux/i },
  { tag: "图像", pattern: /image|illustrat|comic|cover|infographic|art/i },
  { tag: "视频", pattern: /video|ffmpeg|frames/i },
  { tag: "自动化", pattern: /automation|workflow|cron|controller|tmux|1password/i },
  { tag: "开发", pattern: /code\b|debug|test-runner|git|mcp|plugin|builder|server/i },
  { tag: "飞书", pattern: /feishu|lark/i },
  { tag: "微信", pattern: /wechat/i },
  { tag: "X/Twitter", pattern: /tweet|twitter|\bx\b/i },
  { tag: "小红书", pattern: /xhs|xiaohongshu/i },
  { tag: "学术", pattern: /aminer|research-paper|academic/i },
  { tag: "金融", pattern: /stock|tvscreener|backtest/i },
  { tag: "安全", pattern: /security|clawdefender/i },
  { tag: "调研", pattern: /research|market/i },
];
