import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Readable } from "node:stream";
import {
  type AdapterEvent,
  type AdapterRun,
  emptyTokenUsage,
  type HarnessAdapter,
  type RunResult,
  type RunStatus,
  type Task,
  type TokenUsage,
} from "@harnessd/shared";

export interface ClaudeCodeOptions {
  /** Path to the `claude` binary. Defaults to $HARNESSD_CLAUDE_BIN, then `claude` on PATH. */
  bin?: string;
  /** Passed as `--permission-mode` (acceptEdits, auto, bypassPermissions, manual, dontAsk, plan). */
  permissionMode?: string;
  /** Adds `--dangerously-skip-permissions`. */
  skipPermissions?: boolean;
  /** Model used when the task sets none. */
  model?: string;
  /** Time between SIGTERM and SIGKILL when the run is killed. Default 5000. */
  killGraceMs?: number;
  /** Extra environment for the child, merged over process.env. */
  env?: Record<string, string>;
}

const DEFAULT_KILL_GRACE_MS = 5_000;
/** setTimeout overflows past this and fires at once. */
const MAX_TIMER_MS = 2 ** 31 - 1;
const SUMMARY_MAX = 120;

/**
 * D-031: every run reads only project settings and the worktree's .mcp.json, never the owner's
 * ~/.claude settings, CLAUDE.md, skills, hooks, plugins or ~/.claude.json MCP servers.
 * claude fails when the --mcp-config file is missing, so a worktree without .mcp.json gets an
 * empty inline config. --bare and --safe-mode are rejected on purpose.
 */
export const NO_MCP_SERVERS = '{"mcpServers":{}}';

function isolationArgs(cwd: string | undefined): string[] {
  const mcp =
    cwd === undefined || existsSync(join(cwd, ".mcp.json")) ? ".mcp.json" : NO_MCP_SERVERS;
  return ["--setting-sources", "project", "--strict-mcp-config", "--mcp-config", mcp];
}

/**
 * Builds the argv for `claude` print mode with stream-json output.
 * `cwd` is the run's directory; it decides how --mcp-config is passed.
 */
export function claudeArgs(task: Task, options: ClaudeCodeOptions = {}, cwd?: string): string[] {
  const args = [
    "-p",
    task.prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    ...isolationArgs(cwd),
  ];
  const model = task.model ?? options.model;
  if (model) args.push("--model", model);
  if (options.permissionMode) args.push("--permission-mode", options.permissionMode);
  if (options.skipPermissions) args.push("--dangerously-skip-permissions");
  return args;
}

export function createClaudeCodeAdapter(options: ClaudeCodeOptions = {}): HarnessAdapter {
  return {
    id: "claude-code",
    start: (task, worktree) => startClaudeRun(task, worktree, options),
  };
}

/** Append-only event log; every iterator replays from the first event and ends after close(). */
class EventLog implements AsyncIterable<AdapterEvent> {
  #events: AdapterEvent[] = [];
  #closed = false;
  #waiters: Array<() => void> = [];

