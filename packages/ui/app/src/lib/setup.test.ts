import assert from "node:assert/strict";
import { test } from "node:test";
import type { Check } from "./checks.ts";
import { connectionCards, envFix, harnessSummary } from "./setup.ts";

const c = (id: string, state: Check["state"], detail = "", fix = ""): Check => ({
  id,
  state,
  detail,
  fix,
});

test("harnessSummary reads found, version, path, sign-in and a known-bad warning", () => {
  assert.deepEqual(
    harnessSummary("claude-code", [
      c("harness.claude-code.cli", "ok", "2.1.4 (Claude Code) (/opt/homebrew/bin/claude)"),
      c("harness.claude-code.auth", "ok", "signed in (claude.ai)"),
      c("harness.claude-code.version", "warn", "2.1.0 is known bad: drops tool calls", "Update it"),
    ]),
    {
      found: true,
      version: "2.1.4 (Claude Code)",
      path: "/opt/homebrew/bin/claude",
      signedIn: true,
      signIn: "signed in (claude.ai)",
      warning: "2.1.0 is known bad: drops tool calls",
      state: "warn",
    },
  );
  assert.deepEqual(
    harnessSummary("codex", [
      c("harness.codex.cli", "missing", "codex is not on PATH", "Install it"),
      c("harness.codex.auth", "missing", "not checked"),
      c("harness.codex.version", "missing", "not checked"),
    ]),
    {
      found: false,
      version: undefined,
      path: undefined,
      signedIn: false,
      signIn: "not checked",
      warning: undefined,
      state: "missing",
      reason: "codex is not on PATH",
    },
  );
});

test("connectionCards groups checks into GitHub, Linear, Slack, git, port and skills", () => {
  const cards = connectionCards([
    c("node", "ok"),
    c("harness.claude-code.cli", "ok"),
    c("github.cli", "ok"),
    c("github.auth", "fail", "not signed in", "Run: gh auth login"),
    c("linear.key", "missing", "LINEAR_API_KEY is not set", "Set LINEAR_API_KEY"),
    c("slack.webhook", "warn"),
    c("git.worktrees", "ok"),
    c("daemon.port", "ok"),
    c("skills.pack", "ok"),
  ]);
  assert.deepEqual(
    cards.map((k) => [k.id, k.title, k.state, k.checks.map((x) => x.id)]),
    [
      ["github", "GitHub", "fail", ["github.cli", "github.auth"]],
      ["linear", "Linear", "missing", ["linear.key"]],
      ["slack", "Slack", "warn", ["slack.webhook"]],
      ["git", "Git", "ok", ["git.worktrees"]],
      ["port", "Port", "ok", ["daemon.port"]],
      ["skills", "Skills", "ok", ["skills.pack"]],
    ],
  );
});

test("envFix says where to set a secret's variable, and never asks for its value", () => {
  assert.equal(
    envFix(c("linear.key", "missing")),
    "Set LINEAR_API_KEY in your shell profile (for example ~/.zprofile), then restart harnessd.",
  );
  assert.equal(
    envFix(c("slack.webhook", "warn")),
    "Set HARNESSD_SLACK_WEBHOOK_URL in your shell profile (for example ~/.zprofile), then restart harnessd.",
  );
  assert.equal(envFix(c("github.auth", "fail")), undefined);
});
