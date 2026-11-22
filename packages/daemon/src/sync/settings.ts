// Merges what sync owns into a harness settings file that the user may also edit:
// `.claude/settings.json`, `.codex/hooks.json` and `opencode.json`. Sync replaces its top-level keys,
// such as OpenCode permission and websearch, and preserves user-owned settings. See docs/SYNC.md "Hooks and subagents".
import type { HookEvents, HookGroup } from "@harnessd/shared";
import { jsonFile } from "./format.ts";

/** The part of a settings file that sync owns. */
export interface NativeSettings {
  /** Top-level keys sync sets. A key that exists keeps its place. */
  keys: Record<string, unknown>;
  /** Hook groups sync adds to `hooks`; {} adds no `hooks` key. */
  hooks: HookEvents;
  /**
   * Named entries sync owns inside a top-level object, such as `{ mcp: { name: {...} } }`.
   * Each entry replaces the one of the same name; every other entry stays.
   */
  entries?: Record<string, Record<string, unknown>>;
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function refuse(path: string, why: string): never {
  throw new Error(`harnessd sync: ${path} ${why}. Fix it or delete it, then run sync again.`);
}

/** True when `group` is the same group as `ours`: same matcher and a shared command. */
function sameGroup(group: unknown, ours: HookGroup): boolean {
  if (!isObject(group) || group.matcher !== ours.matcher || !Array.isArray(group.hooks)) {
    return false;
  }
  return group.hooks.some(
    (hook) => isObject(hook) && ours.hooks.some((h) => h.command === hook.command),
  );
}

/**
 * Adds each of `ours` to `existing`. A group that is the same group (same matcher, a
 * shared command) is replaced in place; any other group is appended. The rest stays.
 */
export function mergeHooks(existing: unknown, ours: HookEvents, path: string): Json {
  if (existing !== undefined && !isObject(existing))
    refuse(path, 'has a "hooks" that is not an object');
  const out: Json = { ...(existing ?? {}) };
  for (const [event, groups] of Object.entries(ours)) {
    const current = out[event];
    if (current !== undefined && !Array.isArray(current)) {
      refuse(path, `has a "hooks.${event}" that is not an array`);
    }
    const next: unknown[] = [...(current ?? [])];
    for (const group of groups) {
      const at = next.findIndex((g) => sameGroup(g, group));
      if (at === -1) next.push(group);
      else next[at] = group;
    }
    out[event] = next;
  }
  return out;
}

/** The new text of a settings file: `existing` (undefined when absent) with `ours` merged in. */
export function mergeSettings(
  existing: string | undefined,
  ours: NativeSettings,
  path: string,
): string {
  let base: Json = {};
  if (existing !== undefined) {
    let data: unknown;
    try {
      data = JSON.parse(existing);
    } catch {
      refuse(path, "is not valid JSON");
    }
    if (!isObject(data)) refuse(path, "is not a JSON object");
    base = data;
  }
  const out: Json = { ...base, ...ours.keys };
  if (Object.keys(ours.hooks).length > 0) out.hooks = mergeHooks(base.hooks, ours.hooks, path);
  for (const [key, entries] of Object.entries(ours.entries ?? {})) {
    const current = base[key];
    if (current !== undefined && !isObject(current)) {
      refuse(path, `has a "${key}" that is not an object`);
    }
    out[key] = { ...(current ?? {}), ...entries };
  }
  return jsonFile(out);
}

/**
 * The events of `ours` whose groups a settings file lacks. Unreadable text lacks them all.
 * The doctor uses this to find a hook that sync has not written yet.
 */
export function missingHookEvents(text: string | undefined, ours: HookEvents): string[] {
  let hooks: unknown;
  try {
    hooks = text === undefined ? undefined : (JSON.parse(text) as Json).hooks;
  } catch {
    hooks = undefined;
  }
  return Object.entries(ours)
    .filter(([event, groups]) => {
      const current = isObject(hooks) ? hooks[event] : undefined;
      return groups.some((g) => !Array.isArray(current) || !current.some((c) => sameGroup(c, g)));
    })
    .map(([event]) => event);
}
