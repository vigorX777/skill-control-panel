import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

import { METADATA_PATH, TRANSLATIONS_PATH } from "./constants.mjs";
import { readJsonFile, writeJsonFile } from "./metadata.mjs";

const execFileAsync = promisify(execFile);
const TRANSLATION_CLI_ENV_NAME = "SKILL_CONTROL_PANEL_TRANSLATION_CLI";

function metadataPathFromOptions(options = {}) {
  return options.metadataPath || process.env.SKILL_CONTROL_PANEL_METADATA_PATH || METADATA_PATH;
}

export function translationsPathFromOptions(options = {}) {
  if (options.translationsPath) {
    return options.translationsPath;
  }

  if (metadataPathFromOptions(options) !== METADATA_PATH) {
    return join(dirname(metadataPathFromOptions(options)), "translations.json");
  }

  return TRANSLATIONS_PATH;
}

export async function readTranslationsStore(options = {}) {
  return readJsonFile(translationsPathFromOptions(options), {
    version: 1,
    skills: {},
  });
}

async function writeTranslationsStore(options, value) {
  await writeJsonFile(translationsPathFromOptions(options), value);
}

export function localizationSourceHash(skill) {
  return createHash("sha1")
    .update(`${skill.name}\n${skill.description || ""}`)
    .digest("hex");
}

function deriveLocalizationRecord(skill, store) {
  const sourceHash = localizationSourceHash(skill);
  const cached = store.skills?.[skill.id];
  const isCurrent = cached?.sourceHash === sourceHash;
  const state = isCurrent ? cached?.state || "missing" : "missing";
  const zhHans = isCurrent ? cached?.zhHans || null : null;

  return {
    currentLocale: state === "ready" ? "zh-Hans" : "en",
    state,
    updatedAt: isCurrent ? cached?.updatedAt || null : null,
    errorMessage: isCurrent ? cached?.errorMessage || "" : "",
    zhHans,
  };
}

export function attachLocalizationToSkills(skills, store) {
  return skills.map((skill) => ({
    ...skill,
    localization: deriveLocalizationRecord(skill, store),
  }));
}

export function needsTranslation(skill, store) {
  const sourceHash = localizationSourceHash(skill);
  const cached = store.skills?.[skill.id];

  if (!skill.name && !skill.description) {
    return false;
  }

  if (!cached) {
    return true;
  }

  if (cached.sourceHash !== sourceHash) {
    return true;
  }

  return cached.state !== "ready";
}

function extractJsonObject(text) {
  const trimmed = text.trim();

  try {
    return JSON.parse(trimmed);
  } catch (error) {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) {
      throw error;
    }
    return JSON.parse(match[0]);
  }
}

function buildTranslationPrompt(skill) {
  return [
    "Translate the following skill metadata into concise Simplified Chinese.",
    "Keep product and brand names when appropriate.",
    'Return only valid JSON with keys "name" and "description".',
    "",
    `English name: ${skill.name}`,
    `English description: ${skill.description || ""}`,
  ].join("\n");
}

function selectedTranslationCli(options = {}) {
  const env = { ...process.env, ...(options.env || {}) };
  const configured = (
    options.translationCli ||
    env[TRANSLATION_CLI_ENV_NAME] ||
    ""
  ).trim();

  if (configured) {
    return configured;
  }

  if (
    env.CODEX_SHELL ||
    env.CODEX_THREAD_ID ||
    env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE ||
    env.__CFBundleIdentifier === "com.openai.codex" ||
    env.__CFBundleIdentifier?.includes?.("codex")
  ) {
    return "codex";
  }

  if (env.CLAUDE_CODE_SKIP_NETWORK_CHECK || env.CLAUDE_PROJECT_DIR) {
    return "claude";
  }

  if (env.OPENCODE_PROJECT || env.OPENCODE_SESSION_ID) {
    return "opencode";
  }

  return "";
}

async function executeTranslationCommand(command, args, options = {}) {
  if (typeof options.runTranslationCommand === "function") {
    return options.runTranslationCommand(command, args, options);
  }

  const { stdout } = await execFileAsync(command, args, {
    cwd: options.cwd || process.cwd(),
    env: { ...process.env, ...(options.env || {}) },
    maxBuffer: 5 * 1024 * 1024,
  });
  return stdout;
}

