import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentView } from "@harnessd/shared";
import {
  activeLimits,
  agentLimit,
  type HarnessLimit,
  limitParts,
  limitText,
  mergeLoop,
} from "./limits.ts";
import type { LoopState } from "./route.ts";

const now = new Date(2026, 10, 20, 17, 40);
const at = (h: number, m: number) => new Date(2026, 10, 20, h, m).toISOString();

const claude: HarnessLimit = { harness: "claude-code", until: at(18, 37), backoff: false };
const codex: HarnessLimit = { harness: "codex", until: at(19, 5), backoff: false };

test("limitText names the harness and the reset in local HH:MM", () => {
  assert.equal(limitText(claude), "Claude Code limited until 18:37");
});

test("limitText adds (backoff) when the harness gave no reset time", () => {
  assert.equal(
    limitText({ harness: "codex", until: at(17, 55), backoff: true }),
    "Codex limited until 17:55 (backoff)",
  );
});

test("limitParts splits the text so a narrow header can drop the name", () => {
  assert.deepEqual(limitParts({ ...claude, backoff: true }), {
    name: "Claude Code limited ",
    until: "until 18:37",
    backoff: " (backoff)",
  });
});

/** The header's entries: one text per hold in force. */
const holdTexts = (limits: HarnessLimit[] | undefined, at: Date) =>
  activeLimits(limits, at).map(limitText);

test("header text: no hold shows nothing", () => {
  assert.deepEqual(holdTexts(undefined, now), []);
  assert.deepEqual(holdTexts([], now), []);
});

test("header text: one hold", () => {
  assert.deepEqual(holdTexts([claude], now), ["Claude Code limited until 18:37"]);
});

test("header text: two holds, one entry each", () => {
  assert.deepEqual(holdTexts([claude, codex], now), [
    "Claude Code limited until 18:37",
    "Codex limited until 19:05",
  ]);
});

test("header text: a backoff hold", () => {
  const backoff = { harness: "claude-code", until: at(17, 45), backoff: true } as const;
  assert.deepEqual(holdTexts([backoff], now), ["Claude Code limited until 17:45 (backoff)"]);
});

test("a hold past its reset time is not shown, before the daemon drops it", () => {
  const ended = { harness: "claude-code", until: at(17, 40), backoff: false } as const;
  assert.deepEqual(activeLimits([ended, codex], now), [codex]);
});

test("a hold with an unreadable time is not shown", () => {
  assert.deepEqual(activeLimits([{ ...claude, until: "soon" }], now), []);
});

const agent = (harness: AgentView["harness"], runs = 0): AgentView => ({
  name: "frontend",
  role: "frontend",
  harness,
  runs: Array.from({ length: runs }, (_, i) => ({
    issueKey: `MET-${i}`,
    title: "t",
    startedAt: at(17, 0),
    budgetMs: 1,
    tokens: 0,
    stopping: false,
  })),
});

test("an agent row shows the hold only when its harness is held", () => {
  assert.equal(agentLimit(agent("claude-code"), [claude]), claude);
  assert.equal(agentLimit(agent("codex"), [claude]), undefined);
  assert.equal(agentLimit(agent("claude-code"), []), undefined);
});

test("an agent that runs while its harness is held runs on its fallback: nothing extra", () => {
  assert.equal(agentLimit(agent("claude-code", 1), [claude]), undefined);
});

const running: LoopState = { state: "running", blocking: [], limits: [claude] };

test("a live loop event with no limits removes the text", () => {
  const next = mergeLoop(running, { state: "running", blocking: [], limits: [] });
  assert.deepEqual(holdTexts(next?.limits, now), []);
});

test("a live event that carries only limits keeps the loop state", () => {
  const next = mergeLoop(running, { limits: [codex] });
  assert.deepEqual(next, { state: "running", blocking: [], limits: [codex] });
});

test("a limits-only event before the first loop read waits for that read", () => {
  assert.equal(mergeLoop(undefined, { limits: [claude] }), undefined);
  assert.deepEqual(mergeLoop(undefined, running), running);
});
