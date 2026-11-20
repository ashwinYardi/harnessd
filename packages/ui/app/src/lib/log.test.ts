import assert from "node:assert/strict";
import { test } from "node:test";
import type { LogLine } from "@harnessd/shared";
import { appendLines, isAtBottom } from "./log.ts";

const line = (seq: number): LogLine => ({
  seq,
  at: "2026-11-20T10:00:00.000Z",
  source: "loop",
  level: "info",
  text: `line ${seq}`,
});

test("appendLines adds new lines in order, drops repeats and keeps the newest", () => {
  const out = appendLines([line(1), line(2)], [line(2), line(4), line(3)], 3);
  assert.deepEqual(
    out.map((l) => l.seq),
    [2, 3, 4],
  );
});

test("isAtBottom allows a few pixels of slack", () => {
  assert.equal(isAtBottom({ scrollTop: 500, clientHeight: 200, scrollHeight: 700 }), true);
  assert.equal(isAtBottom({ scrollTop: 496, clientHeight: 200, scrollHeight: 700 }), true);
  assert.equal(isAtBottom({ scrollTop: 400, clientHeight: 200, scrollHeight: 700 }), false);
});
