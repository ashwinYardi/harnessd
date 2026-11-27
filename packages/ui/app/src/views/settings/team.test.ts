// The Team view's row order and role options include the reviewer role (MET-227).
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_AGENTS } from "@harnessd/shared";
import { byRoleOrder, ROLE_OPTIONS } from "./team.ts";

test("the role select offers reviewer after qa, in role order", () => {
  assert.deepEqual([...ROLE_OPTIONS], ["coordinator", "backend", "frontend", "qa", "reviewer"]);
});

test("the table lists rows in role order, reviewer after qa", () => {
  const rows = byRoleOrder([
    { name: "docs-writer", role: "backend" },
    { name: "reviewer", role: "reviewer" },
    { name: "qa", role: "qa" },
    { name: "coordinator", role: "coordinator" },
    { name: "frontend", role: "frontend" },
    { name: "api", role: "backend" },
  ]);
  assert.deepEqual(
    rows.map((r) => r.name),
    // Same-role rows keep the order they arrived in (docs-writer, then api).
    ["coordinator", "docs-writer", "api", "frontend", "qa", "reviewer"],
  );
});

test("a row with a role this UI does not know sorts last and keeps its place", () => {
  const rows = byRoleOrder([
    { name: "legacy", role: "docs" },
    { name: "qa", role: "qa" },
  ]);
  assert.deepEqual(
    rows.map((r) => r.name),
    ["qa", "legacy"],
  );
});

test("the default team ships the reviewer on codex gpt-6.2-sol, so Claude quota stays with the coordinator", () => {
  assert.deepEqual(DEFAULT_AGENTS.reviewer, {
    role: "reviewer",
    harness: "codex",
    model: "gpt-6.2-sol",
  });
});
