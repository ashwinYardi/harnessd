import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { AdapterEvent, AdapterRun, Task } from "@harnessd/shared";
import { type CodexOptions, codexArgs, createCodexAdapter } from "./codex.ts";

const FIXTURES = join(import.meta.dirname, "../../test/fixtures/codex");
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "harnessd-codex-")));
after(() => rmSync(scratch, { recursive: true, force: true }));

// The fake codex: records its argv and cwd, prints one fixture, writes stderr, exits with a code.
const FAKE = join(scratch, "codex");
writeFileSync(
  FAKE,
  `#!/usr/bin/env node
const fs = require("node:fs");
const env = process.env;
if (env.FAKE_CODEX_RECORD) {
  fs.writeFileSync(env.FAKE_CODEX_RECORD, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));
}
if (env.FAKE_CODEX_FIXTURE) process.stdout.write(fs.readFileSync(env.FAKE_CODEX_FIXTURE, "utf8"));
if (env.FAKE_CODEX_STDERR) process.stderr.write(env.FAKE_CODEX_STDERR + "\\n");
if (env.FAKE_CODEX_HANG === "1") setInterval(() => {}, 1000);
else process.exitCode = Number(env.FAKE_CODEX_EXIT ?? "0");
`,
);
chmodSync(FAKE, 0o755);

// The worktree is a git repo, as in a real run.
const repo = join(scratch, "repo");
mkdirSync(repo);
execFileSync("git", ["init", "-q"], { cwd: repo });

function task(overrides: Partial<Task> = {}): Task {
  return { id: "MET-75", title: "Codex", prompt: "Say hi", budgetMs: 10_000, ...overrides };
}

interface Fake {
  fixture?: string;
  exit?: number;
  stderr?: string;
  hang?: boolean;
}

function run(fake: Fake, t: Task = task(), options: CodexOptions = {}) {
  const record = join(scratch, `record-${Math.random().toString(36).slice(2)}.json`);
  const env: Record<string, string> = { FAKE_CODEX_RECORD: record };
  if (fake.fixture) env.FAKE_CODEX_FIXTURE = join(FIXTURES, `${fake.fixture}.jsonl`);
  if (fake.exit !== undefined) env.FAKE_CODEX_EXIT = String(fake.exit);
  if (fake.stderr) env.FAKE_CODEX_STDERR = fake.stderr;
  if (fake.hang) env.FAKE_CODEX_HANG = "1";
  const adapter = createCodexAdapter({ bin: FAKE, ...options, env: { ...env, ...options.env } });
  return { adapter, run: adapter.start(t, repo), record };
}

async function collect(r: AdapterRun): Promise<AdapterEvent[]> {
  const events: AdapterEvent[] = [];
  for await (const event of r.events) events.push(event);
  return events;
}

function readRecord(path: string): { argv: string[]; cwd: string } {
  return JSON.parse(readFileSync(path, "utf8"));
}

const BASE = [
  "exec",
  "--json",
  "--ignore-user-config",
  "--ignore-rules",
  "--dangerously-bypass-hook-trust",
  "--sandbox",
  "danger-full-access",
  "-c",
  'approval_policy="never"',
  "-c",
  "tool_output_token_limit=5000",
];

test("codexArgs runs exec --json with full access and no approvals", () => {
  assert.deepEqual(codexArgs(task(), {}, repo), [...BASE, "--", "Say hi"]);
});

test("a resumed run uses exec resume and keeps every isolation flag", () => {
  const argv = codexArgs(task({ resumeSessionId: "thread-1" }), {}, repo);
  assert.deepEqual(argv, [
    "exec",
    "resume",
    "thread-1",
    "--json",
    "--ignore-user-config",
    "--ignore-rules",
    "--dangerously-bypass-hook-trust",
    // `codex exec resume` on 0.171.0 refuses --sandbox, so the same setting is a -c override.
    "-c",
    'sandbox_mode="danger-full-access"',
    "-c",
    'approval_policy="never"',
    "-c",
    "tool_output_token_limit=5000",
    "--",
    "Say hi",
  ]);
  assert.ok(!argv.includes("--sandbox"), "the subcommand refuses it");
  assert.equal(createCodexAdapter().canResume, true);
});

test("a readOnly task gets --sandbox read-only and keeps every isolation flag (MET-219)", () => {
  const argv = codexArgs(task({ readOnly: true }), {}, repo);
  assert.equal(argv[argv.indexOf("--sandbox") + 1], "read-only");
  assert.ok(!argv.includes("danger-full-access"));
  for (const flag of [
    "--ignore-user-config",
    "--ignore-rules",
    "--dangerously-bypass-hook-trust",
  ]) {
    assert.ok(argv.includes(flag), flag);
  }
  assert.ok(argv.includes('approval_policy="never"'));
  assert.ok(argv.includes("tool_output_token_limit=5000"));
  assert.deepEqual(argv.slice(-2), ["--", "Say hi"]);
});

