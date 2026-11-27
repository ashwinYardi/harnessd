// The hold on a harness that hit a usage limit (MET-70, docs/LOOP.md "Usage limits").
// Pure: the loop owns the state, the clock and the log.
import type {
  AgentRole,
  HarnessId,
  HarnessLimit,
  ResolvedAgentConfig,
  RunResult,
} from "@harnessd/shared";
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

/**
 * The hold after an ok run on the harness. An active hold stays as it is: the run started
 * before the limit, so it says nothing about the reset. After the hold, the backoff is
 * cleared. A hold that expired but was not released yet loses only its backoff, so its
 * release still reports the end.
 */
export function afterOk(prev: HarnessHold | undefined, now: Date): HarnessHold | undefined {
  if (prev === undefined || prev.endedAt !== undefined) return undefined;
  if (isHeld(prev, now)) return prev;
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
 * The fixed harness order of each role (D-048). The agent's configured harness comes first,
 * then `fallback_harness`, then this order. It lives in code, not config: Settings → Team
 * is v0.2.
 */
export const HARNESS_ORDER: Record<AgentRole, readonly HarnessId[]> = {
  coordinator: ["claude-code", "codex"],
  backend: ["opencode", "codex", "claude-code"],
  frontend: ["opencode", "codex", "claude-code"],
  qa: ["codex", "claude-code"],
  reviewer: ["codex", "claude-code"],
};

/** Why a harness cannot take this run (D-048). */
export type HarnessSkipReason =
  | "has no adapter"
  | "is not installed"
  | "is not signed in"
  | "is limited";

/** What the loop knows about each harness at dispatch time (D-048). */
export interface HarnessAvailability {
  /** A usage-limit hold is in force (D-034). */
  held(harness: HarnessId): boolean;
  /** The loop has an adapter for the harness. */
  hasAdapter(harness: HarnessId): boolean;
  /** The status engine's `harness.<id>.cli` check did not fail or go missing. */
  installed(harness: HarnessId): boolean;
  /** The status engine's `harness.<id>.auth` check did not fail or go missing. */
  signedIn(harness: HarnessId): boolean;
}

/** The harness ids one run may use, in order, before any is dropped (D-048). */
export function harnessCandidates(agent: ResolvedAgentConfig): HarnessId[] {
  const ids = [agent.harness];
  const fallback = agent.fallback_harness;
  if (fallback !== undefined && fallback !== agent.harness) ids.push(fallback);
  ids.push(...HARNESS_ORDER[agent.role]);
  return [...new Set(ids)];
}

/** Why this harness cannot take the run now, or undefined when it can. */
export function harnessSkip(
  harness: HarnessId,
  availability: HarnessAvailability,
): HarnessSkipReason | undefined {
  if (!availability.hasAdapter(harness)) return "has no adapter";
  if (!availability.installed(harness)) return "is not installed";
  if (!availability.signedIn(harness)) return "is not signed in";
  if (availability.held(harness)) return "is limited";
  return undefined;
}

/** The agent config for one harness: the main model, the fallback model, or the CLI default. */
export function configOnHarness(
  agent: ResolvedAgentConfig,
  harness: HarnessId,
): ResolvedAgentConfig {
  const { model, fallback_harness, fallback_model, ...rest } = agent;
  const out: ResolvedAgentConfig = { ...rest, harness };
  if (harness === agent.harness) {
    if (model !== undefined) out.model = model;
  } else if (harness === fallback_harness && fallback_model !== undefined) {
    out.model = fallback_model;
  }
  return out;
}

/**
 * The agent configs a run may start on, in order (D-048). The configured harness comes
 * first, then `fallback_harness`, then the role order. A harness is dropped when it has no
 * adapter, is not installed or signed in, or is held (D-034). The first item is the run's
 * first try. An empty list means no harness is left: the issue stays Ready.
 */
export function harnessForRun(
  agent: ResolvedAgentConfig,
  availability: HarnessAvailability,
): ResolvedAgentConfig[] {
  return harnessCandidates(agent)
    .filter((harness) => harnessSkip(harness, availability) === undefined)
    .map((harness) => configOnHarness(agent, harness));
}

/**
 * The first usable harness after `after` in `order`, wrapping around to the first one
 * (D-048). A harness that is not in `order` means the first one. Undefined when none is.
 */
export function pickHarness(
  order: readonly ResolvedAgentConfig[],
  after?: HarnessId,
): ResolvedAgentConfig | undefined {
  if (order.length === 0) return undefined;
  if (after === undefined) return order[0];
  const at = order.findIndex((agent) => agent.harness === after);
  return order[at === -1 ? 0 : (at + 1) % order.length];
}

/**
 * Why a run moves to the next harness, as the log and the run view say it (D-048).
 * Undefined for an ok run, a cancel, a turn cap (D-045) and a task failure such as an
 * unusable reply: those retry on the same harness.
 */
export function switchWhy(result: RunResult): string | undefined {
  if (result.status === "timeout") return "timed out";
  if (result.status === "limited") return "hit its usage limit";
  if (result.reason === "auth") return "is not signed in";
  if (result.reason === "stalled") return "stalled";
  if (result.reason === "turn_cap") return undefined;
  if (result.status === "error") {
    return result.error === undefined ? "failed" : `failed (${oneLine(result.error)})`;
  }
  return undefined;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * The holds in force at `now`, by harness id: an expired or ended hold is left out. A
 * backoff hold ends exactly `backoffMs` after it started; a reset-time hold may keep an
 * old `backoffMs`, so the end decides which one it is.
 */
export function activeLimits(
  limits: Partial<Record<HarnessId, HarnessHold>>,
  now: Date,
): HarnessLimit[] {
  return (Object.entries(limits) as Array<[HarnessId, HarnessHold]>)
    .filter(([, hold]) => isHeld(hold, now))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([harness, hold]) => ({
      harness,
      until: hold.until,
      backoff:
        hold.backoffMs !== undefined &&
        Date.parse(hold.until) === Date.parse(hold.since) + hold.backoffMs,
    }));
}

/** A hold starts or ends. The daily summary counts limited time from these (MET-82). */
export interface HoldEvent {
  harness: HarnessId;
  kind: "start" | "end";
  /** ISO time: the hold's start, or the time it ended (its `until` once that has passed). */
  at: string;
  /** On an end: the hold's own start, so an end without its start still counts right. */
  since?: string;
}
