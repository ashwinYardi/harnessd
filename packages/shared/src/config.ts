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

export interface SlackConfig {
  channel: string;
}

export interface MergeConfig {
  /** Globs; a PR touching any of them waits for a human (D-013). */
  protected_paths: string[];
}

/** One `[agents.<name>]` table in config.toml. */
export interface AgentSettings {
  role?: AgentRole;
  harness?: HarnessId;
  model?: string;
  instructions?: string;
}

/** Fully defaulted settings, the part of config.toml other than agents. */
export interface Settings {
  limits: LimitsConfig;
  linear: LinearConfig;
  slack: SlackConfig;
  merge: MergeConfig;
}

export type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

/** A validated config.toml. Everything is optional; defaults fill the gaps. */
export interface ConfigFile extends DeepPartial<Settings> {
  agents?: Record<string, AgentSettings>;
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

/** `skills/<folder>/SKILL.md`. The name is the frontmatter `name`, else the folder name. */
export interface Skill {
  name: string;
  description?: string;
  /** The skill folder. */
  dir: string;
  /** The SKILL.md file. */
  source: string;
  body: string;
}

/** One agent as defined by a single layer (config.toml table plus `agents/<name>.md`). */
export interface AgentLayerEntry {
  role?: AgentRole;
  harness?: HarnessId;
  model?: string;
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
  /** The folder's AGENTS.md, if present and non-empty. */
  instructions?: InstructionBlock;
}

/** An agent after merging every layer. */
export interface Agent {
  name: string;
  role: AgentRole;
  harness: HarnessId;
  model?: string;
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
  /** AGENTS.md text, global first. */
  instructions: InstructionBlock[];
}

/** The effective config for one agent. */
export interface ResolvedAgentConfig {
  name: string;
  role: AgentRole;
  harness: HarnessId;
  model?: string;
  /** Global AGENTS.md, workspace AGENTS.md, then the agent's own instructions. */
  instructions: string;
  rules: Rule[];
  skills: Skill[];
}

export const DEFAULT_SETTINGS: Settings = {
  limits: { max_concurrent: 3, budget_minutes: { S: 30, M: 120 }, qa_max_failures: 2 },
  linear: {},
  slack: { channel: "#harnessd" },
  merge: {
    protected_paths: [
      // auth, payments, secrets
      "**/auth/**",
      "**/payments/**",
      "**/secrets/**",
      "**/.env",
      "**/.env.*",
      "**/*.pem",
      "**/*.key",
      // release config and CI, which the merge gate trusts
      ".github/workflows/**",
      // merge-gate config
      ".harnessd/config.toml",
    ],
  },
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

  string(value: unknown, path: string): string {
    if (typeof value !== "string") this.fail(path, `expected a string, got ${describe(value)}`);
    if (value.trim() === "") this.fail(path, "expected a non-empty string");
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
    ? ["role", "harness", "model", "instructions"]
    : ["role", "harness", "model"];
  const t = c.table(value, path, keys);
  const out: AgentSettings = {};
  if (t.role !== undefined)
    out.role = c.oneOf(t.role, keyPath(path, "role"), AGENT_ROLES, isAgentRole);
  if (t.harness !== undefined) {
    out.harness = c.oneOf(t.harness, keyPath(path, "harness"), HARNESSES, isHarnessId);
  }
  if (t.model !== undefined) out.model = c.string(t.model, keyPath(path, "model"));
  if (t.instructions !== undefined) {
    out.instructions = c.string(t.instructions, keyPath(path, "instructions"));
  }
  return out;
}

/** Validates a parsed config.toml. Unknown keys are errors, so typos never pass silently. */
export function parseConfigFile(value: unknown, file: string): ConfigFile {
  const c = new Checker(file);
  const root = c.table(value, "", ["limits", "linear", "slack", "merge", "agents"]);
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
    const t = c.table(root.slack, "slack", ["channel"]);
    out.slack = t.channel === undefined ? {} : { channel: c.string(t.channel, "slack.channel") };
  }

  if (root.merge !== undefined) {
    const t = c.table(root.merge, "merge", ["protected_paths"]);
    out.merge =
      t.protected_paths === undefined
        ? {}
        : { protected_paths: c.stringArray(t.protected_paths, "merge.protected_paths") };
  }

  if (root.agents !== undefined) {
    const t = c.table(root.agents, "agents");
    const agents: Record<string, AgentSettings> = {};
    for (const [name, def] of Object.entries(t)) {
      agents[name] = parseAgentSettings(def, file, `agents.${name}`);
    }
    out.agents = agents;
  }

  return out;
}
