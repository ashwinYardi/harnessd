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
  type McpServerConfig,
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
 * Scalars override, tables deep-merge, rules, skills and MCP servers merge by
 * name with the later layer winning (a server is replaced whole, not deep-merged),
 * and instruction text accumulates in layer order.
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
      if (entry.fallback_harness !== undefined) draft.fallback_harness = entry.fallback_harness;
      if (entry.fallback_model !== undefined) draft.fallback_model = entry.fallback_model;
      if (entry.avatar !== undefined) draft.avatar = entry.avatar;
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

  const mcpByName = new Map<string, McpServerConfig>();
  for (const layer of layers) {
    for (const [name, server] of Object.entries(layer.mcp)) mcpByName.set(name, server);
  }
  const mcp = Object.fromEntries([...mcpByName].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

  return {
    ...settings,
    agents,
    mcp,
    rules: byName<Rule>(layers.map((l) => l.rules)),
    skills: enabledSkills(layers),
    instructions: layers
      .map((l) => l.instructions)
      .filter((b): b is InstructionBlock => b !== undefined),
  };
}

/**
 * Skills merged by name, minus those turned off. Each layer's `[skills.<name>] enabled`
 * applies to the skills merged so far, so a workspace can turn off a global skill.
 */
function enabledSkills(layers: readonly ConfigLayer[]): Skill[] {
  const map = new Map<string, Skill>();
  const off = new Set<string>();
  for (const layer of layers) {
    for (const skill of layer.skills) map.set(skill.name, skill);
    for (const [name, s] of Object.entries(layer.skillSettings)) {
      if (s.enabled === false) off.add(name);
      else if (s.enabled === true) off.delete(name);
    }
  }
  return byName<Skill>([[...map.values()].filter((s) => !off.has(s.name))]);
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
  if (agent.fallback_harness !== undefined) resolved.fallback_harness = agent.fallback_harness;
  if (agent.fallback_model !== undefined) resolved.fallback_model = agent.fallback_model;
  if (agent.avatar !== undefined) resolved.avatar = agent.avatar;
  return resolved;
}
