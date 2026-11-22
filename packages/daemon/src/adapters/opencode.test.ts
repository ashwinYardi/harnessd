import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { AdapterEvent, AdapterRun, Task } from "@harnessd/shared";
import { createOpenCodeAdapter, type OpenCodeOptions, openCodeArgs } from "./opencode.ts";

const FIXTURES = join(import.meta.dirname, "../../test/fixtures/opencode");
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "harnessd-opencode-")));
after(() => rmSync(scratch, { recursive: true, force: true }));

// The fake opencode: records its argv, cwd and env, prints one fixture, writes stderr, exits.
const FAKE = join(scratch, "opencode");
writeFileSync(
  FAKE,
  `#!/usr/bin/env node
const fs = require("node:fs");
const env = process.env;
if (env.FAKE_OC_RECORD) {
  const dir = env.OPENCODE_CONFIG_DIR;
  fs.writeFileSync(env.FAKE_OC_RECORD, JSON.stringify({
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    configDir: dir ?? null,
    configDirEntries: dir && fs.existsSync(dir) ? fs.readdirSync(dir) : null,
    disableClaudeCode: env.OPENCODE_DISABLE_CLAUDE_CODE ?? null,
    disableAutoupdate: env.OPENCODE_DISABLE_AUTOUPDATE ?? null,
    xdgConfig: env.XDG_CONFIG_HOME ?? null,
    xdgData: env.XDG_DATA_HOME ?? null,
    pwd: env.PWD ?? null,
  }));
}
if (env.FAKE_OC_FIXTURE) process.stdout.write(fs.readFileSync(env.FAKE_OC_FIXTURE, "utf8"));
if (env.FAKE_OC_STDERR) process.stderr.write(env.FAKE_OC_STDERR + "\\n");
if (env.FAKE_OC_HANG === "1") setInterval(() => {}, 1000);
else process.exitCode = Number(env.FAKE_OC_EXIT ?? "0");
`,
);
chmodSync(FAKE, 0o755);

const repo = join(scratch, "repo");
mkdirSync(repo);
execFileSync("git", ["init", "-q"], { cwd: repo });

function task(overrides: Partial<Task> = {}): Task {
  return { id: "MET-91", title: "OpenCode", prompt: "Say hi", budgetMs: 10_000, ...overrides };
}

interface Fake {
  fixture?: string;
  exit?: number;
  stderr?: string;
  hang?: boolean;
}

interface Record_ {
  argv: string[];
  cwd: string;
  configDir: string | null;
  configDirEntries: string[] | null;
  disableClaudeCode: string | null;
  disableAutoupdate: string | null;
  xdgConfig: string | null;
  xdgData: string | null;
  pwd: string | null;
}

function run(fake: Fake, t: Task = task(), options: OpenCodeOptions = {}) {
  const record = join(scratch, `record-${Math.random().toString(36).slice(2)}.json`);
  const env: Record<string, string> = { FAKE_OC_RECORD: record };
  if (fake.fixture) env.FAKE_OC_FIXTURE = join(FIXTURES, `${fake.fixture}.jsonl`);
  if (fake.exit !== undefined) env.FAKE_OC_EXIT = String(fake.exit);
  if (fake.stderr) env.FAKE_OC_STDERR = fake.stderr;
  if (fake.hang) env.FAKE_OC_HANG = "1";
  const adapter = createOpenCodeAdapter({ bin: FAKE, ...options, env: { ...env, ...options.env } });
  return { adapter, run: adapter.start(t, repo), record };
}

async function collect(r: AdapterRun): Promise<AdapterEvent[]> {
  const events: AdapterEvent[] = [];
  for await (const event of r.events) events.push(event);
  return events;
}

function readRecord(path: string): Record_ {
  return JSON.parse(readFileSync(path, "utf8"));
}

const BASE = ["run", "--format", "json", "--standalone", "--auto"];

test("openCodeArgs runs a standalone JSON run with --auto and ends flags with --", () => {
  assert.deepEqual(openCodeArgs(task()), [...BASE, "--", "Say hi"]);
});

test("openCodeArgs passes -m from the task, then the options, and omits it when unset", () => {
  assert.deepEqual(openCodeArgs(task({ model: "opencode-go/glm-5.3-flash" }), { model: "a/b" }), [
    ...BASE,
    "-m",
    "opencode-go/glm-5.3-flash",
    "--",
    "Say hi",
  ]);
  assert.deepEqual(openCodeArgs(task(), { model: "a/b" }), [...BASE, "-m", "a/b", "--", "Say hi"]);
  assert.ok(!openCodeArgs(task()).includes("-m"));
});

