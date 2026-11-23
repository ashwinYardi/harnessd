import assert from "node:assert/strict";
import {
  existsSync,
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
import {
  type ClaudeCodeOptions,
  classifyLimit,
  claudeArgs,
  createClaudeCodeAdapter,
  NO_MCP_SERVERS,
  parseResetAt,
  summarizeInput,
} from "./claude-code.ts";
import { killAllLiveRuns } from "./process.ts";

const FAKE = join(import.meta.dirname, "../../test/fixtures/fake-claude.mjs");
const scratch = mkdtempSync(join(tmpdir(), "harnessd-claude-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

function task(overrides: Partial<Task> = {}): Task {
  return { id: "MET-8", title: "Adapter", prompt: "Say hi", budgetMs: 10_000, ...overrides };
}

function run(mode: string, t: Task = task(), options: ClaudeCodeOptions = {}) {
  const record = join(scratch, `${mode}-${Math.random().toString(36).slice(2)}.json`);
  const adapter = createClaudeCodeAdapter({
    bin: FAKE,
    ...options,
    env: { FAKE_CLAUDE_MODE: mode, FAKE_CLAUDE_RECORD: record, ...options.env },
  });
  return { adapter, run: adapter.start(t, scratch), record };
}

async function collect(r: AdapterRun): Promise<AdapterEvent[]> {
  const events: AdapterEvent[] = [];
  for await (const event of r.events) events.push(event);
  return events;
}

function readRecord(path: string): {
  argv: string[];
  cwd: string;
  grandchildPid?: number;
  probe?: string;
  bashMaxOutput?: string;
} {
  return JSON.parse(readFileSync(path, "utf8"));
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  // An unreaped zombie still answers signal 0; on Linux /proc tells them apart.
  // The entry can vanish between checks once the process is reaped, which means dead.
  const stat = `/proc/${pid}/stat`;
  if (!existsSync("/proc/self/stat")) return true;
  try {
    return !/^\d+ \(.*\) Z/.test(readFileSync(stat, "utf8"));
  } catch {
    return false;
  }
}

async function waitDead(pid: number, ms = 2_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !isAlive(pid);
}

test("ok run streams events in order and reports totals", async () => {
  const { adapter, run: r } = run("ok");
  assert.equal(adapter.id, "claude-code");
  const events = await collect(r);
  const result = await r.result;

  // stderr arrives on its own pipe, so its position relative to stdout is not fixed.
  const stderr = events.filter((e) => e.type === "log" && e.stream === "stderr");
  assert.deepEqual(stderr, [{ type: "log", stream: "stderr", line: "warning: fake stderr line" }]);
  const ordered = events.filter((e) => !(e.type === "log" && e.stream === "stderr"));
  assert.deepEqual(
    ordered.map((e) => e.type),
    ["start", "text", "usage", "tool", "text", "usage", "usage", "end"],
  );
  assert.deepEqual(ordered[1], { type: "text", text: "Reading the file." });
  assert.deepEqual(ordered[3], { type: "tool", name: "Bash", summary: "ls -la src" });
  // Running totals count msg_1 once even though its usage repeats on each content block.
  assert.deepEqual(ordered[5], {
    type: "usage",
    tokens: { input: 13, output: 12, cacheRead: 300, cacheWrite: 20 },
  });
  assert.deepEqual(events.at(-1), { type: "end", result });

  assert.equal(result.status, "ok");
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.tokens, { input: 13, output: 12, cacheRead: 300, cacheWrite: 20 });
  assert.equal(result.costUsd, 0.0123);
  assert.equal(result.sessionId, "fake-session-1");
  assert.equal(result.finalText, "Done.");
  assert.equal(result.turns, 2);
  assert.equal(result.error, undefined);
  assert.ok(result.durationMs >= 0);
});

test("passes prompt, model, permissions and worktree cwd to the CLI", async () => {
  const { run: r, record } = run("ok", task({ prompt: "Fix the bug", model: "sonnet" }), {
    permissionMode: "acceptEdits",
    skipPermissions: true,
  });
  const events = await collect(r);
  const { argv, cwd } = readRecord(record);
  const expected = [
    "-p",
    "Fix the bug",
    "--output-format",
    "stream-json",
    "--verbose",
    "--setting-sources",
    "project",
    "--strict-mcp-config",
    "--mcp-config",
    NO_MCP_SERVERS,
    "--model",
    "sonnet",
    "--permission-mode",
    "acceptEdits",
    "--dangerously-skip-permissions",
  ];
  assert.deepEqual(argv, expected);
  assert.equal(realpathSync(cwd), realpathSync(scratch));
  const start = events[0];
  assert.equal(start?.type, "start");
  if (start?.type === "start") {
    assert.deepEqual(start.argv, [FAKE, ...expected]);
    assert.equal(start.cwd, scratch);
    assert.equal(start.taskId, "MET-8");
  }
});

test("adds --max-turns and the bash output cap to every run", async () => {
  const { run: r, record } = run("ok", task({ maxTurns: 80 }));
  const result = await r.result;
  const { argv, bashMaxOutput } = readRecord(record);
  assert.deepEqual(argv.slice(-2), ["--max-turns", "80"]);
  assert.equal(bashMaxOutput, "20000");
  assert.equal(result.status, "ok");
});

test("a resumed run adds --resume and keeps every isolation flag and the turn cap", () => {
  const argv = claudeArgs(task({ resumeSessionId: "sess-1", maxTurns: 80 }), {}, scratch);
  assert.equal(argv[argv.indexOf("--resume") + 1], "sess-1");
  for (const flag of ["--setting-sources", "--strict-mcp-config", "--mcp-config"]) {
    assert.ok(argv.includes(flag), flag);
  }
  assert.deepEqual(argv.slice(-2), ["--max-turns", "80"]);
  assert.equal(createClaudeCodeAdapter().canResume, true);
});

test("an error_max_turns result is an error with turn cap and reason turn_cap", async () => {
  const { run: r } = run("max-turns", task({ maxTurns: 80 }));
  const result = await r.result;
  assert.equal(result.status, "error");
  assert.equal(result.error, "turn cap (80 turns)");
  assert.equal(result.reason, "turn_cap");
});

test("omits --model and permission flags when not configured", async () => {
  const { run: r, record } = run("ok");
  await r.result;
  assert.deepEqual(readRecord(record).argv, [
    "-p",
    "Say hi",
    "--output-format",
    "stream-json",
    "--verbose",
    "--setting-sources",
    "project",
    "--strict-mcp-config",
    "--mcp-config",
    NO_MCP_SERVERS,
  ]);
});

test("every run skips the owner's user-level config (D-031)", () => {
  const isolation = [
    "--setting-sources",
    "project",
    "--strict-mcp-config",
    "--mcp-config",
    ".mcp.json",
  ];
  const plain = claudeArgs(task());
  const full = claudeArgs(task({ model: "sonnet" }), { permissionMode: "auto" });
  for (const argv of [plain, full]) {
    const at = argv.indexOf("--setting-sources");
    assert.deepEqual(argv.slice(at, at + isolation.length), isolation);
    assert.ok(!argv.includes("--bare"), "--bare skips skill hooks and keychain sign-in");
    assert.ok(!argv.includes("--safe-mode"), "--safe-mode drops project skills and hooks");
  }
  assert.deepEqual(full.slice(-4), ["--model", "sonnet", "--permission-mode", "auto"]);
});

test("--mcp-config names the worktree's .mcp.json only when it exists", () => {
  const repo = mkdtempSync(join(scratch, "repo-"));
  const mcpArg = (argv: string[]) => argv[argv.indexOf("--mcp-config") + 1];
  // claude exits with "MCP config file not found" for a missing path, so no file means no servers.
  assert.equal(mcpArg(claudeArgs(task(), {}, repo)), NO_MCP_SERVERS);
  assert.deepEqual(JSON.parse(NO_MCP_SERVERS), { mcpServers: {} });
  writeFileSync(join(repo, ".mcp.json"), '{"mcpServers":{}}');
  assert.equal(mcpArg(claudeArgs(task(), {}, repo)), ".mcp.json");
});

test("adapter model applies when the task sets none", async () => {
  const { run: r, record } = run("ok", task(), { model: "opus" });
  await r.result;
  assert.deepEqual(readRecord(record).argv.slice(-2), ["--model", "opus"]);
});

test("HARNESSD_CLAUDE_BIN picks the binary when no bin option is given", async () => {
  const previous = process.env.HARNESSD_CLAUDE_BIN;
  process.env.HARNESSD_CLAUDE_BIN = FAKE;
  try {
    const r = createClaudeCodeAdapter({ env: { FAKE_CLAUDE_MODE: "ok" } }).start(task(), scratch);
    assert.equal((await r.result).status, "ok");
  } finally {
    if (previous === undefined) delete process.env.HARNESSD_CLAUDE_BIN;
    else process.env.HARNESSD_CLAUDE_BIN = previous;
  }
});

test("non-zero exit is an error", async () => {
  const { run: r } = run("error");
  const events = await collect(r);
  const result = await r.result;
  assert.equal(result.status, "error");
  assert.equal(result.exitCode, 1);
  assert.equal(result.error, "error_during_execution");
  assert.deepEqual(result.tokens, { input: 4, output: 2, cacheRead: 0, cacheWrite: 0 });
  assert.equal(result.turns, undefined, "no num_turns in the result event");
  assert.equal(events.at(-1)?.type, "end");
});

test("malformed and unknown lines become stdout logs without breaking the run", async () => {
  const { run: r } = run("malformed");
  const events = await collect(r);
  const result = await r.result;
  const logs = events.filter((e) => e.type === "log" && e.stream === "stdout");
  assert.deepEqual(logs, [
    { type: "log", stream: "stdout", line: "this is not json" },
    { type: "log", stream: "stdout", line: "[1,2]" },
  ]);
  assert.equal(result.status, "ok");
  assert.equal(result.tokens.output, 12);
});

test("timeout kills the process tree with SIGTERM", async () => {
  const budgetMs = 1_000;
  const killGraceMs = 2_000;
  const { run: r, record } = run("hang", task({ budgetMs }), { killGraceMs });
  const result = await r.result;
  assert.equal(result.status, "timeout");
  assert.equal(result.exitCode, null);
  assert.ok(result.durationMs >= budgetMs - 50, `ran ${result.durationMs}ms`);
  // The fake obeys SIGTERM, so it never waits for the grace period.
  assert.ok(result.durationMs < budgetMs + killGraceMs, `ran ${result.durationMs}ms`);
  const { grandchildPid } = readRecord(record);
  assert.ok(grandchildPid !== undefined);
  assert.ok(await waitDead(grandchildPid), "grandchild still running");
});

test("a stall stops the run with reason stalled and kills a detached grandchild (D-048)", async () => {
  const { run: r, record } = run("silent", task({ budgetMs: 30_000 }), {
    stallMs: 250,
    killGraceMs: 500,
  });
  const result = await r.result;
  assert.equal(result.status, "error");
  assert.equal(result.error, "stalled (no output for 10 min)");
  assert.equal(result.reason, "stalled");
  assert.ok(result.durationMs < 5_000, `ran ${result.durationMs}ms`);
  const { grandchildPid } = readRecord(record);
  assert.ok(grandchildPid !== undefined);
  assert.ok(await waitDead(grandchildPid), "the detached grandchild outlived the stall");
});

test("timeout escalates to SIGKILL after the grace period", async () => {
  const budgetMs = 1_000;
  const killGraceMs = 300;
  const { run: r, record } = run("hang-stubborn", task({ budgetMs }), { killGraceMs });
  const result = await r.result;
  assert.equal(result.status, "timeout");
  assert.equal(result.error, "budget of 1000ms exceeded");
  assert.ok(result.durationMs >= budgetMs + killGraceMs - 50, `ran ${result.durationMs}ms`);
  assert.ok(result.durationMs < budgetMs + killGraceMs + 1_500, `ran ${result.durationMs}ms`);
  const { grandchildPid } = readRecord(record);
  assert.ok(grandchildPid !== undefined);
  assert.ok(await waitDead(grandchildPid), "grandchild still running");
});

test("cancel() stops the run and reports cancelled", async () => {
  const { run: r } = run("hang", task({ budgetMs: 30_000 }));
  const seen: AdapterEvent["type"][] = [];
  for await (const event of r.events) {
    seen.push(event.type);
    if (event.type === "text") await r.cancel();
  }
  const result = await r.result;
  assert.equal(result.status, "cancelled");
  assert.equal(seen.at(-1), "end");
  assert.ok(result.durationMs < 30_000);
  await r.cancel(); // no-op once finished
});

test("a run left live when the daemon exits is killed with its whole group", async () => {
  const { run: r, record } = run("hang-stubborn", task({ budgetMs: 60_000 }), {
    killGraceMs: 10_000,
  });
  // The fake writes the grandchild pid from its own process, so the tree exists before the kill.
  const deadline = Date.now() + 2_000;
  let grandchild: number | undefined;
  while (grandchild === undefined && Date.now() < deadline) {
    try {
      grandchild = (readRecord(record) as { grandchildPid?: number }).grandchildPid;
    } catch {
      grandchild = undefined;
    }
    if (grandchild === undefined) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(grandchild !== undefined, "the fake wrote its grandchild pid");

  killAllLiveRuns();

  const result = await r.result;
  assert.notEqual(result.status, "ok");
  assert.ok(await waitDead(grandchild), "the grandchild outlived the daemon");
});

test("a missing binary is an error, not a throw", async () => {
  const r = createClaudeCodeAdapter({ bin: join(scratch, "no-such-claude") }).start(
    task(),
    scratch,
  );
  const events = await collect(r);
  const result = await r.result;
  assert.equal(result.status, "error");
  assert.equal(result.exitCode, null);
  assert.match(result.error ?? "", /ENOENT/);
  assert.deepEqual(
    events.map((e) => e.type),
    ["end"],
  );
});

test("summarizeInput prefers a descriptive key and stays short", () => {
  assert.equal(summarizeInput({ file_path: "/a/b.ts", content: "x" }), "/a/b.ts");
  assert.equal(summarizeInput({ todos: [1] }), '{"todos":[1]}');
  assert.equal(summarizeInput(undefined), "");
  const long = summarizeInput({ command: "x".repeat(500) });
  assert.equal(long.length, 120);
  assert.ok(long.endsWith("…"));
});

test("a task's env reaches the child over the adapter's env", async () => {
  const { run: r, record } = run("ok", task({ env: { FAKE_CLAUDE_PROBE: "from-task" } }), {
    env: { FAKE_CLAUDE_PROBE: "from-adapter" },
  });
  assert.equal((await r.result).status, "ok");
  assert.equal(readRecord(record).probe, "from-task");
});

/** No failed run may report the bare subtype: that is how "failed (error: success)" happened. */
function assertRealReason(error: string | undefined): void {
  assert.ok(error !== undefined && error.trim() !== "", "a failed run needs a reason");
  assert.notEqual(error, "success");
  assert.doesNotMatch(error, /^(error: )?success$/);
}

// Recorded lines Claude Code prints when a limit stops a run, from the result event or stderr.
const LIMIT_FIXTURES = [
  "Claude AI usage limit reached|1763660400",
  "You've hit your limit · resets 7pm (America/New_York)",
  "5-hour limit reached ∙ resets 3am",
  'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Rate limited"}}',
  "Request rejected (429) · rate limit exceeded",
  "HTTP 429 Too Many Requests",
  'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
  'API Error (api_error): {"message":"Overloaded"}',
];

test("classifyLimit matches every recorded limit message", () => {
  for (const line of LIMIT_FIXTURES) assert.ok(classifyLimit(line), line);
});

test("classifyLimit ignores ordinary failures", () => {
  for (const line of [
    "error_during_execution",
    "API Error: 500 internal server error",
    "Error: invalid model name",
    "Tests failed: 429 passed, 3 failed",
    "Added rate limit handling to the API client",
    "The rate limiter test failed",
    "",
  ]) {
    assert.equal(classifyLimit(line), undefined, line);
  }
});

test("parseResetAt reads a unix epoch after a pipe", () => {
  const now = new Date("2026-11-20T17:37:00Z");
  assert.equal(
    parseResetAt("Claude AI usage limit reached|1763660400", now),
    new Date(1763660400 * 1000).toISOString(),
  );
});

test("parseResetAt reads a millisecond epoch too", () => {
  const now = new Date("2026-11-20T17:37:00Z");
  assert.equal(parseResetAt("limit|1763660400000", now), new Date(1763660400000).toISOString());
});

test("parseResetAt reads a clock time as the next one after now", () => {
  const now = new Date("2026-11-20T17:37:00Z");
  assert.equal(parseResetAt("resets 7pm (UTC)", now), "2026-11-20T19:00:00.000Z");
  assert.equal(parseResetAt("resets 19:00", now), "2026-11-20T19:00:00.000Z");
  // Already past today, so tomorrow.
  assert.equal(parseResetAt("5-hour limit reached ∙ resets 3am", now), "2026-11-21T03:00:00.000Z");
  assert.equal(parseResetAt("resets 5:30pm", now), "2026-11-21T17:30:00.000Z");
  assert.equal(parseResetAt("resets 12am (UTC)", now), "2026-11-21T00:00:00.000Z");
  // New York is UTC-5 in November: 7pm there is 00:00 UTC the next day.
  assert.equal(
    parseResetAt("You've hit your limit · resets 7pm (America/New_York)", now),
    "2026-11-21T00:00:00.000Z",
  );
  // 1pm New York (18:00 UTC) is still ahead of now.
  assert.equal(parseResetAt("resets 1pm (America/New_York)", now), "2026-11-20T18:00:00.000Z");
});

test("parseResetAt leaves the time unset when nothing parses", () => {
  const now = new Date("2026-11-20T17:37:00Z");
  assert.equal(parseResetAt("usage limit reached", now), undefined);
  assert.equal(parseResetAt("resets 7pm (Nowhere/Atlantis)", now), undefined);
  assert.equal(parseResetAt("resets 25:00", now), undefined);
  assert.equal(parseResetAt("rate limit|abc", now), undefined);
});

test("a limit in the result event ends the run as limited with the reset time", async () => {
  const { run: r } = run("limit-result");
  const result = await r.result;
  assert.equal(result.status, "limited");
  assert.equal(result.resetAt, new Date(1763660400 * 1000).toISOString());
  assert.equal(result.error, "Claude AI usage limit reached|1763660400");
});

test("a reset time beyond the error summary survives a long limit message", async () => {
  const { run: r } = run("limit-result-long");
  const result = await r.result;
  assert.equal(result.status, "limited");
  assert.equal(result.resetAt, "2025-11-20T17:40:00.000Z");
  assert.match(result.error ?? "", /…$/);
});

test("a limit on stderr ends the run as limited", async () => {
  const { run: r } = run("limit-stderr");
  const result = await r.result;
  assert.equal(result.status, "limited");
  assert.equal(result.resetAt, undefined);
  assert.match(result.error ?? "", /rate_limit_error/);
});

test("a retried rate limit in a run that succeeds stays ok", async () => {
  const { run: r } = run("rate-limit-ok");
  const result = await r.result;
  assert.equal(result.status, "ok");
  assert.equal(result.error, undefined);
});

test("an earlier retried 429 on stderr does not hide a real failure", async () => {
  const { run: r } = run("rate-limit-then-error");
  const result = await r.result;
  assert.equal(result.status, "error");
  assert.equal(result.error, "Error: invalid model name");
});

test("a budget timeout beats a limit", async () => {
  const { run: r } = run("limit-hang", task({ budgetMs: 500 }), { killGraceMs: 300 });
  const result = await r.result;
  assert.equal(result.status, "timeout");
  assert.equal(result.resetAt, undefined);
});

test("cancel beats a limit", async () => {
  const { run: r } = run("limit-hang", task({ budgetMs: 30_000 }));
  for await (const event of r.events) {
    if (event.type === "text") await r.cancel();
  }
  const result = await r.result;
  assert.equal(result.status, "cancelled");
  assert.equal(result.resetAt, undefined);
});

test("is_error with subtype success reports the result text, never 'success'", async () => {
  const { run: r } = run("error-success");
  const result = await r.result;
  assert.equal(result.status, "error");
  assert.equal(result.error, "API Error: 500 internal server error");
  assertRealReason(result.error);
});

test("stderr explains an empty error result with a generic failure subtype", async () => {
  const { run: r } = run("error-stderr");
  const result = await r.result;
  assert.equal(result.status, "error");
  assert.equal(result.error, "Error: invalid model name");
});

test("no failed run reports 'success' or 'error: success' as its reason", async () => {
  for (const mode of ["error", "error-success", "error-stderr", "limit-result", "limit-stderr"]) {
    const { run: r } = run(mode);
    const result = await r.result;
    assert.notEqual(result.status, "ok", mode);
    assertRealReason(result.error);
    assert.doesNotMatch(`${result.status}: ${result.error}`, /^error: success$/, mode);
  }
});
