import assert from "node:assert/strict";
import { test } from "node:test";
import type { Check } from "./checks.ts";
import { mergeChecks } from "./secrets.ts";
import {
  blockingAreas,
  connectionCards,
  harnessSummary,
  isWaiting,
  secretFix,
  startState,
} from "./setup.ts";

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

test("secretFix points a secret's fix at the field in its card", () => {
  assert.equal(
    secretFix(
      c(
        "linear.key",
        "missing",
        "",
        "Paste a Linear personal API key in Settings, Connections, Linear.",
      ),
    ),
    "Paste a Linear personal API key in the field below.",
  );
  assert.equal(
    secretFix(
      c(
        "slack.webhook",
        "warn",
        "",
        "Create a Slack incoming webhook, then paste its url in Settings, Connections, Slack.",
      ),
    ),
    "Create a Slack incoming webhook, then paste its url in the field below.",
  );
  assert.equal(secretFix(c("github.auth", "fail", "", "Run gh auth login.")), undefined);
});

test("blockingAreas counts things to fix, not checks: a harness or a connection each count once", () => {
  assert.deepEqual(
    blockingAreas([
      c("node", "ok"),
      c("harness.claude-code.cli", "missing", "claude is not on PATH"),
      c("harness.claude-code.auth", "missing", "not checked"),
      c("harness.codex.auth", "fail"),
      c("linear.key", "missing"),
      c("linear.team", "missing", "not checked"),
      c("slack.webhook", "warn"),
    ]),
    ["Claude Code", "Codex", "Linear"],
  );
  assert.deepEqual(blockingAreas([c("config", "fail"), c("node", "fail")]), ["Config", "Node"]);
});

test("isWaiting marks a check that only waits on another one", () => {
  assert.equal(
    isWaiting(c("linear.team", "missing", "not checked", "Fix linear.key first.")),
    true,
  );
  assert.equal(isWaiting(c("linear.key", "missing", "LINEAR_API_KEY is not set")), false);
});

test("startState is ready only when the checks loaded, nothing blocks, and the daemon agrees", () => {
  const ok = [c("node", "ok")];
  assert.deepEqual(startState(undefined, { state: "setup", blocking: [] }), {
    ready: false,
    areas: [],
    loading: true,
  });
  assert.deepEqual(startState(ok, { state: "setup", blocking: [] }), {
    ready: true,
    areas: [],
    loading: false,
  });
  assert.deepEqual(startState(ok, { state: "setup", blocking: ["linear.key"] }), {
    ready: false,
    areas: ["Linear"],
    loading: false,
  });
  assert.deepEqual(
    startState([c("harness.codex.auth", "fail")], { state: "setup", blocking: ["linear.key"] }),
    {
      ready: false,
      areas: ["Codex", "Linear"],
      loading: false,
    },
  );
});

test("startState enables Start after a secret save, once the loop state is read again (MET-41)", () => {
  const before = [c("node", "ok"), c("linear.key", "missing", "LINEAR_API_KEY is not set")];
  const stale = { state: "setup" as const, blocking: ["linear.key"] };
  assert.equal(startState(before, stale).ready, false);
  // The save puts the re-run Linear checks in place.
  const after = mergeChecks(before, "linear.", [c("linear.key", "ok"), c("linear.team", "ok")]);
  // A stale loop state still names linear.key, so Start stays off.
  assert.deepEqual(startState(after, stale), { ready: false, areas: ["Linear"], loading: false });
  // The fresh loop state comes from the current checks, so Start enables.
  assert.deepEqual(startState(after, { state: "setup", blocking: [] }), {
    ready: true,
    areas: [],
    loading: false,
  });
});

test("harnessSummary keeps a failed worktree write check, with its reason and fix, and is not ready", () => {
  const s = harnessSummary("claude-code", [
    c("harness.claude-code.cli", "ok", "2.1.4 (Claude Code) (/opt/homebrew/bin/claude)"),
    c("harness.claude-code.auth", "ok", "signed in (claude.ai)"),
    c("harness.claude-code.version", "ok", "2.1.4"),
    c("harness.claude-code.worktree_write", "fail", "cannot write /w: EACCES", "Make /w writable"),
  ]);
  assert.equal(s.state, "fail");
  assert.deepEqual(s.worktreeWrite, { reason: "cannot write /w: EACCES", fix: "Make /w writable" });
  const ok = harnessSummary("claude-code", [
    c("harness.claude-code.cli", "ok", "1 (/x)"),
    c("harness.claude-code.worktree_write", "ok", "writable"),
  ]);
  assert.equal(ok.worktreeWrite, undefined);
});
