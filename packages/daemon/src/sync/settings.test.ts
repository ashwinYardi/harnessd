import assert from "node:assert/strict";
import { test } from "node:test";
import type { HookEvents } from "@harnessd/shared";
import { mergeHooks, mergeSettings } from "./settings.ts";

const STOP = { hooks: [{ type: "command", command: "scan", timeout: 30 }] };
const EDIT = { matcher: "Edit|Write", hooks: [{ type: "command", command: "scan", timeout: 5 }] };
const HOOKS: HookEvents = { PostToolUse: [EDIT], Stop: [STOP] };

test("a new file gets the keys, then the hooks", () => {
  const text = mergeSettings(undefined, { keys: { a: 1 }, hooks: HOOKS }, "s.json");
  assert.equal(text, `${JSON.stringify({ a: 1, hooks: HOOKS }, null, 2)}\n`);
});

test("no hooks adds no hooks key", () => {
  assert.equal(
    mergeSettings(undefined, { keys: { a: 1 }, hooks: {} }, "s.json"),
    '{\n  "a": 1\n}\n',
  );
});

test("user keys, permissions and hooks stay, in their place", () => {
  const mine = { matcher: "Bash", hooks: [{ type: "command", command: "audit" }] };
  const existing = {
    description: "mine",
    permissions: { allow: ["Bash(ls)"] },
    hooks: { PreToolUse: [mine], Stop: [mine] },
    a: 0,
  };
  const out = JSON.parse(
    mergeSettings(JSON.stringify(existing), { keys: { a: 1 }, hooks: HOOKS }, "s.json"),
  );
  assert.deepEqual(Object.keys(out), ["description", "permissions", "hooks", "a"]);
  assert.deepEqual(out.permissions, existing.permissions);
  assert.deepEqual(out.hooks, { PreToolUse: [mine], Stop: [mine, STOP], PostToolUse: [EDIT] });
  assert.equal(out.a, 1);
});

test("a group with the same matcher and command is replaced in place, not added again", () => {
  const old = { matcher: "Edit|Write", hooks: [{ type: "command", command: "scan", timeout: 2 }] };
  const other = { matcher: "Bash", hooks: [{ type: "command", command: "audit" }] };
  const merged = mergeHooks({ PostToolUse: [old, other] }, HOOKS, "s.json");
  assert.deepEqual(merged.PostToolUse, [EDIT, other]);
});

test("merging twice gives the same bytes", () => {
  const once = mergeSettings('{"x":true}', { keys: { a: 1 }, hooks: HOOKS }, "s.json");
  assert.equal(mergeSettings(once, { keys: { a: 1 }, hooks: HOOKS }, "s.json"), once);
});

test("a file that is not a JSON object is refused, not overwritten", () => {
  for (const bad of ["{", "[]", '{"hooks":[]}', '{"hooks":{"Stop":{}}}']) {
    assert.throws(
      () => mergeSettings(bad, { keys: {}, hooks: HOOKS }, ".claude/settings.json"),
      /\.claude\/settings\.json/,
      bad,
    );
  }
});

test("opencode.json: sync replaces only its own mcp entries by name and keeps every user key", () => {
  const existing = {
    model: "deepseek/deepseek-chat",
    $schema: "https://example.com/old.json",
    mcp: {
      mine: { type: "remote", url: "https://mcp.example.com" },
      "harnessd-memory": { type: "local", command: ["old"], enabled: false },
    },
    provider: { deepseek: { options: { timeout: 1 } } },
  };
  const memory = { type: "local", command: ["harnessd", "mcp", "memory"], enabled: true };
  const text = mergeSettings(
    JSON.stringify(existing),
    {
      keys: { $schema: "https://opencode.ai/config.json" },
      hooks: {},
      entries: { mcp: { "harnessd-memory": memory } },
    },
    "opencode.json",
  );
  const out = JSON.parse(text);
  assert.deepEqual(Object.keys(out), ["model", "$schema", "mcp", "provider"]);
  assert.equal(out.$schema, "https://opencode.ai/config.json");
  assert.deepEqual(out.mcp, { mine: existing.mcp.mine, "harnessd-memory": memory });
  assert.deepEqual(out.provider, existing.provider);
  assert.equal(out.hooks, undefined);
  // A second run gives the same bytes.
  assert.equal(
    mergeSettings(
      text,
      {
        keys: { $schema: "https://opencode.ai/config.json" },
        hooks: {},
        entries: { mcp: { "harnessd-memory": memory } },
      },
      "opencode.json",
    ),
    text,
  );
  assert.throws(
    () =>
      mergeSettings('{"mcp": []}', { keys: {}, hooks: {}, entries: { mcp: {} } }, "opencode.json"),
    /opencode.json has a "mcp" that is not an object/,
  );
});
