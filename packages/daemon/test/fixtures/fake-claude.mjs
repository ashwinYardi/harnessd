#!/usr/bin/env node
// Stand-in for `claude -p ... --output-format stream-json --verbose` in adapter tests.
// FAKE_CLAUDE_MODE: ok (default) | error | malformed | hang | hang-stubborn | limit-result |
// limit-stderr | limit-hang | rate-limit-ok | error-success | error-stderr |
// rate-limit-then-error | max-turns
// FAKE_CLAUDE_RECORD: file to write {argv, cwd, grandchildPid?, probe?, inspect?} into.
// FAKE_CLAUDE_PROBE: copied into the record as `probe`, to see the child's environment.
// FAKE_CLAUDE_INSPECT=1: also records what the run sees in its cwd: the skill folders in
// .claude/skills, .mcp.json and `git status --porcelain`.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const mode = process.env.FAKE_CLAUDE_MODE ?? "ok";
const recordPath = process.env.FAKE_CLAUDE_RECORD;
const record = { argv: process.argv.slice(2), cwd: process.cwd() };
if (process.env.FAKE_CLAUDE_PROBE !== undefined) record.probe = process.env.FAKE_CLAUDE_PROBE;
if (process.env.BASH_MAX_OUTPUT_LENGTH !== undefined) {
  record.bashMaxOutput = process.env.BASH_MAX_OUTPUT_LENGTH;
}
if (process.env.FAKE_CLAUDE_INSPECT === "1") {
  const cwd = process.cwd();
  const skills = join(cwd, ".claude", "skills");
  const mcp = join(cwd, ".mcp.json");
  record.inspect = {
    skills: existsSync(skills) ? readdirSync(skills).sort() : [],
    mcp: existsSync(mcp) ? JSON.parse(readFileSync(mcp, "utf8")) : null,
    gitStatus: execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
      cwd,
      encoding: "utf8",
    }),
  };
}
const session = "fake-session-1";

function save() {
  if (recordPath) writeFileSync(recordPath, JSON.stringify(record));
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function usage(input, output, cacheRead, cacheWrite) {
  return {
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheWrite,
  };
}

function init() {
  emit({ type: "system", subtype: "init", session_id: session, model: "fake", tools: [] });
}

function assistant(id, content, u) {
  emit({
    type: "assistant",
    message: { id, role: "assistant", content, usage: u },
    session_id: session,
  });
}

function result(fields) {
  emit({ type: "result", duration_ms: 12, session_id: session, ...fields });
}

save();

if (mode === "ok" || mode === "malformed") {
  init();
  if (mode === "malformed") {
    process.stdout.write("this is not json\n");
    emit({ type: "mystery", payload: 1 });
    process.stdout.write("[1,2]\n");
  }
  const first = usage(10, 5, 100, 20);
  assistant("msg_1", [{ type: "text", text: "Reading the file." }], first);
  // Claude repeats a message's usage on every content block; totals must count it once.
  assistant(
    "msg_1",
    [{ type: "tool_use", id: "tu_1", name: "Bash", input: { command: "ls -la\n  src" } }],
    first,
  );
  emit({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tu_1", content: "a b" }],
    },
  });
  assistant("msg_2", [{ type: "text", text: "Done." }], usage(3, 7, 200, 0));
  process.stderr.write("warning: fake stderr line\n");
  result({
    subtype: "success",
    is_error: false,
    result: "Done.",
    total_cost_usd: 0.0123,
    usage: usage(13, 12, 300, 20),
    num_turns: 2,
  });
  process.exitCode = 0;
} else if (mode === "error") {
  init();
  assistant("msg_1", [{ type: "text", text: "Trying." }], usage(4, 2, 0, 0));
  result({
    subtype: "error_during_execution",
    is_error: true,
    total_cost_usd: 0.001,
    usage: usage(4, 2, 0, 0),
  });
  process.exitCode = 1;
} else if (mode === "max-turns") {
  // The shape Claude Code 2.1.329 prints when --max-turns stops the run.
  init();
  assistant("msg_1", [{ type: "text", text: "Still working." }], usage(4, 2, 0, 0));
  result({
    subtype: "error_max_turns",
    is_error: true,
    num_turns: 2,
    total_cost_usd: 0.001,
    usage: usage(4, 2, 0, 0),
  });
  process.exitCode = 1;
} else if (mode === "limit-result" || mode === "limit-result-long") {
  // Recorded shape of the 2026-11-20 run: is_error with subtype success and the limit as result.
  init();
  result({
    subtype: "success",
    is_error: true,
    result:
      mode === "limit-result-long"
        ? `Claude AI usage limit reached ${"detail ".repeat(80)}|1763660400`
        : "Claude AI usage limit reached|1763660400",
    total_cost_usd: 0,
    usage: usage(0, 0, 0, 0),
  });
  process.exitCode = 1;
} else if (mode === "limit-stderr") {
  process.stderr.write(
    'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Rate limited"}}\n',
  );
  process.exitCode = 1;
} else if (mode === "rate-limit-ok") {
  // Claude retries a 429 on its own; a run that then succeeds is ok.
  init();
  process.stderr.write("API Error: 429 rate_limit_error, retrying in 2s\n");
  result({ subtype: "success", is_error: false, result: "Done.", usage: usage(1, 1, 0, 0) });
  process.exitCode = 0;
} else if (mode === "rate-limit-then-error") {
  // A retried 429, then a real failure: the failure is the reason.
  process.stderr.write("API Error: 429 rate_limit_error, retrying in 2s\n");
  process.stderr.write("Error: invalid model name\n");
  process.exitCode = 1;
} else if (mode === "error-success") {
  init();
  result({ subtype: "success", is_error: true, result: "API Error: 500 internal server error" });
  process.exitCode = 1;
} else if (mode === "error-stderr") {
  init();
  result({ subtype: "error_during_execution", is_error: true, result: "" });
  process.stderr.write("first stderr line\n");
  process.stderr.write("Error: invalid model name\n");
  process.exitCode = 1;
} else if (mode === "limit-hang") {
  process.stderr.write("You've hit your limit · resets 7pm (UTC)\n");
  init();
  assistant("msg_1", [{ type: "text", text: "Working." }], usage(1, 1, 0, 0));
  setInterval(() => {}, 1000);
} else if (mode === "hang" || mode === "hang-stubborn") {
  if (mode === "hang-stubborn") process.on("SIGTERM", () => {});
  // A grandchild in the same process group, to prove the whole tree is killed.
  const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  record.grandchildPid = grandchild.pid;
  save();
  init();
  assistant("msg_1", [{ type: "text", text: "Working." }], usage(1, 1, 0, 0));
  setInterval(() => {}, 1000);
} else {
  process.stderr.write(`fake-claude: unknown mode ${mode}\n`);
  process.exitCode = 2;
}
