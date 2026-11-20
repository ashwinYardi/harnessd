/** Version of the harnessd packages, kept in step across the monorepo. */
export const VERSION = "0.0.0";

/** Harness CLIs harnessd can drive (D-002). v0.1 ships Claude Code; the rest follow. */
export const HARNESSES = [
  "claude-code",
  "codex",
  "antigravity",
  "opencode",
  "cursor",
  "grok",
] as const;

export type HarnessId = (typeof HARNESSES)[number];

export function isHarnessId(value: string): value is HarnessId {
  return (HARNESSES as readonly string[]).includes(value);
}

export * from "./adapter.ts";
export * from "./config.ts";
export * from "./coordinator.ts";
export * from "./linear.ts";
export * from "./team.ts";
export * from "./ui.ts";
