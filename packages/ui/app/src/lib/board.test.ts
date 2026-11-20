import assert from "node:assert/strict";
import { test } from "node:test";
import type { BoardIssue } from "@harnessd/shared";
import { groupBoard } from "./board.ts";

const issue = (key: string, state: string, extra: Partial<BoardIssue> = {}): BoardIssue => ({
  id: key,
  key,
  title: key,
  state,
  priority: 3,
  labels: [],
  url: `https://linear.test/${key}`,
  blockedBy: [],
  updatedAt: "2026-11-20T09:00:00.000Z",
  ...extra,
});

test("groupBoard puts Needs input and Blocked first, then each state in flow order", () => {
  const columns = groupBoard([
    issue("MET-1", "Done"),
    issue("MET-2", "Ready"),
    issue("MET-3", "Needs input"),
    issue("MET-4", "In Review", { blocked: "touches protected paths" }),
    issue("MET-5", "in progress"),
    issue("MET-6", "Backlog"),
    issue("MET-7", "Triage"),
  ]);
  assert.deepEqual(
    columns.map((c) => [c.id, c.title, c.issues.map((i) => i.key)]),
    [
      ["needs-you", "Needs you", ["MET-3", "MET-4"]],
      ["backlog", "Backlog", ["MET-6", "MET-7"]],
      ["ready", "Ready", ["MET-2"]],
      ["in-progress", "In Progress", ["MET-5"]],
      ["in-review", "In Review", []],
      ["done", "Done", ["MET-1"]],
    ],
  );
});

test("groupBoard keeps the order it is given within a column", () => {
  const columns = groupBoard([issue("MET-9", "Ready"), issue("MET-2", "Ready")]);
  assert.deepEqual(
    columns.find((c) => c.id === "ready")?.issues.map((i) => i.key),
    ["MET-9", "MET-2"],
  );
});