test("a readOnly resume sets sandbox_mode read-only through -c", () => {
  const argv = codexArgs(task({ readOnly: true, resumeSessionId: "thread-1" }), {}, repo);
  assert.ok(argv.includes('sandbox_mode="read-only"'));
  assert.ok(!argv.includes("--sandbox"), "the subcommand refuses it");
  assert.ok(!argv.includes('sandbox_mode="danger-full-access"'));
});

test("readOnly: false keeps today's danger-full-access argv", () => {
  assert.deepEqual(codexArgs(task({ readOnly: false }), {}, repo), [...BASE, "--", "Say hi"]);
});

test("codexArgs passes --model from the task, then the options, and omits it when unset", () => {
  const tail = (argv: string[]) => argv.slice(BASE.length);
  assert.deepEqual(tail(codexArgs(task({ model: "gpt-5.5" }), { model: "o3" }, repo)), [
    "--model",
    "gpt-5.5",
    "--",
    "Say hi",
  ]);
  assert.deepEqual(tail(codexArgs(task(), { model: "o3" }, repo)), [
    "--model",
    "o3",
    "--",
    "Say hi",
  ]);
  assert.ok(!codexArgs(task(), {}, repo).includes("--model"));
});

test("codexArgs never persists trust or uses the bypass-all flag", () => {
  const argv = codexArgs(task({ model: "m" }), {}, repo);
  for (const flag of ["--trust", "--dangerously-bypass-approvals-and-sandbox", "--add-dir"]) {
    assert.ok(!argv.includes(flag), flag);
  }
});

test("codexArgs keeps a prompt that starts with a dash after --", () => {
  const argv = codexArgs(task({ prompt: "--help me" }), {}, repo);
  assert.deepEqual(argv.slice(-2), ["--", "--help me"]);
});

test("codexArgs passes the synced .codex/config.toml MCP servers as -c overrides", () => {
  // Codex ignores project config in an untrusted worktree, so the adapter passes it.
  const dir = mkdtempSync(join(scratch, "mcp-"));
  mkdirSync(join(dir, ".codex"));
  writeFileSync(
    join(dir, ".codex", "config.toml"),
    [
      "# generated",
      "",
      "[mcp_servers.harnessd-memory]",
      'command = "node"',
      'args = ["server.js", "--vault", "a \\"b\\""]',
      'env = { VAULT = "/v", "odd key" = "x" }',
      "",
    ].join("\n"),
  );
  const argv = codexArgs(task(), {}, dir);
  const at = argv.indexOf("--");
  assert.deepEqual(argv.slice(at - 2, at), [
    "-c",
    'mcp_servers.harnessd-memory={ command = "node", args = ["server.js", "--vault", "a \\"b\\""], env = { VAULT = "/v", "odd key" = "x" } }',
  ]);
});

test("a success run streams text and usage, and keeps the thread id", async () => {
  const { adapter, run: r, record } = run({ fixture: "success" });
  assert.equal(adapter.id, "codex");
  const events = await collect(r);
  const result = await r.result;
  assert.deepEqual(
    events.map((e) => e.type),
    ["start", "text", "text", "usage", "end"],
  );
  assert.deepEqual(events[1], { type: "text", text: "Looking at the code." });
  assert.deepEqual(events[3], {
    type: "usage",
    tokens: { input: 200, output: 40, cacheRead: 1000, cacheWrite: 0 },
  });
  assert.deepEqual(events.at(-1), { type: "end", result });
  assert.equal(result.status, "ok");
  assert.equal(result.exitCode, 0);
  assert.equal(result.sessionId, "thread-fake-1");
  assert.equal(result.finalText, "Done.");
  // D-045: turns count completed tool items, so a text-only run reports none.
  assert.equal(result.turns, undefined);
  assert.equal(result.costUsd, undefined);
  assert.equal(result.error, undefined);
  assert.equal(result.reason, undefined);

  const { argv, cwd } = readRecord(record);
  assert.deepEqual(argv, codexArgs(task(), {}, repo));
  assert.equal(realpathSync(cwd), repo);
  const start = events[0];
  assert.ok(start?.type === "start");
  assert.deepEqual(start.argv, [FAKE, ...argv]);
  assert.equal(start.cwd, repo);
});

