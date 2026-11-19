import {
  AGENT_ROLES,
  type Agent,
  type AgentRole,
  ConfigError,
  type ConfigLayer,
  DEFAULT_AGENTS,
  DEFAULT_SETTINGS,
  type DeepPartial,
  type InstructionBlock,
  type MergedConfig,
  type ResolvedAgentConfig,
  type Rule,
  type Settings,
  type Skill,
} from "@harnessd/shared";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Tables deep-merge; scalars and arrays from `over` replace `base`. */
export function deepMerge<T>(base: T, over: DeepPartial<T> | undefined): T {
  if (over === undefined) return base;
  if (!isPlainObject(base) || !isPlainObject(over)) return over as T;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) {
    if (value !== undefined) out[key] = deepMerge(base[key], value);
  }
  return out as T;
}

function byName<T extends { name: string }>(lists: T[][]): T[] {
  const map = new Map<string, T>();
  for (const list of lists) for (const item of list) map.set(item.name, item);
  return [...map.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

interface AgentDraft extends Omit<Agent, "role"> {
  role?: AgentRole;
  label?: string;
  keyPrefix?: string;
}

/**
 * Merges layers in order (global, then workspace) over the defaults.
 * Scalars override, tables deep-merge, rules and skills merge by name with the
 * later layer winning, and instruction text accumulates in layer order.
 */
export function mergeLayers(layers: readonly ConfigLayer[]): MergedConfig {
  let settings: Settings = structuredClone(DEFAULT_SETTINGS);
  for (const layer of layers) settings = deepMerge<Settings>(settings, layer.settings);

  const drafts = new Map<string, AgentDraft>();
  for (const [name, def] of Object.entries(DEFAULT_AGENTS)) {
    drafts.set(name, { name, ...def, instructions: [] });
  }
  for (const layer of layers) {
    for (const [name, entry] of Object.entries(layer.agents)) {
      let draft = drafts.get(name);
      if (draft === undefined) {
        draft = { name, harness: "claude-code", instructions: [] };
        drafts.set(name, draft);
      }
      if (entry.role !== undefined) draft.role = entry.role;
      if (entry.harness !== undefined) draft.harness = entry.harness;
      if (entry.model !== undefined) draft.model = entry.model;
      if (entry.instructions !== undefined) draft.instructions.push(entry.instructions);
      draft.label ??= entry.label;
      draft.keyPrefix ??= entry.keyPrefix;
    }
  }

  const agents: Record<string, Agent> = {};
  for (const { label, keyPrefix, role, ...rest } of drafts.values()) {
    if (role === undefined) {
      const key = keyPrefix ? `${keyPrefix}.role` : "role";
      throw new ConfigError(
        label ?? rest.name,
        key,
        `required for agents other than the defaults, expected one of ${AGENT_ROLES.join(", ")}`,
      );
    }
    agents[rest.name] = { ...rest, role };
  }

  return {
    ...settings,
    agents,
    rules: byName<Rule>(layers.map((l) => l.rules)),
    skills: byName<Skill>(layers.map((l) => l.skills)),
    instructions: layers
      .map((l) => l.instructions)
      .filter((b): b is InstructionBlock => b !== undefined),
  };
}

/** The effective config for one agent: global → workspace → agent. */
export function resolveAgentConfig(merged: MergedConfig, agentName: string): ResolvedAgentConfig {
  const agent = merged.agents[agentName];
  if (agent === undefined) {
    const known = Object.keys(merged.agents).join(", ");
    throw new Error(`unknown agent "${agentName}", expected one of ${known}`);
  }
  const resolved: ResolvedAgentConfig = {
    name: agent.name,
    role: agent.role,
    harness: agent.harness,
    instructions: [...merged.instructions, ...agent.instructions]
      .map((b) => b.text.trim())
      .filter((t) => t !== "")
      .join("\n\n"),
    rules: merged.rules,
    skills: merged.skills,
  };
  if (agent.model !== undefined) resolved.model = agent.model;
  return resolved;
}
