// Harness holds (MET-70): a harness that hit its usage limit gets no dispatch until its
// reset time. GET /api/loop and the event stream carry them as `limits`. The app shows each
// one as a quiet status, "Claude Code limited until 18:37", in the header and on agent rows.
import type { AgentView, HarnessId } from "@harnessd/shared";
import type { LoopState } from "./route.ts";

/** One held harness, as the daemon sends it. `backoff` is true when no reset time was given. */
export interface HarnessLimit {
  harness: HarnessId;
  /** ISO time the hold ends. */
  until: string;
  backoff: boolean;
}

const NAMES: Record<HarnessId, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  antigravity: "Antigravity",
  opencode: "OpenCode",
  cursor: "Cursor",
  grok: "Grok",
};

/** The display name of a harness, such as "Claude Code". */
export function harnessName(id: HarnessId): string {
  return NAMES[id] ?? id;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** The reset time, "18:37", in local time. */
export function limitClock(limit: HarnessLimit): string {
  const d = new Date(limit.until);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "Claude Code limited until 18:37", plus " (backoff)" when no reset time was given. */
export function limitText(limit: HarnessLimit): string {
  const backoff = limit.backoff ? " (backoff)" : "";
  return `${harnessName(limit.harness)} limited until ${limitClock(limit)}${backoff}`;
}

/**
 * The holds still in force. A hold leaves at its reset time on the shared clock, so the
 * text goes once, before the daemon drops the hold on its next tick.
 */
export function activeLimits(
  limits: readonly HarnessLimit[] | undefined,
  now: Date,
): HarnessLimit[] {
  return (limits ?? []).filter((l) => Date.parse(l.until) > now.getTime());
}

/** The header's entries: one text per held harness, in the daemon's order. */
export function holdTexts(limits: readonly HarnessLimit[] | undefined, now: Date): string[] {
  return activeLimits(limits, now).map(limitText);
}

/**
 * The hold an agent row shows. An agent that runs while its harness is held runs on its
 * fallback harness (MET-81), so that row shows nothing extra.
 */
export function agentLimit(
  agent: Pick<AgentView, "harness" | "runs">,
  limits: readonly HarnessLimit[] | undefined,
  now: Date,
): HarnessLimit | undefined {
  if (agent.runs.length > 0) return undefined;
  return activeLimits(limits, now).find((l) => l.harness === agent.harness);
}

/**
 * Apply a live update to the loop state. An update with only `limits` waits for the first
 * GET /api/loop, so it never stands in for the setup state that opens Settings (MET-28).
 */
export function mergeLoop(
  prev: LoopState | undefined,
  next: Partial<LoopState>,
): LoopState | undefined {
  if (prev) return { ...prev, ...next };
  if (next.state && next.blocking) return { ...next, state: next.state, blocking: next.blocking };
  return undefined;
}
