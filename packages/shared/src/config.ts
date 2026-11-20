// Typed schema for the harnessd parent config (D-004). See docs/CONFIG.md.
//
// Field names mirror the TOML keys (snake_case) so that a validation error path
// is exactly the key the user typed.
//
// Note: index.ts re-exports this module and this module imports from index.ts.
// Only touch imported values inside functions, never at module top level.
import { HARNESSES, type HarnessId, isHarnessId } from "./index.ts";

/** Roles an agent can play (D-010). */
export const AGENT_ROLES = ["coordinator", "backend", "frontend", "qa"] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

export function isAgentRole(value: string): value is AgentRole {
  return (AGENT_ROLES as readonly string[]).includes(value);
}

/** Task sizes that get a budget. L has none: it must be split (D-014). */
export const BUDGET_SIZES = ["S", "M"] as const;
export type BudgetSize = (typeof BUDGET_SIZES)[number];

export interface LimitsConfig {
  max_concurrent: number;
  budget_minutes: Record<BudgetSize, number>;
  qa_max_failures: number;
}

export interface LinearConfig {
  team_id?: string;
  project?: string;
}

/**
 * Slack #harnessd (D-015, D-021). The webhook url is a secret: it comes only from
 * HARNESSD_SLACK_WEBHOOK_URL, never from a config file.
 */
export interface SlackConfig {
  /** A label for the start line; the webhook fixes the real channel. */
  channel: string;
  /** When the daily summary goes out, "HH:MM" in `time_zone`. */
  summary_time: string;
  /** An IANA time zone. */
  time_zone: string;
}

/** How harnessd itself checks a PR before QA approves it (D-013). */
export interface QaConfig {
  /** Run first in the fresh QA worktree, e.g. to install dependencies. Empty skips it. */
  setup_command: string;
  /** The repo's tests. QA never approves when it fails, whatever the model says. */
  test_command: string;
}

export interface DaemonConfig {
  /** Port of the local HTTP API on 127.0.0.1. 0 picks a free port. */
  port: number;
}

/** How the merge gate merges a PR (`gh pr merge --squash` and so on). */
export const MERGE_METHODS = ["squash", "merge", "rebase"] as const;
export type MergeMethod = (typeof MERGE_METHODS)[number];

export function isMergeMethod(value: string): value is MergeMethod {
  return (MERGE_METHODS as readonly string[]).includes(value);
}

/** The merge gate (D-013, docs/LOOP.md "Merge"). */
export interface MergeConfig {
  /**
   * Globs matched against each changed file's repo path, case-insensitively. A glob
   * without a `/` matches the file name at any depth. A PR touching any of them waits
   * for a human (D-013).
   */
  protected_paths: string[];
  /** The label a protected PR gets. */
  label: string;
  /** How a PR that passes the gate is merged. */
  method: MergeMethod;
}

/** One `[agents.<name>]` table in config.toml. */
export interface AgentSettings {
  role?: AgentRole;
  harness?: HarnessId;
  model?: string;
  /** Image path (relative to the `.harnessd/` folder) or URL shown for the agent. */
  avatar?: string;
  instructions?: string;
}

/**
 * One `[mcp.<name>]` table: a stdio MCP server every harness gets on `harnessd sync`.
 * Servers merge by name; a later layer replaces the whole entry.
 */
export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/**
 * One `[skills.<name>]` table. The global file records each default skill's pin;
 * any layer can turn a skill off. See docs/CONFIG.md "Skills".
 */
export interface SkillSettings {
  /** false drops the skill from this layer on, so sync does not write it. */
  enabled?: boolean;
  /** The upstream repo, as `owner/name` on GitHub. */
  upstream?: string;
  /** The upstream commit the installed folder holds. init installs only this commit. */
  commit?: string;
  /** The upstream release, when it has one. Informational. */
  version?: string;
}

/** One `[harnesses.<id>]` table: where a harness CLI lives on this machine (MET-28). */
export interface HarnessSettings {
  /** Absolute path to the CLI. When set, the status engine and the loop use it, not PATH. */
  bin?: string;
}

