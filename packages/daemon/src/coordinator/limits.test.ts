import assert from "node:assert/strict";
import { test } from "node:test";
import type { ResolvedAgentConfig, RunResult } from "@harnessd/shared";
import {
  activeLimits,
  afterLimited,
  afterOk,
  FIRST_BACKOFF_MS,
  type HarnessAvailability,
  harnessForRun,
  isHeld,
  MAX_BACKOFF_MS,
  pickHarness,
  releaseExpired,
  switchWhy,
} from "./limits.ts";
import type { HarnessHold } from "./state.ts";

const T0 = new Date("2026-11-20T17:37:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);
const MIN = 60_000;

test("a reset time from the harness is the hold's end", () => {
  const hold = afterLimited(undefined, "2026-11-20T20:00:00.000Z", T0);
  assert.deepEqual(hold, { until: "2026-11-20T20:00:00.000Z", since: T0.toISOString() });
  assert.equal(isHeld(hold, at(MIN)), true);
  assert.equal(isHeld(hold, new Date("2026-11-20T20:00:00.000Z")), false);
});

test("no reset time: 15 minutes, doubling after each expired hold, capped at 2 hours", () => {
  let hold = afterLimited(undefined, undefined, T0);
  assert.equal(hold.backoffMs, FIRST_BACKOFF_MS);
  assert.equal(hold.until, at(15 * MIN).toISOString());
  const waits: number[] = [];
  let now = T0;
  for (let i = 0; i < 5; i++) {
    now = new Date(Date.parse(hold.until));
    const released = releaseExpired(hold, now);
    assert.equal(released.ended, true);
    hold = afterLimited(released.hold, undefined, now);
    waits.push((hold.backoffMs ?? 0) / MIN);
  }
  assert.deepEqual(waits, [30, 60, 120, 120, 120]);
  assert.equal(MAX_BACKOFF_MS, 120 * MIN);
});

test("more limited runs while a hold is active do not double it", () => {
  const hold = afterLimited(undefined, undefined, T0);
  assert.deepEqual(afterLimited(hold, undefined, at(MIN)), hold);
  const reset = afterLimited(hold, "2026-11-20T19:00:00.000Z", at(MIN));
  assert.equal(reset.until, "2026-11-20T19:00:00.000Z");
  assert.equal(reset.since, T0.toISOString(), "the same hold goes on");
});

test("an ok run clears the backoff", () => {
  const hold = afterLimited(undefined, undefined, T0);
  const released = releaseExpired(hold, at(15 * MIN)).hold;
  assert.equal(afterOk(released, at(20 * MIN)), undefined);
  assert.equal(
    afterLimited(afterOk(released, at(20 * MIN)), undefined, at(20 * MIN)).backoffMs,
    FIRST_BACKOFF_MS,
  );
});

test("an ok run that ends during an active hold leaves the hold as it is", () => {
  const backoff = afterLimited(undefined, undefined, T0);
  assert.deepEqual(afterOk(backoff, at(MIN)), backoff, "the backoff hold keeps its flag");
  assert.deepEqual(activeLimits({ "claude-code": afterOk(backoff, at(MIN)) ?? backoff }, at(MIN)), [
    { harness: "claude-code", until: backoff.until, backoff: true },
  ]);
  const reset = afterLimited(undefined, "2026-11-20T20:00:00.000Z", T0);
  assert.deepEqual(afterOk(reset, at(MIN)), reset);
});

test("releaseExpired ends a hold once, and drops one with no backoff", () => {
  const reset = afterLimited(undefined, "2026-11-20T18:00:00.000Z", T0);
  assert.deepEqual(releaseExpired(reset, at(MIN)), { hold: reset, ended: false });
  assert.deepEqual(releaseExpired(reset, new Date("2026-11-20T18:00:00.000Z")), {
    hold: undefined,
    ended: true,
  });
  const backoff = afterLimited(undefined, undefined, T0);
  const first = releaseExpired(backoff, at(16 * MIN));
  assert.equal(first.ended, true);
  assert.equal(first.hold?.backoffMs, FIRST_BACKOFF_MS, "the backoff is kept for the next limit");
  assert.equal(isHeld(first.hold, at(16 * MIN)), false);
  assert.deepEqual(releaseExpired(first.hold, at(17 * MIN)), { hold: first.hold, ended: false });
});

// --- harnessForRun (MET-81, D-048) -------------------------------------------

const AGENT: ResolvedAgentConfig = {
  name: "backend",
  role: "backend",
  harness: "claude-code",
  model: "opus",
  fallback_harness: "codex",
  fallback_model: "gpt-5",
  instructions: "",
  rules: [],
  skills: [],
};

function availability(overrides: Partial<HarnessAvailability> = {}): HarnessAvailability {
  return {
    held: () => false,
    hasAdapter: () => true,
    installed: () => true,
    signedIn: () => true,
    ...overrides,
  };
}

const harnesses = (agent: ResolvedAgentConfig, a = availability()) =>
  harnessForRun(agent, a).map((c) => c.harness);

test("harnessForRun orders the configured harness first, the fallback second, then the role order", () => {
  assert.deepEqual(harnesses(AGENT), ["claude-code", "codex", "opencode"]);
  const { fallback_harness: _, ...noFallback } = AGENT;
  assert.deepEqual(harnesses(noFallback), ["claude-code", "opencode", "codex"]);
});

test("harnessForRun removes duplicates, including a fallback equal to the main harness", () => {
  assert.deepEqual(harnesses({ ...AGENT, fallback_harness: "claude-code" }), [
    "claude-code",
    "opencode",
    "codex",
  ]);
  const { fallback_harness: _fallback, ...opencodeMain } = AGENT;
  assert.deepEqual(harnesses({ ...opencodeMain, harness: "opencode" }), [
    "opencode",
    "codex",
    "claude-code",
  ]);
});

test("harnessForRun keeps the main model, the fallback model, and no model elsewhere", () => {
  const order = harnessForRun(AGENT, availability());
  assert.equal(order[0]?.model, "opus");
  assert.equal(order[1]?.model, "gpt-5");
  assert.equal("model" in (order[2] ?? {}), false);
  const { fallback_model: _, ...noFallbackModel } = AGENT;
  const without = harnessForRun(noFallbackModel, availability());
  assert.equal("model" in (without[1] ?? {}), false);
});

test("harnessForRun drops a held harness, one with no adapter, and one not installed or signed in", () => {
  assert.deepEqual(harnesses(AGENT, availability({ held: (h) => h === "claude-code" })), [
    "codex",
    "opencode",
  ]);
  assert.deepEqual(harnesses(AGENT, availability({ hasAdapter: (h) => h !== "codex" })), [
    "claude-code",
    "opencode",
  ]);
  assert.deepEqual(harnesses(AGENT, availability({ installed: (h) => h !== "codex" })), [
    "claude-code",
    "opencode",
  ]);
  assert.deepEqual(harnesses(AGENT, availability({ signedIn: (h) => h !== "codex" })), [
    "claude-code",
    "opencode",
  ]);
});

test("harnessForRun is empty when no harness is left", () => {
  assert.deepEqual(harnesses(AGENT, availability({ held: () => true })), []);
});

test("pickHarness takes the first after `from` and wraps around", () => {
  const order = harnessForRun(AGENT, availability());
  assert.equal(pickHarness(order)?.harness, "claude-code");
  assert.equal(pickHarness(order, "claude-code")?.harness, "codex");
  assert.equal(pickHarness(order, "codex")?.harness, "opencode");
  assert.equal(pickHarness(order, "opencode")?.harness, "claude-code", "wraps around");
  assert.equal(pickHarness(order, "cursor")?.harness, "claude-code", "unknown from: first");
  assert.equal(pickHarness([], "claude-code"), undefined);
});

test("switchWhy names a harness failure and leaves task failures on the same harness", () => {
  const run = (fields: Partial<RunResult>): RunResult => ({
    status: "error",
    exitCode: 1,
    durationMs: 1,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...fields,
  });
  assert.equal(switchWhy(run({ status: "timeout" })), "timed out");
  assert.equal(switchWhy(run({ status: "limited" })), "hit its usage limit");
  assert.equal(switchWhy(run({ reason: "auth" })), "is not signed in");
  assert.equal(switchWhy(run({ reason: "stalled" })), "stalled");
  assert.equal(switchWhy(run({ error: "exited with code 1" })), "failed (exited with code 1)");
  assert.equal(switchWhy(run({ reason: "turn_cap", error: "turn cap (80 turns)" })), undefined);
  assert.equal(switchWhy(run({ status: "ok" })), undefined);
  assert.equal(switchWhy(run({ status: "cancelled" })), undefined);
});

test("activeLimits lists only holds in force, with the backoff flag", () => {
  assert.deepEqual(activeLimits({}, T0), []);
  const reset = afterLimited(undefined, "2026-11-20T20:00:00.000Z", T0);
  const backoff = afterLimited(undefined, undefined, T0);
  const expired = afterLimited(undefined, "2026-11-20T17:40:00.000Z", T0);
  assert.deepEqual(activeLimits({ codex: backoff, "claude-code": reset }, at(MIN)), [
    { harness: "claude-code", until: "2026-11-20T20:00:00.000Z", backoff: false },
    { harness: "codex", until: at(15 * MIN).toISOString(), backoff: true },
  ]);
  assert.deepEqual(activeLimits({ "claude-code": expired }, at(5 * MIN)), [], "expired: left out");
  const ended = releaseExpired(backoff, at(16 * MIN)).hold as HarnessHold;
  assert.deepEqual(activeLimits({ codex: ended }, at(16 * MIN)), [], "ended: left out");
  // A reset time after a backoff keeps the old backoffMs, but is no backoff hold.
  const later = afterLimited(ended, "2026-11-20T21:00:00.000Z", at(20 * MIN));
  assert.deepEqual(activeLimits({ codex: later }, at(21 * MIN)), [
    { harness: "codex", until: "2026-11-20T21:00:00.000Z", backoff: false },
  ]);
});
