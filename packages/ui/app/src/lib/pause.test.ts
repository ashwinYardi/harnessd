import assert from "node:assert/strict";
import { test } from "node:test";
import { type PauseView, pauseFailed, pauseSettled, pauseStarted, pauseView } from "./pause.ts";

const running = { paused: false } as const;
const paused = { paused: true, since: "2026-11-20T10:00:00.000Z" } as const;

test("pauseStarted shows the new state at once, before the daemon answers", () => {
  const v = pauseStarted(pauseView(running), "pause");
  assert.equal(v.shown.paused, true);
  assert.equal(v.busy, "pausing");
  assert.deepEqual(v.confirmed, running);
});

test("pauseSettled keeps the daemon's answer and clears busy", () => {
  const v = pauseSettled(pauseStarted(pauseView(running), "pause"), paused);
  assert.deepEqual(v, { confirmed: paused, shown: paused, busy: null });
});

test("pauseFailed rolls back to the last confirmed state", () => {
  const v = pauseFailed(pauseStarted(pauseView(paused), "resume"));
  assert.deepEqual(v, { confirmed: paused, shown: paused, busy: null });
});

test("a live update while busy changes the confirmed state but not what is shown", () => {
  const start: PauseView = pauseStarted(pauseView(running), "pause");
  const v = pauseView(paused, start);
  assert.equal(v.busy, "pausing");
  assert.equal(v.shown.paused, true);
  assert.deepEqual(v.confirmed, paused);
});

test("a live update while idle shows at once", () => {
  assert.deepEqual(pauseView(paused, pauseView(running)), {
    confirmed: paused,
    shown: paused,
    busy: null,
  });
});

test("an unknown state counts as running, so the kill switch still pauses", () => {
  const v = pauseView(undefined);
  assert.equal(v.shown.paused, false);
  assert.equal(pauseStarted(v, "pause").shown.paused, true);
});