/**
 * A secret reference (MET-33): `op://vault/item/field` (or `op://vault/item/section/field`),
 * read with the 1Password CLI at use time, or `env:NAME`, read from the environment.
 * config.toml holds only references, never a secret value.
 */
export const OP_REFERENCE = /^op:\/\/[^/\s]+\/[^/\s]+(\/[^/\s]+){1,2}$/;
export const ENV_REFERENCE = /^env:[A-Za-z_][A-Za-z0-9_]*$/;

export function isSecretReference(value: string): boolean {
  return OP_REFERENCE.test(value) || ENV_REFERENCE.test(value);
}

/** `[secrets.<service>]` tables of the global config.toml: one reference per secret. */
export interface SecretReferences {
  linear?: { api_key?: string };
  slack?: { webhook_url?: string };
}

const SECRET_KEYS = { linear: ["api_key"], slack: ["webhook_url"] } as const;

/** MCP server names: they become keys in .mcp.json and `[mcp_servers.<name>]` in Codex TOML. */
export const MCP_NAME = /^[A-Za-z0-9_-]+$/;

/** Fully defaulted settings, the part of config.toml other than agents. */
export interface Settings {
  limits: LimitsConfig;
  linear: LinearConfig;
  slack: SlackConfig;
  merge: MergeConfig;
  qa: QaConfig;
  daemon: DaemonConfig;
  harnesses: Partial<Record<HarnessId, HarnessSettings>>;
}

export type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

/** A validated config.toml. Everything is optional; defaults fill the gaps. */
export interface ConfigFile extends DeepPartial<Settings> {
  agents?: Record<string, AgentSettings>;
  mcp?: Record<string, McpServerConfig>;
  skills?: Record<string, SkillSettings>;
  /** Global file only; the loader refuses it in a workspace (MET-33). */
  secrets?: SecretReferences;
}

/** A piece of instruction text and the file it came from. */
export interface InstructionBlock {
  source: string;
  text: string;
}

/** `rules/<name>.md`. */
export interface Rule {
  name: string;
  source: string;
  text: string;
}

/** One hook command, as Claude Code and Codex write it. Other keys stay as they are. */
export interface HookCommand {
  type: string;
  command: string;
  [key: string]: unknown;
}

/** A matcher group of hooks for one event. */
export interface HookGroup {
  matcher?: string;
  hooks: HookCommand[];
  [key: string]: unknown;
}

/** The `hooks` table of a harness settings file: event name to matcher groups. */
export type HookEvents = Record<string, HookGroup[]>;

/** A Claude Code subagent file that a skill ships, `.claude/agents/<name>.md`. */
export interface SkillAgent {
  name: string;
  text: string;
}

/**
 * Harness files a skill ships besides the skill folder, from its `.harnessd-native/`
 * folder: hooks for Claude Code and Codex, and Claude Code subagents. See docs/SYNC.md.
 */
export interface SkillNative {
  claudeHooks?: HookEvents;
  codexHooks?: HookEvents;
  claudeAgents?: SkillAgent[];
}

/** `skills/<folder>/SKILL.md`. The name is the frontmatter `name`, else the folder name. */
export interface Skill {
  name: string;
  description?: string;
  /** The skill folder. */
  dir: string;
  /** The SKILL.md file. */
  source: string;
  body: string;
  /** Frontmatter lines other than `name` and `description`, verbatim, in source order. */
  frontmatter?: string[];
  /** Every other file in the folder, relative and `/`-separated, sorted. Sync copies them. */
  files?: string[];
  /** Hooks and subagents from `.harnessd-native/`; sync merges them into the harness files. */
  native?: SkillNative;
}

/** One agent as defined by a single layer (config.toml table plus `agents/<name>.md`). */
export interface AgentLayerEntry {
  role?: AgentRole;
  harness?: HarnessId;
  model?: string;
  avatar?: string;
  instructions?: InstructionBlock;
  /** File that defined the agent, as shown in errors, and the key prefix used in it. */
  label: string;
  keyPrefix: string;
}

