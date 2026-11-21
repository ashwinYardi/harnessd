// The hold on a harness that hit a usage limit (MET-70, docs/LOOP.md "Usage limits").
// Pure: the loop owns the state, the clock and the log.
import type { HarnessId, ResolvedAgentConfig } from "@harnessd/shared";
import type { HarnessHold } from "./state.ts";

/** The wait after the first limited run that gave no reset time. */
export const FIRST_BACKOFF_MS = 15 * 60_000;
/** The longest backoff wait. */
export const MAX_BACKOFF_MS = 2 * 60 * 60_000;

/** True while no run may start on the harness. */
export function isHeld(hold: HarnessHold | undefined, now: Date): boolean {
  return hold !== undefined && hold.endedAt === undefined && Date.parse(hold.until) > now.getTime();
}

/**
 * The hold after a limited run. A reset time in the future is the end. Without one, a
 * new hold waits the backoff: 15 minutes, doubled after each hold that ended, at most
 * 2 hours. More limited runs during an active hold do not double it.
 */
export function afterLimited(
  prev: HarnessHold | undefined,
  resetAt: string | undefined,
  now: Date,
): HarnessHold {
  const active = isHeld(prev, now);
  const since = active && prev ? prev.since : now.toISOString();
  const reset = resetAt === undefined ? Number.NaN : Date.parse(resetAt);
  if (reset > now.getTime()) {
    const hold: HarnessHold = { until: new Date(reset).toISOString(), since };
    if (prev?.backoffMs !== undefined) hold.backoffMs = prev.backoffMs;
    return hold;
  }
  if (active && prev) return prev;
  const backoffMs =
    prev?.backoffMs === undefined ? FIRST_BACKOFF_MS : Math.min(prev.backoffMs * 2, MAX_BACKOFF_MS);
  return { until: new Date(now.getTime() + backoffMs).toISOString(), since, backoffMs };
}

/** The hold after an ok run on the harness: the backoff is cleared. */
export function afterOk(prev: HarnessHold | undefined): HarnessHold | undefined {
  if (prev === undefined || prev.endedAt !== undefined) return undefined;
  return { until: prev.until, since: prev.since };
}

/**
 * Ends a hold whose time has come. `ended` is true once, on the call that ends it.
 * A hold with a backoff is kept, marked ended, so the next limit doubles the wait.
 */
export function releaseExpired(
  hold: HarnessHold | undefined,
  now: Date,
): { hold: HarnessHold | undefined; ended: boolean } {
  if (hold === undefined || hold.endedAt !== undefined || isHeld(hold, now)) {
    return { hold, ended: false };
  }
  if (hold.backoffMs === undefined) return { hold: undefined, ended: true };
  return { hold: { ...hold, endedAt: now.toISOString() }, ended: true };
}

/**
 * The agent config a run uses now (MET-81). It is the agent itself while its harness is
 * free. While a limit holds that harness, it is the agent on its fallback harness and
 * model, if the fallback is set, has an adapter and is not held. Undefined otherwise:
 * the run waits.
 */
export function harnessForRun(
  agent: ResolvedAgentConfig,
  held: (harness: HarnessId) => boolean,
  hasAdapter: (harness: HarnessId) => boolean,
): ResolvedAgentConfig | undefined {
  if (!held(agent.harness)) return agent;
  const fallback = agent.fallback_harness;
  if (fallback === undefined || fallback === agent.harness) return undefined;
  if (!hasAdapter(fallback) || held(fallback)) return undefined;
  const { model: _model, fallback_harness: _h, fallback_model, ...rest } = agent;
  const onFallback: ResolvedAgentConfig = { ...rest, harness: fallback };
  if (fallback_model !== undefined) onFallback.model = fallback_model;
  return onFallback;
}
