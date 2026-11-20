import assert from "node:assert/strict";
import { test } from "node:test";
import { firstRoute, hrefFor, parseRoute } from "./route.ts";

test("parseRoute reads the view from the hash, and Board is the default", () => {
  assert.deepEqual(parseRoute(""), { view: "board" });
  assert.deepEqual(parseRoute("#/"), { view: "board" });
  assert.deepEqual(parseRoute("#/agents"), { view: "agents" });
  assert.deepEqual(parseRoute("#/logs"), { view: "logs" });
  assert.deepEqual(parseRoute("#/settings"), { view: "settings", page: "harnesses" });
});

test("parseRoute sends an unknown hash to Board", () => {
  assert.deepEqual(parseRoute("#/nope"), { view: "board" });
  assert.deepEqual(parseRoute("#agents-title"), { view: "board" });
});

test("hrefFor and parseRoute agree", () => {
  for (const view of ["board", "agents", "logs"] as const) {
    assert.deepEqual(parseRoute(hrefFor({ view })), { view });
  }
});

test("Settings has three pages, Harnesses by default", () => {
  assert.deepEqual(parseRoute("#/settings"), { view: "settings", page: "harnesses" });
  assert.deepEqual(parseRoute("#/settings/connections"), { view: "settings", page: "connections" });
  assert.deepEqual(parseRoute("#/settings/team"), { view: "settings", page: "team" });
  assert.deepEqual(parseRoute("#/settings/nope"), { view: "settings", page: "harnesses" });
  assert.equal(hrefFor({ view: "settings", page: "team" }), "#/settings/team");
});

test("firstRoute opens Settings → Harnesses on first launch while a required check blocks", () => {
  assert.deepEqual(firstRoute("", { state: "setup", blocking: ["harness.claude-code.cli"] }), {
    view: "settings",
    page: "harnesses",
  });
  assert.deepEqual(firstRoute("", { state: "setup", blocking: ["linear.key"] }), {
    view: "settings",
    page: "connections",
  });
  assert.equal(
    firstRoute("#/logs", { state: "setup", blocking: ["linear.key"] }),
    undefined,
    "a chosen view stays",
  );
  assert.equal(firstRoute("", { state: "running", blocking: [] }), undefined);
  assert.equal(firstRoute("", { state: "setup", blocking: [] }), undefined);
});