export type ConfigScope = "global" | "workspace";

/** Everything loaded from one `.harnessd/` folder. */
export interface ConfigLayer {
  scope: ConfigScope;
  dir: string;
  settings: DeepPartial<Settings>;
  agents: Record<string, AgentLayerEntry>;
  rules: Rule[];
  skills: Skill[];
  /** `[mcp.<name>]` tables from config.toml. */
  mcp: Record<string, McpServerConfig>;
  /** `[skills.<name>]` tables from config.toml. */
  skillSettings: Record<string, SkillSettings>;
  /** The folder's AGENTS.md, if present and non-empty. */
  instructions?: InstructionBlock;
}

/** An agent after merging every layer. */
export interface Agent {
  name: string;
  role: AgentRole;
  harness: HarnessId;
  model?: string;
  /** Image path or URL; the UI shows the name's initial when unset. */
  avatar?: string;
  /** Agent-specific instructions, global first. */
  instructions: InstructionBlock[];
}

/** The result of merging global → workspace. */
export interface MergedConfig extends Settings {
  agents: Record<string, Agent>;
  /** Sorted by name. */
  rules: Rule[];
  /** Sorted by name. */
  skills: Skill[];
  /** MCP servers by name, sorted by name. */
  mcp: Record<string, McpServerConfig>;
  /** AGENTS.md text, global first. */
  instructions: InstructionBlock[];
}

/** The effective config for one agent. */
export interface ResolvedAgentConfig {
  name: string;
  role: AgentRole;
  harness: HarnessId;
  model?: string;
  avatar?: string;
  /** Global AGENTS.md, workspace AGENTS.md, then the agent's own instructions. */
  instructions: string;
  rules: Rule[];
  skills: Skill[];
}

export const DEFAULT_SETTINGS: Settings = {
  limits: { max_concurrent: 3, budget_minutes: { S: 30, M: 120 }, qa_max_failures: 2 },
  linear: {},
  slack: { channel: "#harnessd", summary_time: "21:00", time_zone: "Asia/Kolkata" },
  merge: {
    protected_paths: [
      // auth
      "**/auth/**",
      "**/auth.*",
      // payments
      "**/payments/**",
      "**/billing/**",
      // secrets
      "**/secrets/**",
      "**/*secret*",
      "**/.env",
      "**/.env.*",
      "**/*.pem",
      "**/*.key",
      // release config, and the CI workflows the gate trusts
      ".github/workflows/**",
      "docs/RELEASING.md",
      "**/.releaserc*",
      "**/release.config.*",
      // merge-gate config: the harnessd config holding [merge], code owners, branch rules
      ".harnessd/config.toml",
      "**/CODEOWNERS",
      ".github/settings.yml",
      ".github/rulesets/**",
    ],
    label: "needs-human",
    method: "squash",
  },
  qa: {
    setup_command: "pnpm install --frozen-lockfile --prefer-offline",
    test_command: "pnpm test",
  },
  daemon: { port: 4747 },
  harnesses: {},
};

/** The default team (D-010): every agent on Claude Code. */
export const DEFAULT_AGENTS: Record<string, { role: AgentRole; harness: HarnessId }> = {
  coordinator: { role: "coordinator", harness: "claude-code" },
  backend: { role: "backend", harness: "claude-code" },
  frontend: { role: "frontend", harness: "claude-code" },
  qa: { role: "qa", harness: "claude-code" },
};

/** A config problem, always naming the file and, when known, the key. */
export class ConfigError extends Error {
  readonly file: string;
  readonly key: string | undefined;

  constructor(file: string, key: string | undefined, detail: string) {
    super(key === undefined ? `${file}: ${detail}` : `${file}: ${key}: ${detail}`);
    this.name = "ConfigError";
    this.file = file;
    this.key = key;
  }
}

type Table = Record<string, unknown>;

function isTable(value: unknown): value is Table {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !isDate(value);
}

