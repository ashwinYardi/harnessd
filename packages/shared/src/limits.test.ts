import assert from "node:assert/strict";
import { test } from "node:test";
import { harnessName, limitAvailableLine, limitHoldLine } from "./limits.ts";

const pad = (n: number) => String(n).padStart(2, "0");

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
