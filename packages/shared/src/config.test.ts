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
    qa: { setup_command: "", test_command: "make test" },
    daemon: { port: 4800 },
    agents: {
      backend: {
        role: "backend",
        harness: "codex",
        model: "gpt-5",
        avatar: "avatars/backend.png",
        instructions: "Hi",
      },
    },
    mcp: {
      docs: { command: "npx", args: ["-y", "docs-mcp"], env: { TOKEN: "", MODE: "ro" } },
      bare: { command: "bare-mcp" },
    },
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
    `${FILE}: colour: unknown key, expected one of limits, linear, slack, merge, qa, daemon, agents, mcp`,
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
  rejects(
    { daemon: { port: 70_000 } },
    `${FILE}: daemon.port: expected a port from 0 to 65535, got 70000`,
  );
  rejects(
    { daemon: { port: "80" } },
    `${FILE}: daemon.port: expected a port from 0 to 65535, got "80"`,
  );
  rejects({ slack: "#x" }, `${FILE}: slack: expected a table, got "#x"`);
  rejects({ qa: { test_command: "" } }, `${FILE}: qa.test_command: expected a non-empty string`);
  rejects({ qa: { setup_command: 1 } }, `${FILE}: qa.setup_command: expected a string, got 1`);
  rejects(
    { qa: { command: "x" } },
    `${FILE}: qa.command: unknown key, expected one of setup_command, test_command`,
  );
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

test("an agent avatar must be a non-empty string", () => {
  rejects(
    { agents: { qa: { avatar: "" } } },
    `${FILE}: agents.qa.avatar: expected a non-empty string`,
  );
  rejects({ agents: { qa: { avatar: 3 } } }, `${FILE}: agents.qa.avatar: expected a string, got 3`);
  assert.deepEqual(parseAgentSettings({ avatar: "qa.png" }, "agents/qa.md", "", false), {
    avatar: "qa.png",
  });
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

test("mcp servers are validated with their path", () => {
  rejects({ mcp: { docs: {} } }, `${FILE}: mcp.docs.command: required`);
  rejects(
    { mcp: { docs: { command: "x", cwd: "/" } } },
    `${FILE}: mcp.docs.cwd: unknown key, expected one of command, args, env`,
  );
  rejects(
    { mcp: { docs: { command: "x", args: "a b" } } },
    `${FILE}: mcp.docs.args: expected an array of strings, got "a b"`,
  );
  rejects(
    { mcp: { docs: { command: "x", env: { PORT: 80 } } } },
    `${FILE}: mcp.docs.env.PORT: expected a string, got 80`,
  );
  rejects(
    { mcp: { "my docs": { command: "x" } } },
    `${FILE}: mcp.my docs: server names may only use letters, digits, _ and -`,
  );
  rejects({ mcp: [] }, `${FILE}: mcp: expected a table, got an array`);
});