function isDate(value: unknown): boolean {
  return value instanceof Date;
}

function describe(value: unknown): string {
  if (Array.isArray(value)) return "an array";
  if (isDate(value)) return "a date";
  if (typeof value === "object" && value !== null) return "a table";
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

function keyPath(path: string, key: string): string {
  return path === "" ? key : `${path}.${key}`;
}

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

class Checker {
  readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  fail(key: string | undefined, detail: string): never {
    throw new ConfigError(this.file, key === "" ? undefined : key, detail);
  }

  table(value: unknown, path: string, allowed?: readonly string[]): Table {
    if (!isTable(value)) this.fail(path, `expected a table, got ${describe(value)}`);
    if (allowed) {
      for (const key of Object.keys(value)) {
        if (!allowed.includes(key)) {
          this.fail(keyPath(path, key), `unknown key, expected one of ${allowed.join(", ")}`);
        }
      }
    }
    return value;
  }

  /** A string that may be empty (an empty command means "skip"). */
  text(value: unknown, path: string): string {
    if (typeof value !== "string") this.fail(path, `expected a string, got ${describe(value)}`);
    return value;
  }

  string(value: unknown, path: string): string {
    if (typeof value !== "string") this.fail(path, `expected a string, got ${describe(value)}`);
    if (value.trim() === "") this.fail(path, "expected a non-empty string");
    return value;
  }

  /** "HH:MM", 24-hour. */
  clockTime(value: unknown, path: string): string {
    if (typeof value !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
      this.fail(path, `expected a 24-hour time "HH:MM", got ${describe(value)}`);
    }
    return value;
  }

  timeZone(value: unknown, path: string): string {
    if (typeof value !== "string" || !isTimeZone(value)) {
      this.fail(path, `expected an IANA time zone such as "Asia/Kolkata", got ${describe(value)}`);
    }
    return value;
  }

  bool(value: unknown, path: string): boolean {
    if (typeof value !== "boolean")
      this.fail(path, `expected true or false, got ${describe(value)}`);
    return value;
  }

  positiveInt(value: unknown, path: string): number {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
      this.fail(path, `expected an integer >= 1, got ${describe(value)}`);
    }
    return value;
  }

  oneOf<T extends string>(
    value: unknown,
    path: string,
    options: readonly T[],
    guard: (v: string) => v is T,
  ): T {
    if (typeof value !== "string" || !guard(value)) {
      this.fail(path, `expected one of ${options.join(", ")}, got ${describe(value)}`);
    }
    return value;
  }

  stringArray(value: unknown, path: string): string[] {
    if (!Array.isArray(value))
      this.fail(path, `expected an array of strings, got ${describe(value)}`);
    return value.map((item, i) => this.string(item, `${path}[${i}]`));
  }

  /** A TCP port: an integer from 0 to 65535. */
  port(value: unknown, path: string): number {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 65_535) {
      this.fail(path, `expected a port from 0 to 65535, got ${describe(value)}`);
    }
    return value;
  }

  /** A table of strings; empty strings are allowed (env values). */
  stringTable(value: unknown, path: string): Record<string, string> {
    const t = this.table(value, path);
    const out: Record<string, string> = {};
    for (const [key, item] of Object.entries(t)) {
      if (typeof item !== "string") {
        this.fail(keyPath(path, key), `expected a string, got ${describe(item)}`);
      }
      out[key] = item;
    }
    return out;
  }
}

/** Validates one `[mcp.<name>]` table. */
export function parseMcpServer(value: unknown, file: string, path: string): McpServerConfig {
  const c = new Checker(file);
  const t = c.table(value, path, ["command", "args", "env"]);
  if (t.command === undefined) c.fail(keyPath(path, "command"), "required");
  const out: McpServerConfig = { command: c.string(t.command, keyPath(path, "command")) };
  if (t.args !== undefined) out.args = c.stringArray(t.args, keyPath(path, "args"));
  if (t.env !== undefined) out.env = c.stringTable(t.env, keyPath(path, "env"));
  return out;
}

