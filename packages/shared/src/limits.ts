// The words for a harness usage limit (MET-70) and the weighted token budget (D-043).
// The loop log, the daily summary and the app use these, so the text matches everywhere.
import type { HarnessId } from "./index.ts";
import type { TokenSum } from "./ui.ts";

/** Tokens one run or parent used by kind, weighted for the budget (D-043). */
export function weightedTokens(sum: TokenSum, weight: number): number {
  return sum.input + sum.output + Math.round(sum.cached * weight);
}

const HARNESS_NAMES: Record<HarnessId, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  antigravity: "Antigravity",
  opencode: "OpenCode",
  cursor: "Cursor",
  grok: "Grok",
};

/** The display name of a harness, such as "Claude Code". */
export function harnessName(id: HarnessId): string {
  return HARNESS_NAMES[id];
}

/** HH:MM in the local time of the process that formats it. */
function localClock(time: Date | string): string {
  const at = typeof time === "string" ? new Date(time) : time;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** "Claude Code limited until 18:37", with " (backoff)" when the harness gave no reset time. */
export function limitHoldLine(id: HarnessId, until: Date | string, backoff = false): string {
  return `${harnessName(id)} limited until ${localClock(until)}${backoff ? " (backoff)" : ""}`;
}

/** "Claude Code available again". */
export function limitAvailableLine(id: HarnessId): string {
  return `${harnessName(id)} available again`;
}

/**
 * A harness hold in force, as GET /api/loop and the agents event show it (MET-82).
 * `backoff` is true when the harness gave no reset time and `until` is a backoff guess.
 */
export interface HarnessLimit {
  harness: HarnessId;
  /** ISO time the hold ends. */
  until: string;
  backoff: boolean;
}
