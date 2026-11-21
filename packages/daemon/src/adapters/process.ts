// The process side of every harness adapter: spawn, the event log, line reading, the budget
// timer, the process-group kill and the final result. Each adapter gives only its argv and a
// line parser.
import { type ChildProcess, spawn } from "node:child_process";
import type { Readable } from "node:stream";
import type {
  AdapterEvent,
  AdapterRun,
  RunResult,
  RunStatus,
  Task,
  TokenUsage,
} from "@harnessd/shared";

const DEFAULT_KILL_GRACE_MS = 5_000;
/** setTimeout overflows past this and fires at once. */
const MAX_TIMER_MS = 2 ** 31 - 1;
const SUMMARY_MAX = 120;

/** What a harness reported once its process has exited. */
export interface ParsedOutcome {
  /** True when the harness reported success. The run is ok only with this and exit code 0. */
  ok: boolean;
  /** Why the run failed, when the harness said so. */
  error?: string;
  reason?: RunResult["reason"];
  /** True when a usage or rate limit stopped the run, not the task (MET-70). */
  limited?: boolean;
  /** ISO time the limit resets, when the harness said it. */
  resetAt?: string;
  tokens: TokenUsage;
  costUsd?: number;
  sessionId?: string;
  finalText?: string;
}

/** Turns one harness's output lines into adapter events. */
export interface LineParser {
  /** One stdout line, without the newline. */
  line(raw: string): void;
  /** One stderr line. The process module already logs it. */
  stderr?(line: string): void;
  /** Called once, after the process exited on its own. */
  outcome(exitCode: number | null): ParsedOutcome;
}

export interface ProcessRunOptions {
  task: Task;
  worktree: string;
  bin: string;
  argv: string[];
  /** Builds the parser; it emits events through `emit`. */
  parser: (emit: (event: AdapterEvent) => void) => LineParser;
  /** Time between SIGTERM and SIGKILL when the run is killed. Default 5000. */
  killGraceMs?: number;
  /** Extra environment for the child, merged over process.env and under the task's env. */
  env?: Record<string, string>;
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

/** Runs a harness CLI in the worktree and streams its events (D-014 budget, process-group kill). */
export function startProcessRun(options: ProcessRunOptions): AdapterRun {
  const { task, worktree, bin, argv } = options;
  const graceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const events = new EventLog();
  const startedAt = performance.now();

  const parser = options.parser((event) => events.push(event));
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
      env: { ...process.env, ...options.env, ...task.env },
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
    readLines(child.stderr, (line) => {
      events.push({ type: "log", stream: "stderr", line });
      parser.stderr?.(line);
    });
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
    const parsed = parser.outcome(exitCode);
    const status = statusOf(exitCode, parsed);
    const run: RunResult = {
      status,
      exitCode,
      durationMs: Math.round(performance.now() - startedAt),
      tokens: parsed.tokens,
    };
    if (parsed.costUsd !== undefined) run.costUsd = parsed.costUsd;
    if (parsed.sessionId !== undefined) run.sessionId = parsed.sessionId;
    if (parsed.finalText !== undefined) run.finalText = parsed.finalText;
    const error = errorOf(status, exitCode, parsed);
    if (error !== undefined) run.error = error;
    if (
      (status === "error" || status === "limited") &&
      spawnError === undefined &&
      parsed.reason !== undefined
    ) {
      run.reason = parsed.reason;
    }
    if (status === "limited" && parsed.resetAt !== undefined) run.resetAt = parsed.resetAt;
    events.push({ type: "end", result: run });
    events.close();
    resolveResult(run);
  }

  /** Order: timeout and cancel, then a spawn failure, then success, then a limit, then error. */
  function statusOf(exitCode: number | null, parsed: ParsedOutcome): RunStatus {
    if (stopReason) return stopReason;
    if (spawnError !== undefined) return "error";
    if (exitCode === 0 && parsed.ok) return "ok";
    return parsed.limited || parsed.reason === "usage_limit" ? "limited" : "error";
  }

  function errorOf(
    status: RunStatus,
    exitCode: number | null,
    parsed: ParsedOutcome,
  ): string | undefined {
    if (status === "ok") return undefined;
    if (status === "timeout") return `budget of ${task.budgetMs}ms exceeded`;
    if (status === "cancelled") return "cancelled";
    if (spawnError !== undefined) return spawnError;
    if (parsed.error !== undefined) return parsed.error;
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

/** Collapses whitespace and cuts the text to one line of at most SUMMARY_MAX characters. */
export function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > SUMMARY_MAX ? `${flat.slice(0, SUMMARY_MAX - 1)}…` : flat;
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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
