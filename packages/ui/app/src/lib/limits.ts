// Harness holds (MET-70): a harness that hit its usage limit gets no dispatch until its
// reset time. GET /api/loop and the event stream carry them as `limits`. The app shows each
// one as a quiet status, "Claude Code limited until 18:37", in the header and on agent rows.
import type { AgentView, HarnessId } from "@harnessd/shared";
import type { HarnessLimit, LoopState } from "./route.ts";

export type { HarnessLimit };

const NAMES: Record<HarnessId, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  antigravity: "Antigravity",
  opencode: "OpenCode",
  cursor: "Cursor",
  grok: "Grok",
};

const pad = (n: number) => String(n).padStart(2, "0");

/** The words of a hold, kept apart so a narrow header can drop the name next to its logo. */
export interface LimitParts {
  /** "Claude Code limited " */
  name: string;
  /** "until 18:37", in local time. */
  until: string;
  /** " (backoff)" when the harness gave no reset time, else "". */
  backoff: string;
}

export function limitParts(limit: HarnessLimit): LimitParts {
  const d = new Date(limit.until);
  return {
    name: `${NAMES[limit.harness]} limited `,
    until: `until ${pad(d.getHours())}:${pad(d.getMinutes())}`,
    backoff: limit.backoff ? " (backoff)" : "",
  };
}

/** "Claude Code limited until 18:37", plus " (backoff)" with no reset time. */
export function limitText(limit: HarnessLimit): string {
  const p = limitParts(limit);
  return p.name + p.until + p.backoff;
}

/**
 * The holds still in force, in the daemon's order. A hold leaves at its reset time on the
 * shared clock, so the text goes once, before the daemon drops the hold on its next tick.
 */
export function activeLimits(
  limits: readonly HarnessLimit[] | undefined,
  now: Date,
): HarnessLimit[] {
  return (limits ?? []).filter((l) => Date.parse(l.until) > now.getTime());
}

/**
 * The hold an agent row shows, from the holds in force. An agent that runs while its
 * harness is held runs on its fallback harness (MET-81), so that row shows nothing extra.
 */
export function agentLimit(
  agent: Pick<AgentView, "harness" | "runs">,
  holds: readonly HarnessLimit[],
): HarnessLimit | undefined {
  if (agent.runs.length > 0) return undefined;
  return holds.find((l) => l.harness === agent.harness);
}

/**
 * Apply a live update to the loop state. An update with only `limits` waits for the first
 * GET /api/loop, which carries the limits too, so it never stands in for the setup state
 * that opens Settings (MET-28).
 */
export function mergeLoop(
  prev: LoopState | undefined,
  next: Partial<LoopState>,
): LoopState | undefined {
  if (prev) return { ...prev, ...next };
  if (next.state && next.blocking) return { ...next, state: next.state, blocking: next.blocking };
  return undefined;
}
