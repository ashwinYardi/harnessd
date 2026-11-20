import assert from "node:assert/strict";
import { test } from "node:test";
import { budgetText, budgetUsed, clockTime, duration, sinceText, tokens } from "./format.ts";

test("duration reads as seconds, minutes and hours", () => {
  assert.equal(duration(0), "0s");
  assert.equal(duration(4_400), "4s");
  assert.equal(duration(65_000), "1m 05s");
  assert.equal(duration(30 * 60_000), "30m 00s");
  assert.equal(duration(2 * 3_600_000 + 3 * 60_000), "2h 03m");
  assert.equal(duration(-5), "0s");
});

test("budgetUsed is the share of the time budget spent, past 1 when over", () => {
  const start = "2026-11-20T10:00:00.000Z";
  const at = (ms: number) => new Date(Date.parse(start) + ms);
  assert.equal(budgetUsed(start, 1_800_000, at(450_000)), 0.25);
  assert.equal(budgetUsed(start, 1_800_000, at(1_854_000)), 1.03);
  assert.equal(budgetUsed(start, 0, at(1)), 0);
});

test("tokens reads in thousands and millions", () => {
  assert.equal(tokens(0), "0");
  assert.equal(tokens(950), "950");
  assert.equal(tokens(1_500), "1.5k");
  assert.equal(tokens(48_200), "48k");
  assert.equal(tokens(1_250_000), "1.3M");
});

test("sinceText says how long ago, in words a person reads at a glance", () => {
  const now = new Date("2026-11-20T10:00:00.000Z");
  assert.equal(sinceText("2026-11-20T09:59:58.000Z", now), "just now");
  assert.equal(sinceText("2026-11-20T09:59:30.000Z", now), "30s ago");
  assert.equal(sinceText("2026-11-20T09:48:00.000Z", now), "12m ago");
  assert.equal(sinceText("2026-11-20T07:00:00.000Z", now), "3h ago");
  assert.equal(sinceText("2026-11-17T10:00:00.000Z", now), "3d ago");
});

test("clockTime is 24-hour local time with seconds", () => {
  assert.match(clockTime("2026-11-20T10:04:05.000Z"), /^\d{2}:\d{2}:\d{2}$/);
});

test("budgetText names a budget in whole minutes or hours", () => {
  assert.equal(budgetText(30 * 60_000), "30m");
  assert.equal(budgetText(120 * 60_000), "2h");
  assert.equal(budgetText(90 * 60_000), "1h 30m");
});