/**
 * Validates one agent definition. `path` is the key prefix in the file
 * (`agents.backend` in config.toml, empty for `agents/<name>.md` frontmatter).
 */
export function parseAgentSettings(
  value: unknown,
  file: string,
  path: string,
  allowInstructions = true,
): AgentSettings {
  const c = new Checker(file);
  const keys = allowInstructions
    ? ["role", "harness", "model", "avatar", "instructions"]
    : ["role", "harness", "model", "avatar"];
  const t = c.table(value, path, keys);
  const out: AgentSettings = {};
  if (t.role !== undefined)
    out.role = c.oneOf(t.role, keyPath(path, "role"), AGENT_ROLES, isAgentRole);
  if (t.harness !== undefined) {
    out.harness = c.oneOf(t.harness, keyPath(path, "harness"), HARNESSES, isHarnessId);
  }
  if (t.model !== undefined) out.model = c.string(t.model, keyPath(path, "model"));
  if (t.avatar !== undefined) out.avatar = c.string(t.avatar, keyPath(path, "avatar"));
  if (t.instructions !== undefined) {
    out.instructions = c.string(t.instructions, keyPath(path, "instructions"));
  }
  return out;
}

/** Validates a parsed config.toml. Unknown keys are errors, so typos never pass silently. */
export function parseConfigFile(value: unknown, file: string): ConfigFile {
  const c = new Checker(file);
  const root = c.table(value, "", [
    "limits",
    "linear",
    "slack",
    "merge",
    "qa",
    "daemon",
    "harnesses",
    "secrets",
    "agents",
    "mcp",
    "skills",
  ]);
  const out: ConfigFile = {};

  if (root.limits !== undefined) {
    const t = c.table(root.limits, "limits", [
      "max_concurrent",
      "budget_minutes",
      "qa_max_failures",
    ]);
    const limits: NonNullable<ConfigFile["limits"]> = {};
    if (t.max_concurrent !== undefined) {
      limits.max_concurrent = c.positiveInt(t.max_concurrent, "limits.max_concurrent");
    }
    if (t.budget_minutes !== undefined) {
      const b = c.table(t.budget_minutes, "limits.budget_minutes", BUDGET_SIZES);
      const budget: Partial<Record<BudgetSize, number>> = {};
      for (const size of BUDGET_SIZES) {
        if (b[size] !== undefined) {
          budget[size] = c.positiveInt(b[size], `limits.budget_minutes.${size}`);
        }
      }
      limits.budget_minutes = budget;
    }
    if (t.qa_max_failures !== undefined) {
      limits.qa_max_failures = c.positiveInt(t.qa_max_failures, "limits.qa_max_failures");
    }
    out.limits = limits;
  }

  if (root.linear !== undefined) {
    const t = c.table(root.linear, "linear", ["team_id", "project"]);
    const linear: LinearConfig = {};
    if (t.team_id !== undefined) linear.team_id = c.string(t.team_id, "linear.team_id");
    if (t.project !== undefined) linear.project = c.string(t.project, "linear.project");
    out.linear = linear;
  }

  if (root.slack !== undefined) {
    const t = c.table(root.slack, "slack", ["channel", "summary_time", "time_zone"]);
    const slack: Partial<SlackConfig> = {};
    if (t.channel !== undefined) slack.channel = c.string(t.channel, "slack.channel");
    if (t.summary_time !== undefined) {
      slack.summary_time = c.clockTime(t.summary_time, "slack.summary_time");
    }
    if (t.time_zone !== undefined) slack.time_zone = c.timeZone(t.time_zone, "slack.time_zone");
    out.slack = slack;
  }

  if (root.merge !== undefined) {
    const t = c.table(root.merge, "merge", ["protected_paths", "label", "method"]);
    const merge: Partial<MergeConfig> = {};
    if (t.protected_paths !== undefined) {
      merge.protected_paths = c.stringArray(t.protected_paths, "merge.protected_paths");
    }
    if (t.label !== undefined) merge.label = c.string(t.label, "merge.label");
    if (t.method !== undefined) {
      merge.method = c.oneOf(t.method, "merge.method", MERGE_METHODS, isMergeMethod);
    }
    out.merge = merge;
  }

  if (root.qa !== undefined) {
    const t = c.table(root.qa, "qa", ["setup_command", "test_command"]);
    const qa: Partial<QaConfig> = {};
    if (t.setup_command !== undefined)
      qa.setup_command = c.text(t.setup_command, "qa.setup_command");
    if (t.test_command !== undefined) qa.test_command = c.string(t.test_command, "qa.test_command");
    out.qa = qa;
  }

  if (root.daemon !== undefined) {
    const t = c.table(root.daemon, "daemon", ["port"]);
    out.daemon = t.port === undefined ? {} : { port: c.port(t.port, "daemon.port") };
  }

  if (root.harnesses !== undefined) {
    const t = c.table(root.harnesses, "harnesses", HARNESSES);
    const harnesses: Partial<Record<HarnessId, HarnessSettings>> = {};
    for (const id of HARNESSES) {
      if (t[id] === undefined) continue;
      const h = c.table(t[id], `harnesses.${id}`, ["bin"]);
      const entry: HarnessSettings = {};
      if (h.bin !== undefined) {
        const bin = c.string(h.bin, `harnesses.${id}.bin`);
        if (!bin.startsWith("/")) c.fail(`harnesses.${id}.bin`, "expected an absolute path");
        entry.bin = bin;
      }
      harnesses[id] = entry;
    }
    out.harnesses = harnesses;
  }

  if (root.secrets !== undefined) {
    const t = c.table(root.secrets, "secrets", Object.keys(SECRET_KEYS));
    const secrets: SecretReferences = {};
    for (const service of ["linear", "slack"] as const) {
      if (t[service] === undefined) continue;
      const keys = SECRET_KEYS[service];
      const s = c.table(t[service], `secrets.${service}`, keys);
      const entry: Record<string, string> = {};
      for (const key of keys) {
        const value = s[key];
        if (value === undefined) continue;
        // The error never repeats the value: it may be a secret pasted in by mistake.
        if (typeof value === "string" && isSecretReference(value)) {
          entry[key] = value;
        } else {
          c.fail(
            `secrets.${service}.${key}`,
            'expected a reference such as "op://vault/item/field" or "env:NAME"; save a value in Settings, Connections',
          );
        }
      }
      secrets[service] = entry;
    }
    out.secrets = secrets;
  }

  if (root.agents !== undefined) {
    const t = c.table(root.agents, "agents");
    const agents: Record<string, AgentSettings> = {};
    for (const [name, def] of Object.entries(t)) {
      agents[name] = parseAgentSettings(def, file, `agents.${name}`);
    }
    out.agents = agents;
  }

  if (root.mcp !== undefined) {
    const t = c.table(root.mcp, "mcp");
    const mcp: Record<string, McpServerConfig> = {};
    for (const [name, def] of Object.entries(t)) {
      if (!MCP_NAME.test(name)) {
        c.fail(`mcp.${name}`, "server names may only use letters, digits, _ and -");
      }
      mcp[name] = parseMcpServer(def, file, `mcp.${name}`);
    }
    out.mcp = mcp;
  }

  if (root.skills !== undefined) {
    const t = c.table(root.skills, "skills");
    const skills: Record<string, SkillSettings> = {};
    for (const [name, def] of Object.entries(t)) {
      const path = `skills.${name}`;
      const s = c.table(def, path, ["enabled", "upstream", "commit", "version"]);
      const entry: SkillSettings = {};
      if (s.enabled !== undefined) entry.enabled = c.bool(s.enabled, `${path}.enabled`);
      for (const key of ["upstream", "commit", "version"] as const) {
        if (s[key] !== undefined) entry[key] = c.string(s[key], `${path}.${key}`);
      }
      skills[name] = entry;
    }
    out.skills = skills;
  }

  return out;
}