  push(event: AdapterEvent): void {
    if (this.#closed) return;
    this.#events.push(event);
    this.#wake();
  }

  close(): void {
    this.#closed = true;
    this.#wake();
  }

  #wake(): void {
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const wake of waiters) wake();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<AdapterEvent> {
    let i = 0;
    while (true) {
      const event = this.#events[i];
      if (event !== undefined) {
        i++;
        yield event;
        continue;
      }
      if (this.#closed) return;
      await new Promise<void>((resolve) => this.#waiters.push(resolve));
    }
  }
}

function startClaudeRun(task: Task, worktree: string, options: ClaudeCodeOptions): AdapterRun {
  const bin = options.bin ?? process.env.HARNESSD_CLAUDE_BIN ?? "claude";
  const argv = claudeArgs(task, options, worktree);
  const graceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const events = new EventLog();
  const startedAt = performance.now();

  const parser = new StreamJsonParser((event) => events.push(event));
  let stopReason: "timeout" | "cancelled" | undefined;
  let spawnError: string | undefined;
  let killTimers: NodeJS.Timeout[] = [];
  let budgetTimer: NodeJS.Timeout | undefined;
  let exited = false;
  let settled = false;
  let resolveResult: (result: RunResult) => void = () => {};
  const result = new Promise<RunResult>((resolve) => {
    resolveResult = resolve;
  });

  let child: ChildProcess;
  try {
    // detached: the child leads its own process group, so the whole tree can be signalled.
    child = spawn(bin, argv, {
      cwd: worktree,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...options.env },
    });
  } catch (error) {
    spawnError = errorMessage(error);
    finish(null);
    return { events, result, cancel: async () => {} };
  }

  if (child.pid !== undefined) {
    events.push({
      type: "start",
      taskId: task.id,
      pid: child.pid,
      argv: [bin, ...argv],
      cwd: worktree,
    });
  }
  if (child.stdout) readLines(child.stdout, (line) => parser.line(line));
  if (child.stderr) {
    readLines(child.stderr, (line) => events.push({ type: "log", stream: "stderr", line }));
  }

  if (Number.isFinite(task.budgetMs) && task.budgetMs > 0) {
    budgetTimer = setTimeout(
      () => {
        stopReason ??= "timeout";
        terminate();
      },
      Math.min(task.budgetMs, MAX_TIMER_MS),
    );
  }

  child.on("error", (error) => {
    spawnError = errorMessage(error);
    // A failed spawn emits no "close" when there is no process at all.
    if (child.pid === undefined) finish(null);
  });
  child.on("exit", () => {
    exited = true;
    // Reap anything the CLI left behind in its process group; it also unblocks the pipes.
    terminate();
  });
  child.on("close", (code) => finish(code));

  /** SIGTERM the process group, SIGKILL after the grace period, then stop waiting on stdio. */
  function terminate(): void {
    if (killTimers.length > 0 || settled) return;
    signalGroup("SIGTERM");
    killTimers = [
      setTimeout(() => signalGroup("SIGKILL"), graceMs),
      setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
      }, graceMs + 250),
    ];
    for (const timer of killTimers) timer.unref();
  }

  function signalGroup(signal: NodeJS.Signals): void {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      // ESRCH: the group is already gone.
    }
    if (!exited) child.kill(signal);
  }

  function finish(exitCode: number | null): void {
    if (settled) return;
    settled = true;
    clearTimeout(budgetTimer);
    for (const timer of killTimers) clearTimeout(timer);
    const run: RunResult = {
      status: statusOf(exitCode),
      exitCode,
      durationMs: Math.round(performance.now() - startedAt),
      tokens: parser.tokens(),
    };
    if (parser.costUsd !== undefined) run.costUsd = parser.costUsd;
    if (parser.sessionId !== undefined) run.sessionId = parser.sessionId;
    if (parser.finalText !== undefined) run.finalText = parser.finalText;
    const error = errorOf(run.status, exitCode);
    if (error !== undefined) run.error = error;
    events.push({ type: "end", result: run });
    events.close();
    resolveResult(run);
  }

  function statusOf(exitCode: number | null): RunStatus {
    if (stopReason) return stopReason;
    if (spawnError !== undefined) return "error";
    return exitCode === 0 && parser.isError === false ? "ok" : "error";
  }

  function errorOf(status: RunStatus, exitCode: number | null): string | undefined {
    if (status === "ok") return undefined;
    if (status === "timeout") return `budget of ${task.budgetMs}ms exceeded`;
    if (status === "cancelled") return "cancelled";
    if (spawnError !== undefined) return spawnError;
    if (parser.isError) return parser.errorSubtype ?? "harness reported an error";
    if (exitCode !== 0) return `exited with code ${exitCode}`;
    return "no result event";
  }

  return {
    events,
    result,
    cancel: async () => {
      if (!settled) {
        stopReason ??= "cancelled";
        terminate();
      }
      await result;
    },
  };
}

/** Turns Claude Code stream-json lines into adapter events and tracks run totals. */
class StreamJsonParser {
  sessionId: string | undefined;
  finalText: string | undefined;
  costUsd: number | undefined;
  /** undefined until a `result` event arrives. */
  isError: boolean | undefined;
  errorSubtype: string | undefined;
  #emit: (event: AdapterEvent) => void;
  /** Usage per assistant message id: Claude repeats a message's usage on each content block. */
  #messageUsage = new Map<string, TokenUsage>();
  #resultUsage: TokenUsage | undefined;
  #anonymous = 0;

  constructor(emit: (event: AdapterEvent) => void) {
    this.#emit = emit;
  }

