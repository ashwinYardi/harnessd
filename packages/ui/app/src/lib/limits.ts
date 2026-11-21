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

type Stamped = { [K in keyof LoopState]?: { seq: number; value: LoopState[K] } };

/**
 * The loop state, plus each live field with the stream sequence it arrived at. A read
 * (GET /api/loop or POST /api/start) and the event stream can land in any order, so a field
 * pushed after a read left beats that read's older copy (MET-70: a hold from the agents
 * stream must not be lost to a slower first read).
 */
export interface LoopStore {
  loop: LoopState | undefined;
  live: Stamped;
}

export const emptyLoop: LoopStore = { loop: undefined, live: {} };

/**
 * Apply a live update, stamped with its stream sequence. An update with only `limits`
 * before the first read never stands in for the setup state that opens Settings (MET-28);
 * the read applies it when it lands.
 */
export function applyLiveLoop(store: LoopStore, next: Partial<LoopState>, seq: number): LoopStore {
  const live: Stamped = { ...store.live };
  for (const key of Object.keys(next) as (keyof LoopState)[]) {
    Object.assign(live, { [key]: { seq, value: next[key] } });
  }
  const { loop } = store;
  if (loop) return { loop: { ...loop, ...next }, live };
  if (next.state && next.blocking) {
    return { loop: { ...next, state: next.state, blocking: next.blocking }, live };
  }
  return { loop: undefined, live };
}

/** Apply a read that left at stream sequence `sentAt`. Live fields pushed after it win. */
export function applyLoopRead(store: LoopStore, read: LoopState, sentAt: number): LoopStore {
  const loop: LoopState = { ...read };
  for (const [key, field] of Object.entries(store.live)) {
    if (field && field.seq > sentAt) Object.assign(loop, { [key]: field.value });
  }
  return { loop, live: store.live };
}
