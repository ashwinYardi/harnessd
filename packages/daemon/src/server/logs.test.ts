import assert from "node:assert/strict";
import { test } from "node:test";
import { createLogBuffer } from "./logs.ts";

const at = () => new Date("2026-11-20T10:00:00.000Z");

test("a log buffer numbers lines, finds the issue key and marks warnings", () => {
  const logs = createLogBuffer({ now: at });
  logs.push("MET-41: backend started (S, 30 min)");
  logs.push("MET-42: failed twice (timeout), Needs input");
  logs.push("Edit src/app.ts", { source: "backend", issueKey: "MET-41" });
  assert.deepEqual(logs.tail(), [
    {
      seq: 1,
      at: "2026-11-20T10:00:00.000Z",
      source: "loop",
      issueKey: "MET-41",
      level: "info",
      text: "MET-41: backend started (S, 30 min)",
    },
    {
      seq: 2,
      at: "2026-11-20T10:00:00.000Z",
      source: "loop",
      issueKey: "MET-42",
      level: "warn",
      text: "MET-42: failed twice (timeout), Needs input",
    },
    {
      seq: 3,
      at: "2026-11-20T10:00:00.000Z",
      source: "backend",
      issueKey: "MET-41",
      level: "info",
      text: "Edit src/app.ts",
    },
  ]);
});

test("a log buffer keeps the newest lines and tells subscribers", () => {
  const logs = createLogBuffer({ now: at, capacity: 2 });
  const seen: number[] = [];
  const off = logs.subscribe((line) => seen.push(line.seq));
  logs.push("one");
  logs.push("two");
  logs.push("three");
  off();
  logs.push("four");
  assert.deepEqual(seen, [1, 2, 3]);
  assert.deepEqual(
    logs.tail().map((l) => l.text),
    ["three", "four"],
  );
  assert.equal(logs.tail()[0]?.issueKey, undefined, "no key in the text, no key on the line");
});

test("log text is one line and capped", () => {
  const logs = createLogBuffer({ now: at });
  const line = logs.push(`a\n  b ${"x".repeat(3000)}`);
  assert.ok(line.text.startsWith("a b x"));
  assert.equal(line.text.length, 2000);
});