test("tool calls, file edits and usage totals map to tool and usage events", async () => {
  const { run: r } = run({ fixture: "tools" });
  const events = await collect(r);
  const result = await r.result;
  const shown = events.filter((e) => e.type === "tool" || e.type === "usage");
  assert.deepEqual(shown, [
    { type: "tool", name: "shell", summary: "bash -lc 'pnpm test'" },
    { type: "tool", name: "shell", summary: "bash -lc 'pnpm test' (exit 0)" },
    { type: "tool", name: "edit", summary: "src/a.ts, src/b.ts" },
    { type: "tool", name: "harnessd-memory.search_notes", summary: '{"query":"adapters"}' },
    { type: "tool", name: "web_search", summary: "codex exec json events" },
    { type: "tool", name: "todo", summary: "1/2 done: Write the test; Make it pass" },
    { type: "usage", tokens: { input: 400, output: 20, cacheRead: 100, cacheWrite: 0 } },
    { type: "usage", tokens: { input: 500, output: 30, cacheRead: 300, cacheWrite: 0 } },
  ]);
  assert.equal(result.status, "ok");
  assert.deepEqual(result.tokens, { input: 500, output: 30, cacheRead: 300, cacheWrite: 0 });
  assert.equal(result.finalText, "Tests pass.");
  // Four completed tool items: command, file change, MCP call and web search. A todo is not one.
  assert.equal(result.turns, 4);
});

test("a recorded 0.171.0 stream reports its exact usage totals", async () => {
  const { run: r } = run({ fixture: "recorded-0.171.0" });
  const events = await collect(r);
  const result = await r.result;
  // D-032: input excludes cached tokens, cached tokens are reported apart, cacheWrite is 0.
  assert.deepEqual(
    events.filter((e) => e.type === "usage"),
    [{ type: "usage", tokens: { input: 11_591, output: 39, cacheRead: 27_904, cacheWrite: 0 } }],
  );
  assert.deepEqual(result.tokens, {
    input: 11_591,
    output: 39,
    cacheRead: 27_904,
    cacheWrite: 0,
  });
  assert.equal(result.status, "ok");
  // One completed command item is one turn (D-045).
  assert.equal(result.turns, 1);
  assert.equal(result.usageUnknown, undefined);
});

