import assert from "node:assert/strict";
import { test } from "node:test";
import { hrefFor, parseRoute } from "./route.ts";

test("parseRoute reads the view from the hash, and Board is the default", () => {
  assert.deepEqual(parseRoute(""), { view: "board" });
  assert.deepEqual(parseRoute("#/"), { view: "board" });
  assert.deepEqual(parseRoute("#/agents"), { view: "agents" });
  assert.deepEqual(parseRoute("#/logs"), { view: "logs" });
  assert.deepEqual(parseRoute("#/settings"), { view: "settings" });
});

test("parseRoute sends an unknown hash to Board", () => {
  assert.deepEqual(parseRoute("#/nope"), { view: "board" });
  assert.deepEqual(parseRoute("#agents-title"), { view: "board" });
});

test("hrefFor and parseRoute agree", () => {
  for (const view of ["board", "agents", "logs", "settings"] as const) {
    assert.deepEqual(parseRoute(hrefFor({ view })), { view });
  }
});
