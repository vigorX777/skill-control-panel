const AGENTS = ["codex", "claude", "antigravity", "opencode"];
const SCOPES = ["public", "agent", "project"];

const COMMANDS = {
  scan: {},
  adopt: {
    all: { type: "boolean" },
    path: { type: "value" },
  },
  install: {
    source: { type: "value", required: true },
    scope: { type: "value", required: true, values: SCOPES },
    agent: { type: "value", values: AGENTS },
    "project-root": { type: "value" },
    vetted: { type: "boolean", required: true },
  },
  update: {
    skill: { type: "value", required: true },
    source: { type: "value", required: true },
    vetted: { type: "boolean", required: true },
  },
  move: {
    skill: { type: "value", required: true },
    scope: { type: "value", required: true, values: SCOPES },
    agent: { type: "value", values: AGENTS },
    "project-root": { type: "value" },
    confirmed: { type: "boolean", required: true },
  },
  uninstall: {
    skill: { type: "value", required: true },
    confirmed: { type: "boolean", required: true },
  },
  "check-updates": {
    skill: { type: "value" },
  },
  validate: {
    skill: { type: "value" },
  },
  reconcile: {
    confirmed: { type: "boolean", required: true },
    skill: { type: "value" },
  },
  "migrate-routes": {
    agent: { type: "value", required: true, values: AGENTS },
    confirmed: { type: "boolean", required: true },
  },
  "project-path-list": {},
  "project-path-add": { path: { type: "value", required: true }, label: { type: "value" }, confirmed: { type: "boolean", required: true } },
  "project-path-update": { path: { type: "value" }, id: { type: "value" }, "scan-mode": { type: "value", required: true, values: ["standard", "direct-skill-folders"] }, confirmed: { type: "boolean", required: true } },
  "project-path-remove": { path: { type: "value" }, id: { type: "value" }, confirmed: { type: "boolean", required: true } },
  "project-path-scan": { path: { type: "value" }, id: { type: "value" } },
  "skill-translation-sync": { input: { type: "value", required: true }, confirmed: { type: "boolean", required: true } },
  "skill-translation-retry": { skill: { type: "value" } },
  "skill-inventory-scan": {},
  "skill-environment-validate": { skill: { type: "value" } },
  "skill-update-check": { skill: { type: "value" } },
  "skill-install": { source: { type: "value", required: true }, scope: { type: "value", required: true, values: SCOPES }, agent: { type: "value", values: AGENTS }, "project-root": { type: "value" }, vetted: { type: "boolean", required: true }, "translation-input": { type: "value" } },
  "skill-update": { skill: { type: "value", required: true }, source: { type: "value", required: true }, vetted: { type: "boolean", required: true }, "translation-input": { type: "value" } },
  "skill-move": { skill: { type: "value", required: true }, scope: { type: "value", required: true, values: SCOPES }, agent: { type: "value", values: AGENTS }, "project-root": { type: "value" }, confirmed: { type: "boolean", required: true } },
  "skill-uninstall": { skill: { type: "value", required: true }, confirmed: { type: "boolean", required: true } },
  "skill-adopt": { all: { type: "boolean" }, path: { type: "value" } },
  "skill-reconcile": { confirmed: { type: "boolean", required: true }, skill: { type: "value" } },
  "agent-route-migrate": { agent: { type: "value", required: true, values: AGENTS }, confirmed: { type: "boolean", required: true } },
};

export class CliUsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "CliUsageError";
    this.exitCode = 2;
  }
}

function validateCommand(command, options) {
  if (["adopt", "skill-adopt"].includes(command) && Boolean(options.all) === Boolean(options.path)) {
    throw new CliUsageError("adopt requires exactly one of --all or --path <path>");
  }
  if (["install", "move", "skill-install", "skill-move"].includes(command)) {
    if (options.scope === "agent" && !options.agent) {
      throw new CliUsageError(`${command} with --scope agent requires --agent <${AGENTS.join("|")}>`);
    }
    if (options.scope !== "agent" && options.agent) {
      throw new CliUsageError(`${command} only accepts --agent with --scope agent`);
    }
    if (options.scope === "project" && !options["project-root"]) {
      throw new CliUsageError(`${command} with --scope project requires --project-root <absolute-path>`);
    }
    if (options.scope !== "project" && options["project-root"]) {
      throw new CliUsageError(`${command} only accepts --project-root with --scope project`);
    }
    if (options["project-root"] && !options["project-root"].startsWith("/")) {
      throw new CliUsageError("--project-root must be an absolute path");
    }
  }
  if (["project-path-remove", "project-path-scan", "project-path-update"].includes(command) && options.path && options.id) throw new CliUsageError(`${command} accepts only one of --path or --id`);
  if (["project-path-remove", "project-path-update"].includes(command) && !options.path && !options.id) throw new CliUsageError(`${command} requires --path or --id`);
}

export function parseSkillctlArgs(argv) {
  if (argv.length === 0) throw new CliUsageError("Usage: skillctl <command> [options]");
  const command = argv[0];
  const schema = COMMANDS[command];
  if (!schema) throw new CliUsageError(`Unknown command: ${command}`);

  const seen = new Set();
  const options = {};
  let json = false;

  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new CliUsageError(`Unexpected argument: ${token}`);
    const flag = token.slice(2);
    if (seen.has(flag)) throw new CliUsageError(`Duplicate flag: --${flag}`);
    seen.add(flag);

    if (flag === "json") {
      json = true;
      continue;
    }
    const definition = schema[flag];
    if (!definition) throw new CliUsageError(`Unknown flag for ${command}: --${flag}`);
    if (definition.type === "boolean") {
      options[flag] = true;
      continue;
    }

    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new CliUsageError(`Flag --${flag} requires a value`);
    }
    if (definition.values && !definition.values.includes(value)) {
      throw new CliUsageError(`Invalid --${flag}: ${value}; expected ${definition.values.join("|")}`);
    }
    options[flag] = value;
    index += 1;
  }

  for (const [flag, definition] of Object.entries(schema)) {
    if (definition.required && options[flag] === undefined) {
      throw new CliUsageError(`Missing required flag: --${flag}`);
    }
  }
  validateCommand(command, options);
  return { command, json, options };
}
