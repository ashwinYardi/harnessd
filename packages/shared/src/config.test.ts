import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigError, parseAgentSettings, parseConfigFile } from "./index.ts";

const FILE = "~/.harnessd/config.toml";

function rejects(value: unknown, message: string) {
  assert.throws(
    () => parseConfigFile(value, FILE),
    (e: unknown) => e instanceof ConfigError && e.message === message,
  );
}

test("parseConfigFile accepts a full config", () => {
  const input = {
    limits: { max_concurrent: 5, budget_minutes: { S: 20, M: 90 }, qa_max_failures: 1 },
    linear: { team_id: "MET", project: "harnessd" },
    slack: { channel: "#ops" },
    merge: { protected_paths: ["infra/**"] },
    agents: { backend: { role: "backend", harness: "codex", model: "gpt-5", instructions: "Hi" } },
  };
  assert.deepEqual(parseConfigFile(input, FILE), input);
});

test("parseConfigFile accepts an empty file", () => {
  assert.deepEqual(parseConfigFile({}, FILE), {});
});

test("an unknown harness names the file and key", () => {
  rejects(
    { agents: { backend: { harness: "vim" } } },
    `${FILE}: agents.backend.harness: expected one of claude-code, codex, antigravity, opencode, cursor, grok, got "vim"`,
  );
});

test("unknown keys are rejected with their path", () => {
  rejects(
    { limits: { max_concurent: 2 } },
    `${FILE}: limits.max_concurent: unknown key, expected one of max_concurrent, budget_minutes, qa_max_failures`,
  );
  rejects(
    { colour: "red" },
    `${FILE}: colour: unknown key, expected one of limits, linear, slack, merge, agents`,
  );
  rejects(
    { limits: { budget_minutes: { L: 300 } } },
    `${FILE}: limits.budget_minutes.L: unknown key, expected one of S, M`,
  );
});

test("wrong types are rejected with their path", () => {
  rejects(
    { limits: { max_concurrent: 0 } },
    `${FILE}: limits.max_concurrent: expected an integer >= 1, got 0`,
  );
  rejects(
    { limits: { budget_minutes: { S: 1.5 } } },
    `${FILE}: limits.budget_minutes.S: expected an integer >= 1, got 1.5`,
  );
  rejects({ slack: "#x" }, `${FILE}: slack: expected a table, got "#x"`);
  rejects({ slack: { channel: "" } }, `${FILE}: slack.channel: expected a non-empty string`);
  rejects(
    { merge: { protected_paths: ["a", 3] } },
    `${FILE}: merge.protected_paths[1]: expected a string, got 3`,
  );
  rejects(
    { agents: { qa: { role: "tester" } } },
    `${FILE}: agents.qa.role: expected one of coordinator, backend, frontend, qa, got "tester"`,
  );
  rejects({ agents: { qa: [] } }, `${FILE}: agents.qa: expected a table, got an array`);
});

test("parseAgentSettings without a prefix reports bare keys", () => {
  assert.throws(
    () => parseAgentSettings({ harness: "vim" }, "agents/qa.md", "", false),
    /^ConfigError: agents\/qa\.md: harness: expected one of/,
  );
  assert.throws(
    () => parseAgentSettings({ instructions: "x" }, "agents/qa.md", "", false),
    /agents\/qa\.md: instructions: unknown key/,
  );
});
