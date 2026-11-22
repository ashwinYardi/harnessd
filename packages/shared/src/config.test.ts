import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ConfigError,
  DEFAULT_SETTINGS,
  HARNESSES,
  parseAgentSettings,
  parseConfigFile,
} from "./index.ts";

const FILE = "~/.harnessd/config.toml";

function rejects(value: unknown, message: string) {
  assert.throws(
    () => parseConfigFile(value, FILE),
    (e: unknown) => e instanceof ConfigError && e.message === message,
  );
}

test("parseConfigFile accepts a full config", () => {
  const input = {
    limits: {
      max_concurrent: 5,
      budget_minutes: { S: 20, M: 90 },
      token_budget: { S: 1_000_000, M: 2_000_000 },
      cached_token_weight: 0.25,
      qa_max_failures: 1,
    },
    linear: { team_id: "MET", project: "harnessd" },
    slack: { channel: "#ops", summary_time: "18:30", time_zone: "Europe/Berlin" },
    merge: { protected_paths: ["infra/**"], label: "hold", method: "rebase" },
    qa: { setup_command: "", test_command: "make test" },
    daemon: { port: 4800, self_update: false },
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

test("fallback_harness and fallback_model parse on an agent", () => {
  const input = {
    agents: {
      backend: { harness: "claude-code", fallback_harness: "codex", fallback_model: "gpt-5" },
    },
  };
  assert.deepEqual(parseConfigFile(input, FILE), input);
  assert.deepEqual(
    parseAgentSettings(
      { fallback_harness: "codex", fallback_model: "gpt-5" },
      "agents/qa.md",
      "",
      false,
    ),
    { fallback_harness: "codex", fallback_model: "gpt-5" },
  );
});

test("an unknown fallback_harness names the file and key", () => {
  rejects(
    { agents: { backend: { fallback_harness: "vim" } } },
    `${FILE}: agents.backend.fallback_harness: expected one of claude-code, codex, antigravity, opencode, cursor, grok, got "vim"`,
  );
  rejects(
    { agents: { backend: { fallback_model: 5 } } },
    `${FILE}: agents.backend.fallback_model: expected a string, got 5`,
  );
});

test("unknown keys are rejected with their path", () => {
  rejects(
    { limits: { max_concurent: 2 } },
    `${FILE}: limits.max_concurent: unknown key, expected one of max_concurrent, budget_minutes, token_budget, cached_token_weight, qa_max_failures`,
  );
  rejects(
    { colour: "red" },
    `${FILE}: colour: unknown key, expected one of limits, linear, slack, merge, qa, daemon, harnesses, secrets, agents, mcp, skills`,
  );
  rejects(
    { limits: { budget_minutes: { L: 300 } } },
    `${FILE}: limits.budget_minutes.L: unknown key, expected one of S, M`,
  );
});

test("limits.token_budget accepts S and M and rejects another key", () => {
  assert.deepEqual(parseConfigFile({ limits: { token_budget: { S: 10, M: 20 } } }, FILE), {
    limits: { token_budget: { S: 10, M: 20 } },
  });
  rejects(
    { limits: { token_budget: { L: 300 } } },
    `${FILE}: limits.token_budget.L: unknown key, expected one of S, M`,
  );
});

test("limits.cached_token_weight defaults to 0.1 and takes 0 to 1", () => {
  assert.equal(DEFAULT_SETTINGS.limits.cached_token_weight, 0.1);
  assert.deepEqual(parseConfigFile({ limits: { cached_token_weight: 0 } }, FILE), {
    limits: { cached_token_weight: 0 },
  });
  assert.deepEqual(parseConfigFile({ limits: { cached_token_weight: 1 } }, FILE), {
    limits: { cached_token_weight: 1 },
  });
  rejects(
    { limits: { cached_token_weight: 1.1 } },
    `${FILE}: limits.cached_token_weight: expected a number from 0 to 1, got 1.1`,
  );
  rejects(
    { limits: { cached_token_weight: -0.1 } },
    `${FILE}: limits.cached_token_weight: expected a number from 0 to 1, got -0.1`,
  );
  rejects(
    { limits: { cached_token_weight: "0.1" } },
    `${FILE}: limits.cached_token_weight: expected a number from 0 to 1, got "0.1"`,
  );
});

test("the token budget defaults are weighted tokens for one M build", () => {
  assert.deepEqual(DEFAULT_SETTINGS.limits.token_budget, { S: 3_000_000, M: 6_000_000 });
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
    { limits: { token_budget: { M: 0 } } },
    `${FILE}: limits.token_budget.M: expected an integer >= 1, got 0`,
  );
  rejects(
    { daemon: { port: 70_000 } },
    `${FILE}: daemon.port: expected a port from 0 to 65535, got 70000`,
  );
  rejects(
    { daemon: { port: "80" } },
    `${FILE}: daemon.port: expected a port from 0 to 65535, got "80"`,
  );
  rejects(
    { daemon: { self_update: "no" } },
    `${FILE}: daemon.self_update: expected true or false, got "no"`,
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
    { slack: { summary_time: "9pm" } },
    `${FILE}: slack.summary_time: expected a 24-hour time "HH:MM", got "9pm"`,
  );
  rejects(
    { slack: { summary_time: "24:00" } },
    `${FILE}: slack.summary_time: expected a 24-hour time "HH:MM", got "24:00"`,
  );
  rejects(
    { slack: { time_zone: "Mars/Olympus" } },
    `${FILE}: slack.time_zone: expected an IANA time zone such as "Asia/Kolkata", got "Mars/Olympus"`,
  );
  rejects(
    { slack: { webhook_url: "https://hooks.slack.com/x" } },
    `${FILE}: slack.webhook_url: unknown key, expected one of channel, summary_time, time_zone`,
  );
  rejects(
    { merge: { protected_paths: ["a", 3] } },
    `${FILE}: merge.protected_paths[1]: expected a string, got 3`,
  );
  rejects({ merge: { label: "" } }, `${FILE}: merge.label: expected a non-empty string`);
  rejects(
    { merge: { method: "fast-forward" } },
    `${FILE}: merge.method: expected one of squash, merge, rebase, got "fast-forward"`,
  );
  rejects(
    { merge: { labels: ["x"] } },
    `${FILE}: merge.labels: unknown key, expected one of protected_paths, label, method`,
  );
  rejects(
    { agents: { qa: { role: "tester" } } },
    `${FILE}: agents.qa.role: expected one of coordinator, backend, frontend, qa, got "tester"`,
  );
  rejects({ agents: { qa: [] } }, `${FILE}: agents.qa: expected a table, got an array`);
});

test("the merge gate defaults cover every D-013 protected area", () => {
  const { merge } = DEFAULT_SETTINGS;
  assert.equal(merge.label, "needs-human");
  assert.equal(merge.method, "squash");
  for (const glob of [
    "**/auth/**",
    "**/payments/**",
    "**/*secret*",
    "**/.env",
    ".github/workflows/**",
    "docs/RELEASING.md",
    ".harnessd/config.toml",
    "**/CODEOWNERS",
  ]) {
    assert.ok(merge.protected_paths.includes(glob), glob);
  }
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

test("skill tables take enabled, upstream, commit and version", () => {
  const skills = {
    tdd: { upstream: "mattpocock/skills", commit: "abeeaf95660ba9e8b7c753eb38f441ca707a8823" },
    impeccable: { upstream: "pbakaus/impeccable", commit: "b49177d", version: "4.10.0" },
    research: { enabled: false },
  };
  assert.deepEqual(parseConfigFile({ skills }, FILE), { skills });
  rejects(
    { skills: { tdd: { enabled: "no" } } },
    `${FILE}: skills.tdd.enabled: expected true or false, got "no"`,
  );
  rejects(
    { skills: { tdd: { pin: "x" } } },
    `${FILE}: skills.tdd.pin: unknown key, expected one of enabled, upstream, commit, version`,
  );
  rejects(
    { skills: { tdd: { commit: "" } } },
    `${FILE}: skills.tdd.commit: expected a non-empty string`,
  );
});

test("parseConfigFile reads [harnesses.<id>] bin, and only for known harnesses", () => {
  assert.deepEqual(
    parseConfigFile({ harnesses: { "claude-code": { bin: "/opt/bin/claude" } } }, FILE).harnesses,
    { "claude-code": { bin: "/opt/bin/claude" } },
  );
  rejects(
    { harnesses: { cursorx: { bin: "/x" } } },
    `${FILE}: harnesses.cursorx: unknown key, expected one of ${HARNESSES.join(", ")}`,
  );
  rejects(
    { harnesses: { codex: { bin: "codex" } } },
    `${FILE}: harnesses.codex.bin: expected an absolute path`,
  );
  assert.deepEqual(DEFAULT_SETTINGS.harnesses, {});
});

test("parseConfigFile reads [secrets.<service>] references, never a value (MET-33)", () => {
  assert.deepEqual(
    parseConfigFile(
      {
        secrets: {
          linear: { api_key: "op://Private/Linear/credential" },
          slack: { webhook_url: "env:MY_SLACK_HOOK" },
        },
      },
      FILE,
    ).secrets,
    {
      linear: { api_key: "op://Private/Linear/credential" },
      slack: { webhook_url: "env:MY_SLACK_HOOK" },
    },
  );
  assert.deepEqual(
    parseConfigFile({ secrets: { linear: { api_key: "op://v/item/section/field" } } }, FILE)
      .secrets,
    { linear: { api_key: "op://v/item/section/field" } },
  );
  rejects(
    { secrets: { github: { token: "env:GH" } } },
    `${FILE}: secrets.github: unknown key, expected one of linear, slack`,
  );
  rejects(
    { secrets: { linear: { token: "env:GH" } } },
    `${FILE}: secrets.linear.token: unknown key, expected one of api_key`,
  );
  // A value in config.toml is refused, and the error never repeats it.
  for (const value of ["lin_api_supersecret123", "op://only-vault", "env:1BAD", "env:A B"]) {
    assert.throws(
      () => parseConfigFile({ secrets: { linear: { api_key: value } } }, FILE),
      (e: unknown) =>
        e instanceof ConfigError &&
        !e.message.includes(value) &&
        e.message ===
          `${FILE}: secrets.linear.api_key: expected a reference such as "op://vault/item/field" or "env:NAME"; save a value in Settings, Connections`,
    );
  }
  assert.throws(
    () => parseConfigFile({ secrets: { linear: { api_key: 42 } } }, FILE),
    (e: unknown) => e instanceof ConfigError && /expected a reference/.test(e.message),
  );
});

test("self-update defaults to on and requires a boolean", () => {
  assert.equal(DEFAULT_SETTINGS.daemon.self_update, true);
  rejects(
    { daemon: { self_update: "false" } },
    `${FILE}: daemon.self_update: expected true or false, got "false"`,
  );
});