async function translateWithClaude(skill, options = {}) {
  const prompt = buildTranslationPrompt(skill);
  const stdout = await executeTranslationCommand(
    options.translationCliPath || "claude",
    [
      "-p",
      "--output-format",
      "text",
      "--permission-mode",
      "plan",
      "--tools",
      "",
      prompt,
    ],
    options,
  );

  const parsed = extractJsonObject(stdout);
  return {
    name: typeof parsed?.name === "string" && parsed.name.trim() ? parsed.name.trim() : skill.name,
    description:
      typeof parsed?.description === "string" ? parsed.description.trim() : skill.description || "",
  };
}

async function translateWithCodex(skill, options = {}) {
  const prompt = buildTranslationPrompt(skill);
  const stdout = await executeTranslationCommand(
    options.translationCliPath || "codex",
    [
      "exec",
      "--skip-git-repo-check",
      "--dangerously-bypass-approvals-and-sandbox",
      "--json",
      prompt,
    ],
    options,
  );

  const lastLine = stdout
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);

  const payload = lastLine ? JSON.parse(lastLine) : {};
  const text = payload?.last_message || payload?.message || payload?.content || stdout;
  const parsed = extractJsonObject(typeof text === "string" ? text : JSON.stringify(text));
  return {
    name: typeof parsed?.name === "string" && parsed.name.trim() ? parsed.name.trim() : skill.name,
    description:
      typeof parsed?.description === "string" ? parsed.description.trim() : skill.description || "",
  };
}

async function translateWithGemini(skill, options = {}) {
  const prompt = buildTranslationPrompt(skill);
  const stdout = await executeTranslationCommand(
    options.translationCliPath || "gemini",
    [prompt],
    options,
  );

  const parsed = extractJsonObject(stdout);
  return {
    name: typeof parsed?.name === "string" && parsed.name.trim() ? parsed.name.trim() : skill.name,
    description:
      typeof parsed?.description === "string" ? parsed.description.trim() : skill.description || "",
  };
}

async function translateWithOpenCode(skill, options = {}) {
  const prompt = buildTranslationPrompt(skill);
  const stdout = await executeTranslationCommand(
    options.translationCliPath || "opencode",
    ["run", "--prompt", prompt],
    options,
  );

  const parsed = extractJsonObject(stdout);
  return {
    name: typeof parsed?.name === "string" && parsed.name.trim() ? parsed.name.trim() : skill.name,
    description:
      typeof parsed?.description === "string" ? parsed.description.trim() : skill.description || "",
  };
}

async function translateWithConfiguredCli(skill, options = {}) {
  const cli = selectedTranslationCli(options);

  if (!cli) {
    throw new Error(`Missing ${TRANSLATION_CLI_ENV_NAME}`);
  }

  if (cli === "claude") {
    return translateWithClaude(skill, options);
  }

  if (cli === "codex") {
    return translateWithCodex(skill, options);
  }

  if (cli === "gemini") {
    return translateWithGemini(skill, options);
  }

  if (cli === "opencode") {
    return translateWithOpenCode(skill, options);
  }

  throw new Error(`Unsupported translation CLI: ${cli}`);
}

export async function translateSkillMetadata(skill, options = {}) {
  if (typeof options.translateRunner === "function") {
    return options.translateRunner(skill);
  }

  return translateWithConfiguredCli(skill, options);
}

export async function fillMissingTranslations(skills, options = {}) {
  const store = await readTranslationsStore(options);
  const queue = skills.filter((skill) => needsTranslation(skill, store));

  if (!queue.length) {
    return { changed: false, translatedSkillIds: [] };
  }

  let changed = false;
  const translatedSkillIds = [];

  for (const skill of queue) {
    store.skills[skill.id] = {
      sourceHash: localizationSourceHash(skill),
      state: "pending",
      zhHans: null,
      updatedAt: new Date().toISOString(),
      errorMessage: "",
    };
    changed = true;
  }

  if (changed) {
    await writeTranslationsStore(options, store);
  }

  for (const skill of queue) {
    try {
      const translated = await translateSkillMetadata(skill, options);
      store.skills[skill.id] = {
        sourceHash: localizationSourceHash(skill),
        state: "ready",
        zhHans: translated,
        updatedAt: new Date().toISOString(),
        errorMessage: "",
      };
      translatedSkillIds.push(skill.id);
    } catch (error) {
      store.skills[skill.id] = {
        sourceHash: localizationSourceHash(skill),
        state: "error",
        zhHans: null,
        updatedAt: new Date().toISOString(),
        errorMessage: error.message,
      };
    }

    await writeTranslationsStore(options, store);
  }

  return {
    changed: true,
    translatedSkillIds,
  };
}