test("openCodeArgs keeps a #variant on the model, so the thinking level reaches OpenCode", () => {
  // OpenCode 2.x reads `provider/model#variant` in -m; there is no separate --variant flag.
  const argv = openCodeArgs(task({ model: "opencode-go/deepseek-v4.1-flash#high" }));
  assert.deepEqual(argv.slice(BASE.length), [
    "-m",
    "opencode-go/deepseek-v4.1-flash#high",
    "--",
    "Say hi",
  ]);
});

test("openCodeArgs never continues, resumes or forks a session", () => {
  const argv = openCodeArgs(task({ model: "a/b" }));
  for (const flag of ["--continue", "-c", "--session", "-s", "--fork"]) {
    assert.ok(!argv.includes(flag), flag);
  }
});

test("openCodeArgs keeps a prompt that starts with a dash after --", () => {
  assert.deepEqual(openCodeArgs(task({ prompt: "--help me" })).slice(-2), ["--", "--help me"]);
});

test("a real 2.0.20 run streams tool, usage and text, with cost and the session id", async () => {
  const { adapter, run: r, record } = run({ fixture: "success" });
  assert.equal(adapter.id, "opencode");
  const events = await collect(r);
  const result = await r.result;
  assert.deepEqual(
    events.map((e) => e.type),
    ["start", "tool", "usage", "text", "end"],
  );
  assert.deepEqual(events[1], { type: "tool", name: "read", summary: "/worktree/note.txt" });
  assert.deepEqual(events[2], {
    type: "usage",
    tokens: { input: 9821, output: 47, cacheRead: 512, cacheWrite: 0 },
    costUsd: 0.001502886,
  });
  assert.deepEqual(events[3], { type: "text", text: "hello" });
  assert.deepEqual(events.at(-1), { type: "end", result });
  assert.equal(result.status, "ok");
  assert.equal(result.exitCode, 0);
  assert.equal(result.sessionId, "ses_fake1");
  assert.equal(result.finalText, "hello");
  assert.equal(result.turns, 2);
  assert.equal(result.costUsd, 0.001502886);
  assert.equal(result.error, undefined);
  assert.equal(result.reason, undefined);

  const rec = readRecord(record);
  assert.deepEqual(rec.argv, openCodeArgs(task()));
  assert.equal(realpathSync(rec.cwd), repo);
  const start = events[0];
  assert.ok(start?.type === "start");
  assert.deepEqual(start.argv, [FAKE, ...rec.argv]);
});

