import assert from "node:assert/strict";
import { test } from "node:test";
import type { LogLine } from "@harnessd/shared";
import { appendLines, FOLLOW, isAtBottom, scrollTail, tailView } from "./log.ts";

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

const lines = (...seqs: number[]) => seqs.map(line);
const seqs = (ls: readonly LogLine[]) => ls.map((l) => l.seq);

test("while the tail follows, new lines show at once; a pointer rest does not freeze it", () => {
  // The pointer is not an input: only a scroll freezes the tail.
  const tail = FOLLOW;
  assert.deepEqual(tailView(tail, lines(1, 2)), { follow: true, lines: lines(1, 2) });
  assert.deepEqual(seqs(tailView(tail, lines(1, 2, 3)).lines), [1, 2, 3]);
});

test("a scroll up freezes the lines; new lines wait below", () => {
  const tail = scrollTail(FOLLOW, false, lines(1, 2));
  assert.deepEqual(tailView(tail, lines(1, 2, 3, 4)), { follow: false, lines: lines(1, 2) });
  assert.equal(scrollTail(tail, false, lines(1, 2, 3, 4)), tail, "a further scroll up keeps them");
});

test("a scroll back to the end, or Jump to latest, follows again and shows all lines", () => {
  const frozen = scrollTail(FOLLOW, false, lines(1, 2));
  assert.deepEqual(tailView(scrollTail(frozen, true, lines(1, 2, 3)), lines(1, 2, 3)), {
    follow: true,
    lines: lines(1, 2, 3),
  });
  assert.deepEqual(tailView(FOLLOW, lines(1, 2, 3)).follow, true, "Jump to latest sets FOLLOW");
});