test("a stream cut before turn.completed marks usage unknown and keeps the tool turns", async () => {
  const { run: r } = run({ fixture: "recorded-0.171.0-cut" });
  const events = await collect(r);
  const result = await r.result;
  assert.deepEqual(
    events.filter((e) => e.type === "usage"),
    [],
    "a killed run sends no usage event",
  );
  assert.deepEqual(result.tokens, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.equal(result.usageUnknown, true);
  assert.equal(result.turns, 1);
  assert.equal(result.status, "error");
  assert.equal(result.error, "no turn.completed event");
});

test("a run over the turn cap is killed and reports turn cap", async () => {
  const started = Date.now();
  const { run: r } = run({ fixture: "tools", hang: true }, task({ maxTurns: 2 }));
  const result = await r.result;
  assert.equal(result.status, "error");
  assert.equal(result.error, "turn cap (2 turns)");
  assert.equal(result.reason, "turn_cap");
  // The run ended at the cap, not at its 10 s budget.
  assert.ok(Date.now() - started < 5_000);
});

test("tool summaries stay on one line of at most 120 characters", async () => {
  const dir = mkdtempSync(join(scratch, "long-"));
  const fixture = join(dir, "long.jsonl");
  const command = `echo ${"x".repeat(300)}\nsecond line`;
  writeFileSync(
    fixture,
    `${JSON.stringify({ type: "item.started", item: { id: "i", type: "command_execution", command } })}\n`,
  );
  const r = createCodexAdapter({ bin: FAKE, env: { FAKE_CODEX_FIXTURE: fixture } }).start(
    task(),
    repo,
  );
  const tool = (await collect(r)).find((e) => e.type === "tool");
  assert.ok(tool?.type === "tool");
  assert.equal(tool.summary.length, 120);
  assert.ok(!tool.summary.includes("\n"));
});

test("reasoning, unknown events, warnings and bad JSON become raw stdout logs", async () => {
  const { run: r } = run({ fixture: "unknown" });
  const events = await collect(r);
  const result = await r.result;
  const lines = readFileSync(join(FIXTURES, "unknown.jsonl"), "utf8").trim().split("\n");
  const logs = events.filter((e) => e.type === "log" && e.stream === "stdout");
  assert.deepEqual(
    logs.map((e) => (e.type === "log" ? e.line : "")),
    [lines[1], lines[3], lines[4], lines[5], lines[6], lines[7], lines[8]],
  );
  // A reconnect notice and an item warning do not fail a run that completes its turn.
  assert.equal(result.status, "ok");
  assert.equal(result.finalText, "Still done.");
});

test("a usage limit ends the run as limited with a reset time", async () => {
  const started = Date.now();
  const { run: r } = run({ fixture: "usage-limit", exit: 1 });
  const result = await r.result;
  assert.equal(result.status, "limited");
  const reset = Date.parse(result.resetAt ?? "");
  assert.ok(reset >= started + 7_200_000 && reset <= Date.now() + 7_200_000);
  assert.equal(result.reason, "usage_limit");
  assert.equal(
    result.error,
    "usage limit reached: You've hit your usage limit. Try again in 2 hours.",
  );
});

test("a terminal rate limit on stderr ends the run as limited", async () => {
  const result = await run({
    fixture: "empty",
    exit: 1,
    stderr: "Error: HTTP 429 Too Many Requests",
  }).run.result;
  assert.equal(result.status, "limited");
  assert.equal(result.resetAt, undefined);
});

test("a dated Codex retry time is preserved as an ISO timestamp", async () => {
  const result = await run({
    fixture: "empty",
    exit: 1,
    stderr: "You've hit your usage limit. Try again at 2026-11-22T01:15:00Z.",
  }).run.result;
  assert.equal(result.status, "limited");
  assert.equal(result.resetAt, "2026-11-22T01:15:00.000Z");
});

test("an auth failure ends with a clear error and reason auth", async () => {
  // Codex can exit 0 after a failed turn; the turn.failed still makes the run an error.
  const { run: r } = run({ fixture: "auth", exit: 0 });
  const result = await r.result;
  assert.equal(result.status, "error");
  assert.equal(result.reason, "auth");
  assert.match(result.error ?? "", /^not signed in: unexpected status 401 Unauthorized/);
});

test("any other failed turn keeps its message and sets no reason", async () => {
  const { run: r } = run({ fixture: "failed", exit: 1 });
  const result = await r.result;
  assert.equal(result.status, "error");
  assert.equal(result.error, "stream closed before response.completed");
  assert.equal(result.reason, undefined);
});

test("a non-zero exit with no events reads the reason from stderr", async () => {
  const auth = await run({
    fixture: "empty",
    exit: 1,
    stderr: "Error: Not logged in. Run codex login.",
  }).run.result;
  assert.equal(auth.status, "error");
  assert.equal(auth.reason, "auth");
  assert.equal(auth.error, "not signed in: Error: Not logged in. Run codex login.");

  const other = await run({ fixture: "empty", exit: 2, stderr: "error: unexpected argument" }).run
    .result;
  assert.equal(other.status, "error");
  assert.equal(other.reason, undefined);
  assert.equal(other.error, "error: unexpected argument");
});

test("exit 0 with no completed turn is not ok", async () => {
  const result = await run({ fixture: "empty", exit: 0 }).run.result;
  assert.equal(result.status, "error");
  assert.equal(result.error, "no turn.completed event");
});

test("HARNESSD_CODEX_BIN picks the binary when no bin option is given", async () => {
  const previous = process.env.HARNESSD_CODEX_BIN;
  process.env.HARNESSD_CODEX_BIN = FAKE;
  try {
    const r = createCodexAdapter({
      env: { FAKE_CODEX_FIXTURE: join(FIXTURES, "success.jsonl") },
    }).start(task(), repo);
    assert.equal((await r.result).status, "ok");
  } finally {
    if (previous === undefined) delete process.env.HARNESSD_CODEX_BIN;
    else process.env.HARNESSD_CODEX_BIN = previous;
  }
});

test("the budget timeout kills the run and reports timeout", async () => {
  const { run: r } = run({ fixture: "success", hang: true }, task({ budgetMs: 500 }), {
    killGraceMs: 500,
  });
  const result = await r.result;
  assert.equal(result.status, "timeout");
  assert.equal(result.error, "budget of 500ms exceeded");
  assert.equal(result.reason, undefined);
});

test("cancel() stops the run and reports cancelled", async () => {
  const { run: r } = run({ fixture: "success", hang: true }, task({ budgetMs: 30_000 }));
  for await (const event of r.events) {
    if (event.type === "text") await r.cancel();
  }
  assert.equal((await r.result).status, "cancelled");
});

test("a missing binary is an error, not a throw", async () => {
  const r = createCodexAdapter({ bin: join(scratch, "no-such-codex") }).start(task(), repo);
  const result = await r.result;
  assert.equal(result.status, "error");
  assert.match(result.error ?? "", /ENOENT/);
});