test("a run whose last step prints no step_finish is still ok (OpenCode 2.0.20)", async () => {
  // 2.0.20 exits before it prints the last step_finish; a started step counts.
  const result = await run({ fixture: "text-only" }).run.result;
  assert.equal(result.status, "ok");
  assert.equal(result.finalText, "hi");
  assert.deepEqual(result.tokens, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.equal(result.costUsd, undefined);
});

test("the run gets an empty config dir and skips the owner's config, not XDG", async () => {
  const previous = { config: process.env.XDG_CONFIG_HOME, data: process.env.XDG_DATA_HOME };
  const { run: r, record } = run({ fixture: "success" }, task(), {
    env: { XDG_CONFIG_HOME: "/xdg/config", XDG_DATA_HOME: "/xdg/data" },
  });
  await r.result;
  const rec = readRecord(record);
  assert.ok(rec.configDir !== null && rec.configDir !== "");
  assert.deepEqual(rec.configDirEntries, []);
  assert.equal(rec.disableClaudeCode, "1");
  assert.equal(rec.disableAutoupdate, "1");
  // Auth lives in the data dir, and git and gh read XDG_CONFIG_HOME: both stay as given.
  assert.equal(rec.xdgConfig, "/xdg/config");
  assert.equal(rec.xdgData, "/xdg/data");
  assert.equal(process.env.XDG_CONFIG_HOME, previous.config);
  // The temp config dir is gone once the run ends.
  assert.equal(existsSync(rec.configDir ?? ""), false);
});

test("PWD is the worktree, because OpenCode reads PWD before the process cwd", async () => {
  const { run: r, record } = run({ fixture: "success" }, task(), { env: { PWD: "/elsewhere" } });
  await r.result;
  assert.equal(readRecord(record).pwd, repo);
});

test("each run gets its own config dir", async () => {
  const a = run({ fixture: "success" });
  const b = run({ fixture: "success" });
  await Promise.all([a.run.result, b.run.result]);
  assert.notEqual(readRecord(a.record).configDir, readRecord(b.record).configDir);
});

test("tool calls show once per call id, and usage keeps running totals and cost", async () => {
  const { run: r } = run({ fixture: "tools" });
  const events = await collect(r);
  const result = await r.result;
  const shown = events.filter((e) => e.type === "tool" || e.type === "usage");
  assert.deepEqual(shown, [
    { type: "tool", name: "bash", summary: "pnpm test" },
    { type: "tool", name: "edit", summary: "src/a.ts (error: oldString not found)" },
    {
      type: "usage",
      tokens: { input: 1200, output: 40, cacheRead: 200, cacheWrite: 50 },
      costUsd: 0.25,
    },
    { type: "tool", name: "harnessd-memory_search_notes", summary: "adapters" },
    {
      type: "usage",
      tokens: { input: 1700, output: 60, cacheRead: 500, cacheWrite: 50 },
      costUsd: 0.75,
    },
  ]);
  assert.equal(result.status, "ok");
  assert.deepEqual(result.tokens, { input: 1700, output: 60, cacheRead: 500, cacheWrite: 50 });
  assert.equal(result.costUsd, 0.75);
  assert.equal(result.finalText, "Tests pass.");
});

test("a step with no cost leaves costUsd unset", async () => {
  const { run: r } = run({ fixture: "no-cost" });
  const usage = (await collect(r)).find((e) => e.type === "usage");
  assert.deepEqual(usage, {
    type: "usage",
    tokens: { input: 100, output: 5, cacheRead: 0, cacheWrite: 0 },
  });
  assert.equal((await r.result).costUsd, undefined);
});

test("tool summaries stay on one line of at most 120 characters", async () => {
  const dir = mkdtempSync(join(scratch, "long-"));
  const fixture = join(dir, "long.jsonl");
  const command = `echo ${"x".repeat(300)}\nsecond line`;
  writeFileSync(
    fixture,
    `${JSON.stringify({ type: "tool_use", part: { id: "c", tool: "bash", state: { status: "completed", input: { command } } } })}\n`,
  );
  const r = createOpenCodeAdapter({ bin: FAKE, env: { FAKE_OC_FIXTURE: fixture } }).start(
    task(),
    repo,
  );
  const tool = (await collect(r)).find((e) => e.type === "tool");
  assert.ok(tool?.type === "tool");
  assert.equal(tool.summary.length, 120);
  assert.ok(!tool.summary.includes("\n"));
});

test("reasoning, unknown events and bad JSON become raw stdout logs", async () => {
  const { run: r } = run({ fixture: "unknown" });
  const events = await collect(r);
  const result = await r.result;
  const lines = readFileSync(join(FIXTURES, "unknown.jsonl"), "utf8").trim().split("\n");
  const logs = events.filter((e) => e.type === "log" && e.stream === "stdout");
  assert.deepEqual(
    logs.map((e) => (e.type === "log" ? e.line : "")),
    [lines[1], lines[2], lines[3], lines[4]],
  );
  assert.equal(result.status, "ok");
  assert.equal(result.finalText, "Still done.");
});

test("a quota error ends the run as limited, with the reset time from the message", async () => {
  const { run: r } = run({ fixture: "usage-limit", exit: 1 });
  const result = await r.result;
  assert.equal(result.status, "limited");
  assert.equal(result.reason, "usage_limit");
  assert.equal(result.resetAt, "2026-11-22T01:15:00.000Z");
  assert.match(result.error ?? "", /^usage limit reached: Monthly usage limit reached/);
});

test("a final rate-limit error is limited, with the reset from retryAfterMs", async () => {
  const started = Date.now();
  const result = await run({ fixture: "rate-limit", exit: 1 }).run.result;
  assert.equal(result.status, "limited");
  assert.equal(result.reason, "usage_limit");
  const reset = Date.parse(result.resetAt ?? "");
  assert.ok(reset >= started + 7_200_000 && reset <= Date.now() + 7_200_000);
});

test("an auth error ends the run as error with reason auth", async () => {
  const result = await run({ fixture: "auth", exit: 1 }).run.result;
  assert.equal(result.status, "error");
  assert.equal(result.reason, "auth");
  assert.equal(result.error, "not signed in: Invalid API key");
});

test("an error event fails the run even with exit code 0", async () => {
  const result = await run({ fixture: "no-route", exit: 0 }).run.result;
  assert.equal(result.status, "error");
  assert.equal(result.reason, undefined);
  assert.equal(result.error, "Model unavailable: opencode-go/no-such-model");
  assert.equal(result.sessionId, "ses_fake1");
});

test("stderr gives the reason when the run fails with no error event", async () => {
  const cases: Array<[string, string | undefined]> = [
    ["Error: 402 Payment Required: insufficient balance", "usage_limit"],
    ["AI_APICallError: 429 You exceeded your current quota, check your plan", "usage_limit"],
    ["Error: 401 Unauthorized", "auth"],
    ["Error: No API key found for provider deepseek", "auth"],
    ["Error: not logged in", "auth"],
    ["error: unexpected argument", undefined],
  ];
  for (const [stderr, reason] of cases) {
    const result = await run({ fixture: "empty", exit: 1, stderr }).run.result;
    assert.equal(result.reason, reason, stderr);
    assert.equal(result.status, reason === "usage_limit" ? "limited" : "error", stderr);
    assert.ok(result.error?.endsWith(stderr), stderr);
  }
});

test("a retried 429 that the run gets past is only a log line", async () => {
  const { run: r } = run({
    fixture: "success",
    stderr: "WARN 429 Too Many Requests, retrying in 2s",
  });
  const events = await collect(r);
  const result = await r.result;
  assert.equal(result.status, "ok");
  assert.equal(result.reason, undefined);
  assert.ok(events.some((e) => e.type === "log" && e.stream === "stderr"));
});

test("exit 0 with no step is not ok", async () => {
  const result = await run({ fixture: "empty", exit: 0 }).run.result;
  assert.equal(result.status, "error");
  assert.equal(result.error, "no step event");
});

test("a non-zero exit after good steps is not ok", async () => {
  const result = await run({ fixture: "success", exit: 3 }).run.result;
  assert.equal(result.status, "error");
  assert.equal(result.error, "exited with code 3");
});

test("HARNESSD_OPENCODE_BIN picks the binary when no bin option is given", async () => {
  const previous = process.env.HARNESSD_OPENCODE_BIN;
  process.env.HARNESSD_OPENCODE_BIN = FAKE;
  try {
    const r = createOpenCodeAdapter({
      env: { FAKE_OC_FIXTURE: join(FIXTURES, "success.jsonl") },
    }).start(task(), repo);
    assert.equal((await r.result).status, "ok");
  } finally {
    if (previous === undefined) delete process.env.HARNESSD_OPENCODE_BIN;
    else process.env.HARNESSD_OPENCODE_BIN = previous;
  }
});

test("a run over the turn cap is killed and reports turn cap", async () => {
  const started = Date.now();
  const { run: r } = run({ fixture: "success", hang: true }, task({ maxTurns: 1 }));
  const result = await r.result;
  assert.equal(result.status, "error");
  assert.equal(result.error, "turn cap (1 turns)");
  assert.equal(result.reason, undefined);
  // The run ended at the cap, not at its 10 s budget.
  assert.ok(Date.now() - started < 5_000);
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

test("cancel() stops the run, reports cancelled and removes the config dir", async () => {
  const { run: r, record } = run({ fixture: "success", hang: true }, task({ budgetMs: 30_000 }));
  for await (const event of r.events) {
    if (event.type === "text") await r.cancel();
  }
  assert.equal((await r.result).status, "cancelled");
  assert.equal(existsSync(readRecord(record).configDir ?? ""), false);
});

test("a missing binary is an error, not a throw", async () => {
  const before = readdirSync(tmpdir()).filter((n) => n.startsWith("harnessd-opencode-config-"));
  const r = createOpenCodeAdapter({ bin: join(scratch, "no-such-opencode") }).start(task(), repo);
  const result = await r.result;
  assert.equal(result.status, "error");
  assert.match(result.error ?? "", /ENOENT/);
  const left = readdirSync(tmpdir()).filter((n) => n.startsWith("harnessd-opencode-config-"));
  assert.deepEqual(left, before);
});

test("a cancelled Web Search input explains exit 1 after a step", async () => {
  const { run: r } = run({ fixture: "cancelled-input", exit: 1 });
  const events = await collect(r);
  assert.deepEqual(
    events.filter((event) => event.type === "log"),
    [{ type: "log", stream: "stdout", line: "Web Search request cancelled; the run goes on" }],
  );
  const result = await r.result;
  assert.equal(result.status, "ok");
  assert.equal(result.finalText, "Continued after cancellation.");
});

test("a provider auth error after cancelled input still fails the run", async () => {
  const { run: r } = run({ fixture: "cancelled-input-auth", exit: 1 });
  await collect(r);
  const result = await r.result;
  assert.equal(result.status, "error");
  assert.equal(result.reason, "auth");
});

test("a cancelled input without a step still fails the run", async () => {
  const { run: r } = run({ fixture: "cancelled-input-no-step", exit: 1 });
  await collect(r);
  assert.equal((await r.result).status, "error");
});

test("an auth failure on stderr can still explain a nonzero exit after cancelled input", async () => {
  const { run: r } = run({
    fixture: "cancelled-input",
    exit: 1,
    stderr: "Error: Invalid API key\nWarning: cleanup complete",
  });
  await collect(r);
  const result = await r.result;
  assert.equal(result.status, "error");
  assert.equal(result.reason, "auth");
});

test("an unclassified CLI error on stderr still fails after cancelled input", async () => {
  const { run: r } = run({
    fixture: "cancelled-input",
    exit: 1,
    stderr: "\x1b[91m\x1b[1mError: \x1b[0mconnection reset",
  });
  await collect(r);
  const result = await r.result;
  assert.equal(result.status, "error");
  assert.match(result.error ?? "", /connection reset/);
});
