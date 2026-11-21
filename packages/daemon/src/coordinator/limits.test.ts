import assert from "node:assert/strict";
import { test } from "node:test";
import {
  afterLimited,
  afterOk,
  FIRST_BACKOFF_MS,
  isHeld,
  MAX_BACKOFF_MS,
  releaseExpired,
} from "./limits.ts";

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
  assert.equal(afterOk(released), undefined);
  assert.equal(
    afterLimited(afterOk(released), undefined, at(20 * MIN)).backoffMs,
    FIRST_BACKOFF_MS,
  );
  assert.deepEqual(afterOk(hold), { until: hold.until, since: hold.since }, "the hold stays");
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
