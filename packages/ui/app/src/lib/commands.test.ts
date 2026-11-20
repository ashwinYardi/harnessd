import assert from "node:assert/strict";
import { test } from "node:test";
import { type Command, matchCommands, nextEnabled } from "./commands.ts";

const cmd = (id: string, title: string, keywords: string[] = []): Command => ({
  id,
  title,
  group: "Go to",
  keywords,
});

const ALL = [
  cmd("go-board", "Go to Board"),
  cmd("go-agents", "Go to Agents"),
  cmd("go-logs", "Go to Logs", ["log"]),
  cmd("pause", "Pause all agents", ["stop", "kill"]),
  cmd("theme-dark", "Use dark theme"),
];

test("matchCommands keeps every command, in order, for an empty query", () => {
  assert.deepEqual(
    matchCommands(ALL, "  ").map((c) => c.id),
    ALL.map((c) => c.id),
  );
});

test("matchCommands finds words anywhere in the title or keywords, any case", () => {
  assert.deepEqual(
    matchCommands(ALL, "AGENTS").map((c) => c.id),
    ["go-agents", "pause"],
  );
  assert.deepEqual(
    matchCommands(ALL, "kill").map((c) => c.id),
    ["pause"],
  );
});

test("matchCommands needs every word of the query to match", () => {
  assert.deepEqual(
    matchCommands(ALL, "go lo").map((c) => c.id),
    ["go-logs"],
  );
  assert.deepEqual(matchCommands(ALL, "dark board"), []);
});

test("matchCommands puts a title that starts with the query first", () => {
  assert.deepEqual(
    matchCommands(ALL, "pa").map((c) => c.id),
    ["pause"],
  );
  assert.deepEqual(
    matchCommands([cmd("a", "Show paused runs"), cmd("b", "Pause all agents")], "pau").map(
      (c) => c.id,
    ),
    ["b", "a"],
  );
});

test("nextEnabled skips disabled commands and wraps", () => {
  const list = [cmd("a", "A"), { ...cmd("b", "B"), disabled: true }, cmd("c", "C")];
  assert.equal(nextEnabled(list, 0, 1), 2);
  assert.equal(nextEnabled(list, 2, 1), 0);
  assert.equal(nextEnabled(list, 0, -1), 2);
  assert.equal(nextEnabled([{ ...cmd("x", "X"), disabled: true }], 0, 1), -1);
});
