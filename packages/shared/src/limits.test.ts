import assert from "node:assert/strict";
import { test } from "node:test";
import { harnessName, limitAvailableLine, limitHoldLine, weightedTokens } from "./limits.ts";

const pad = (n: number) => String(n).padStart(2, "0");

test("weightedTokens counts input and output in full, cached at the weight", () => {
  const sum = { input: 186_944, cached: 12_257_280, output: 57_383 };
  assert.equal(weightedTokens(sum, 0.1), 1_470_055);
  // A weight of 1 is the old raw count of input, cached and output.
  assert.equal(weightedTokens(sum, 1), 12_501_607);
  assert.equal(weightedTokens({ input: 0, cached: 0, output: 0 }, 0.1), 0);
});

test("weightedTokens rounds the cached part once, not each term", () => {
  // 3 cached × 0.1 = 0.3 and 7 cached × 0.1 = 0.7: together 1, not 0 + 0.
  assert.equal(weightedTokens({ input: 0, cached: 10, output: 0 }, 0.1), 1);
  assert.equal(weightedTokens({ input: 1, cached: 5, output: 1 }, 0.1), 3);
  assert.equal(weightedTokens({ input: 1, cached: 4, output: 1 }, 0.1), 2);
});

test("harnessName gives the display name of each harness", () => {
  assert.equal(harnessName("claude-code"), "Claude Code");
  assert.equal(harnessName("codex"), "Codex");
});

test("limitHoldLine names the harness and the reset in local HH:MM", () => {
  const until = new Date(2026, 10, 20, 9, 5);
  assert.equal(limitHoldLine("claude-code", until), `Claude Code limited until 09:05`);
  assert.equal(limitHoldLine("codex", until, true), `Codex limited until 09:05 (backoff)`);
  const iso = new Date(Date.UTC(2026, 10, 20, 17, 37)).toISOString();
  const local = new Date(iso);
  assert.equal(
    limitHoldLine("claude-code", iso),
    `Claude Code limited until ${pad(local.getHours())}:${pad(local.getMinutes())}`,
  );
});

test("limitAvailableLine says the harness is back", () => {
  assert.equal(limitAvailableLine("claude-code"), "Claude Code available again");
});
