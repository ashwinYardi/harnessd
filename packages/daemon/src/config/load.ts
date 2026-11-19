import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import {
  type AgentLayerEntry,
  ConfigError,
  type ConfigLayer,
  type ConfigScope,
  type MergedConfig,
  parseAgentSettings,
  parseConfigFile,
  type Rule,
  type Skill,
} from "@harnessd/shared";
import { parse, TomlError } from "smol-toml";
import { parseFrontmatter } from "./frontmatter.ts";
import { mergeLayers } from "./merge.ts";

export interface LoadConfigOptions {
  /** The global folder, usually `~/.harnessd` (see `defaultGlobalDir`). */
  globalDir: string;
  /** The workspace folder, `<repo>/.harnessd`. Omit outside a repo. */
  workspaceDir?: string;
  /** Only used to print paths under it as `~/...` in errors. Defaults to os.homedir(). */
  home?: string;
}

/**
 * The global folder: `$HARNESSD_HOME` when set, else `~/.harnessd`.
 * Call this at the edge (CLI, daemon start), never inside the loader.
 */
export function defaultGlobalDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.HARNESSD_HOME?.trim();
  return override ? resolve(override) : join(homedir(), ".harnessd");
}

/** Loads the global and workspace folders and merges them. Missing folders and files are fine. */
export async function loadConfig(options: LoadConfigOptions): Promise<MergedConfig> {
  const home = options.home ?? homedir();
  const layers = [await loadLayer(options.globalDir, "global", home)];
  if (options.workspaceDir !== undefined) {
    layers.push(await loadLayer(options.workspaceDir, "workspace", home));
  }
  return mergeLayers(layers);
}

function displayPath(path: string, home: string): string {
  if (home !== "" && (path === home || path.startsWith(home + sep))) {
    return `~${path.slice(home.length)}`;
  }
  return path;
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}

async function listOptional(path: string): Promise<Dirent[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries
      .filter((e) => !e.name.startsWith("."))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw e;
  }
}

function parseToml(text: string, label: string): unknown {
  try {
    return parse(text);
  } catch (e) {
    if (e instanceof TomlError) {
      const reason = (e.message.split("\n")[0] ?? "").replace(/^Invalid TOML document: /, "");
      throw new ConfigError(
        label,
        undefined,
        `invalid TOML at line ${e.line}, column ${e.column}: ${reason}`,
      );
    }
    throw e;
  }
}

/** Loads one `.harnessd/` folder. See docs/CONFIG.md for the layout. */
export async function loadLayer(
  dir: string,
  scope: ConfigScope,
  home = homedir(),
): Promise<ConfigLayer> {
  const show = (path: string) => displayPath(path, home);
  const layer: ConfigLayer = {
    scope,
    dir,
    settings: {},
    agents: {},
    rules: [],
    skills: [],
    mcp: {},
  };

  // config.toml
  const configPath = join(dir, "config.toml");
  const configText = await readOptional(configPath);
  if (configText !== undefined) {
    const label = show(configPath);
    const { agents, mcp, ...settings } = parseConfigFile(parseToml(configText, label), label);
    layer.settings = settings;
    layer.mcp = mcp ?? {};
    for (const [name, def] of Object.entries(agents ?? {})) {
      const { instructions, ...rest } = def;
      const entry: AgentLayerEntry = { ...rest, label, keyPrefix: `agents.${name}` };
      if (instructions !== undefined) {
        entry.instructions = { source: configPath, text: instructions.trim() };
      }
      layer.agents[name] = entry;
    }
  }

  // agents/<name>.md: frontmatter (role, harness, model) plus instructions as the body
  for (const ent of await listOptional(join(dir, "agents"))) {
    const path = join(dir, "agents", ent.name);
    const label = show(path);
    if (!ent.isFile() || !ent.name.endsWith(".md")) {
      throw new ConfigError(label, undefined, "expected agents/<name>.md files only");
    }
    const name = ent.name.slice(0, -".md".length);
    const { data, body } = parseFrontmatter(await readFile(path, "utf8"), label);
    const def = parseAgentSettings(data, label, "", false);
    const text = body.trim();
    const existing = layer.agents[name];
    const entry: AgentLayerEntry = existing ?? { label, keyPrefix: "" };
    for (const key of ["role", "harness", "model"] as const) {
      if (def[key] === undefined) continue;
      if (existing?.[key] !== undefined) {
        throw new ConfigError(label, key, `also set as agents.${name}.${key} in ${existing.label}`);
      }
    }
    if (text !== "" && existing?.instructions !== undefined) {
      throw new ConfigError(
        label,
        undefined,
        `instructions are also set as agents.${name}.instructions in ${existing.label}`,
      );
    }
    Object.assign(entry, def);
    if (text !== "") entry.instructions = { source: path, text };
    layer.agents[name] = entry;
  }

  // rules/*.md
  for (const ent of await listOptional(join(dir, "rules"))) {
    if (!ent.isFile() || !ent.name.endsWith(".md")) continue;
    const path = join(dir, "rules", ent.name);
    const rule: Rule = {
      name: ent.name.slice(0, -".md".length),
      source: path,
      text: await readFile(path, "utf8"),
    };
    layer.rules.push(rule);
  }

  // skills/<folder>/SKILL.md
  const seen = new Map<string, string>();
  for (const ent of await listOptional(join(dir, "skills"))) {
    if (!ent.isDirectory()) continue;
    const skillDir = join(dir, "skills", ent.name);
    const path = join(skillDir, "SKILL.md");
    const label = show(path);
    const text = await readOptional(path);
    if (text === undefined) throw new ConfigError(label, undefined, "missing SKILL.md");
    const { data, body } = parseFrontmatter(text, label);
    const name = data.name?.trim() || ent.name;
    const clash = seen.get(name);
    if (clash !== undefined) {
      throw new ConfigError(label, "name", `skill "${name}" is also defined in ${clash}`);
    }
    seen.set(name, label);
    const skill: Skill = { name, dir: skillDir, source: path, body: body.trim() };
    const description = data.description?.trim();
    if (description) skill.description = description;
    layer.skills.push(skill);
  }

  // AGENTS.md
  const agentsMdPath = join(dir, "AGENTS.md");
  const agentsMd = (await readOptional(agentsMdPath))?.trim();
  if (agentsMd) layer.instructions = { source: agentsMdPath, text: agentsMd };

  return layer;
}
