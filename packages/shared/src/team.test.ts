import assert from "node:assert/strict";
import { test } from "node:test";
import { OPENCODE_PROVIDER, opencodeProvider, validateTeam } from "./team.ts";

const ok = { name: "backend", role: "backend", harness: "claude-code", model: "" };
const coordinator = { name: "coordinator", role: "coordinator", harness: "claude-code" };

test("validateTeam accepts a team and returns no errors", () => {
  assert.deepEqual(
    validateTeam([coordinator, ok, { ...ok, name: "qa-2", role: "qa", model: "opus" }]),
    {},
  );
});

test("validateTeam names each bad field by row and key", () => {
  const errors = validateTeam([
    { ...ok, name: "" },
    { ...ok, name: "Bad Name" },
    { ...ok, role: "boss" },
    { ...ok, harness: "vim" },
    { ...ok, name: "y", model: "a\nb" },
    coordinator,
  ]);
  assert.deepEqual(errors, {
    "0.name": "Enter a name.",
    "1.name": "Use lowercase letters, digits, - and _, starting with a letter.",
    "2.role": "Pick a role: coordinator, backend, frontend, qa.",
    "3.name": "Another agent has this name.",
    "3.harness": "Pick a harness: claude-code, codex, antigravity, opencode, cursor, grok.",
    "4.model": "Use one line of at most 100 characters.",
  });
});

test("validateTeam needs exactly one coordinator", () => {
  assert.deepEqual(validateTeam([ok]), { team: "The team needs exactly one coordinator." });
  assert.deepEqual(validateTeam([coordinator, { ...coordinator, name: "c2" }]), {
    team: "The team needs exactly one coordinator.",
  });
});

test("opencodeProvider reads the provider of a valid OpenCode model id only", () => {
  assert.equal(opencodeProvider("deepseek/deepseek-chat"), "deepseek");
  assert.equal(opencodeProvider("openrouter/qwen/qwen3-coder:free"), "openrouter");
  assert.equal(opencodeProvider("opencode-go/kimi-k2.5"), "opencode-go");
  for (const bad of [
    "deepseek",
    "/x",
    "Deep/x",
    "a/",
    "a b/c",
    "a/b c",
    "a/-x",
    `a/${"x".repeat(100)}`,
  ]) {
    assert.equal(opencodeProvider(bad), undefined, bad);
  }
});

test("OPENCODE_PROVIDER takes plain lowercase ids of at most 64 characters", () => {
  for (const good of ["deepseek", "opencode-go", "amazon-bedrock", "x.ai", "a"]) {
    assert.ok(OPENCODE_PROVIDER.test(good), good);
  }
  for (const bad of ["", "-x", "Deep", "a/b", "a b", "--help", "x".repeat(65), "a\n"]) {
    assert.ok(!OPENCODE_PROVIDER.test(bad), JSON.stringify(bad));
  }
});
