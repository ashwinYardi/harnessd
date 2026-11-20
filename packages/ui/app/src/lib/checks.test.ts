import assert from "node:assert/strict";
import { test } from "node:test";
import { type Check, isBlocking, sortChecks } from "./checks.ts";

const c = (id: string, state: Check["state"]): Check => ({ id, state, detail: "", fix: "" });

test("sortChecks puts fail and missing first, then warn, then ok, keeping engine order", () => {
  const out = sortChecks([
    c("a", "ok"),
    c("b", "warn"),
    c("c", "missing"),
    c("d", "fail"),
    c("e", "ok"),
  ]);
  assert.deepEqual(
    out.map((x) => x.id),
    ["d", "c", "b", "a", "e"],
  );
});

test("isBlocking matches D-023: fail and missing block, warn never does", () => {
  assert.deepEqual(
    (["ok", "warn", "fail", "missing"] as const).map((s) => isBlocking(c("x", s))),
    [false, false, true, true],
  );
});