  line(raw: string): void {
    const line = raw.trim();
    if (line === "") return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      this.#emit({ type: "log", stream: "stdout", line: raw });
      return;
    }
    if (!isRecord(value)) {
      this.#emit({ type: "log", stream: "stdout", line: raw });
      return;
    }
    switch (value.type) {
      case "system":
        if (typeof value.session_id === "string") this.sessionId = value.session_id;
        return;
      case "assistant":
        this.#assistant(value.message);
        return;
      case "result":
        this.#result(value);
        return;
      default:
        // user (tool results), stream_event and future types carry nothing we report.
        return;
    }
  }

  tokens(): TokenUsage {
    if (this.#resultUsage) return { ...this.#resultUsage };
    const total = emptyTokenUsage();
    for (const usage of this.#messageUsage.values()) {
      total.input += usage.input;
      total.output += usage.output;
      total.cacheRead += usage.cacheRead;
      total.cacheWrite += usage.cacheWrite;
    }
    return total;
  }

  #assistant(message: unknown): void {
    if (!isRecord(message)) return;
    const content = Array.isArray(message.content) ? message.content : [];
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (block.type === "text" && typeof block.text === "string" && block.text !== "") {
        this.#emit({ type: "text", text: block.text });
      } else if (block.type === "tool_use" && typeof block.name === "string") {
        this.#emit({ type: "tool", name: block.name, summary: summarizeInput(block.input) });
      }
    }
    const usage = parseUsage(message.usage);
    if (!usage) return;
    const id = typeof message.id === "string" ? message.id : `anonymous-${this.#anonymous++}`;
    const previous = this.#messageUsage.get(id);
    this.#messageUsage.set(id, usage);
    if (!previous || !sameUsage(previous, usage)) this.#emitUsage();
  }

  #result(value: Record<string, unknown>): void {
    this.isError =
      value.is_error === true || (typeof value.subtype === "string" && value.subtype !== "success");
    if (this.isError && typeof value.subtype === "string") this.errorSubtype = value.subtype;
    if (typeof value.session_id === "string") this.sessionId = value.session_id;
    if (typeof value.result === "string") this.finalText = value.result;
    if (typeof value.total_cost_usd === "number") this.costUsd = value.total_cost_usd;
    const usage = parseUsage(value.usage);
    if (usage) this.#resultUsage = usage;
    if (usage || this.costUsd !== undefined) this.#emitUsage();
  }

  #emitUsage(): void {
    const tokens = this.tokens();
    this.#emit(
      this.costUsd === undefined
        ? { type: "usage", tokens }
        : { type: "usage", tokens, costUsd: this.costUsd },
    );
  }
}

function parseUsage(value: unknown): TokenUsage | undefined {
  if (!isRecord(value)) return undefined;
  return {
    input: count(value.input_tokens),
    output: count(value.output_tokens),
    cacheRead: count(value.cache_read_input_tokens),
    cacheWrite: count(value.cache_creation_input_tokens),
  };
}

function sameUsage(a: TokenUsage, b: TokenUsage): boolean {
  return (
    a.input === b.input &&
    a.output === b.output &&
    a.cacheRead === b.cacheRead &&
    a.cacheWrite === b.cacheWrite
  );
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Keys that best describe a tool call, in order of preference. */
const SUMMARY_KEYS = [
  "command",
  "file_path",
  "path",
  "pattern",
  "url",
  "query",
  "description",
  "prompt",
];

/** One short line describing a tool call's input. */
export function summarizeInput(input: unknown): string {
  let text = "";
  if (isRecord(input)) {
    const key = SUMMARY_KEYS.find((k) => typeof input[k] === "string" && input[k] !== "");
    text = key ? String(input[key]) : JSON.stringify(input);
  } else if (input !== undefined) {
    text = typeof input === "string" ? input : (JSON.stringify(input) ?? "");
  }
  text = text.replace(/\s+/g, " ").trim();
  return text.length > SUMMARY_MAX ? `${text.slice(0, SUMMARY_MAX - 1)}…` : text;
}

function readLines(stream: Readable, onLine: (line: string) => void): void {
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      onLine(buffer.slice(0, newline).replace(/\r$/, ""));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
  });
  stream.on("end", () => {
    if (buffer !== "") onLine(buffer);
    buffer = "";
  });
  // Destroyed streams (after a kill) may error; the run result covers it.
  stream.on("error", () => {});
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
