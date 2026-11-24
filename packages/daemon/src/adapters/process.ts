// The process side of every harness adapter: spawn, the event log, line reading, the budget
// timer, the process-group kill and the final result. Each adapter gives only its argv and a
// line parser.
import { type ChildProcess, execFile, execFileSync, spawn } from "node:child_process";
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
/** A run that sends no adapter event for this long is stalled (D-048). */
export const STALL_MS = 10 * 60_000;
/** setTimeout overflows past this and fires at once. */
const MAX_TIMER_MS = 2 ** 31 - 1;
const SUMMARY_MAX = 120;

/** What a harness reported once its process has exited. */
export interface ParsedOutcome {
  /** True when the harness reported success. The process must also exit cleanly or explain its nonzero exit. */
  ok: boolean;
  exitExplained?: true;
  /** Why the run failed, when the harness said so. */
  error?: string;
  reason?: RunResult["reason"];
  /** True when a usage or rate limit stopped the run, not the task (MET-70). */
  limited?: boolean;
  /** ISO time the limit resets, when the harness said it. */
  resetAt?: string;
  tokens: TokenUsage;
  /** Model turns the harness reported, when it did (D-043). */
  turns?: number;
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
  /** Turns counted so far, for the cap (D-045). */
  turnCount?(): number;
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
  /** Stop the run when the parser has counted this many turns (D-045). */
  maxTurns?: number;
  /** No event for this long is a stall. Default STALL_MS. A test can shorten it. */
  stallMs?: number;
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

/** The process groups of runs still live in this process. */
const liveGroups = new Map<number, ChildProcess>();
let exitHookInstalled = false;

/** The live descendants of a process, with the groups to signal (D-048). */
export interface ProcessTree {
  /** Every live descendant pid. */
  pids: number[];
  /** The root's own group and each descendant's group. */
  groups: number[];
}

/**
 * Reads `ps -axo pid=,ppid=,pgid=` output and returns the descendants of `rootPid`.
 * A nested startProcessRun's child leads a group of its own, so the root's group alone
 * misses it. Groups always include the root's own group. The caller's own process and
 * group (`selfPid`) are never in the result, so a stop can never signal the daemon itself.
 */
export function parseProcessTree(
  text: string,
  rootPid: number,
  selfPid: number = process.pid,
): ProcessTree {
  const rows = new Map<number, { ppid: number; pgid: number }>();
  for (const line of text.split("\n")) {
    const [pid, ppid, pgid] = line.trim().split(/\s+/).map(Number);
    if (pid === undefined || ppid === undefined || pgid === undefined) continue;
    if (!Number.isInteger(pid) || !Number.isInteger(ppid) || !Number.isInteger(pgid)) continue;
    rows.set(pid, { ppid, pgid });
  }
  const childrenOf = new Map<number, number[]>();
  for (const [pid, row] of rows) {
    const list = childrenOf.get(row.ppid) ?? [];
    list.push(pid);
    childrenOf.set(row.ppid, list);
  }
  const ownGroup = rows.get(selfPid)?.pgid;
  const safe = (group: number) => group > 1 && group !== selfPid && group !== ownGroup;
  const pids: number[] = [];
  const groups = new Set<number>(safe(rootPid) ? [rootPid] : []);
  const queue = [rootPid];
  while (queue.length > 0) {
    const parent = queue.shift() as number;
    for (const child of childrenOf.get(parent) ?? []) {
      if (child !== selfPid) pids.push(child);
      const row = rows.get(child);
      if (row !== undefined && safe(row.pgid)) groups.add(row.pgid);
      queue.push(child);
    }
  }
  return { pids, groups: [...groups] };
}

/** Lists the live descendants of `pid` through `ps`. A failed `ps` keeps the root group. */
export function processTree(pid: number): Promise<ProcessTree> {
  return new Promise((resolve) => {
    execFile("ps", ["-axo", "pid=,ppid=,pgid="], { timeout: 2_000 }, (error, stdout) => {
      resolve(error ? { pids: [], groups: [pid] } : parseProcessTree(stdout, pid));
    });
  });
}

/** Signals the root's group, each descendant's group and each descendant itself. */
function signalTree(tree: ProcessTree, signal: NodeJS.Signals): void {
  for (const group of tree.groups) {
    try {
      process.kill(-group, signal);
    } catch {
      // ESRCH or EPERM: that group is gone or not ours.
    }
  }
  for (const pid of tree.pids) {
    try {
      process.kill(pid, signal);
    } catch {
      // ESRCH: that process is gone.
    }
  }
}

/**
 * SIGTERMs a process and every descendant, with each one's process group, then SIGKILLs
 * after `graceMs` (D-048). The QA test command uses it too.
 */
export async function killProcessTree(pid: number, graceMs: number): Promise<void> {
  const tree = await processTree(pid);
  signalTree(tree, "SIGTERM");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, graceMs);
    timer.unref();
  });
  signalTree(tree, "SIGKILL");
}

function trackGroup(child: ChildProcess): void {
  if (child.pid === undefined) return;
  liveGroups.set(child.pid, child);
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  // A run must never outlive the daemon. On a normal exit no later code can cancel it, so
  // SIGKILL the group now; a test runner that stops leaves no fixture behind either.
  process.once("exit", () => killAllLiveRuns());
}

function untrackGroup(pid: number | undefined): void {
  if (pid !== undefined) liveGroups.delete(pid);
}

/**
 * Registers a child the daemon starts outside an adapter run, so `killAllLiveRuns` stops its
 * tree when the daemon exits (MET-178). The QA app's start process is one.
 */
export function trackProcess(child: ChildProcess): void {
  trackGroup(child);
}

/** Stops tracking a child: its tree was stopped or is gone (MET-178). */
export function stopTrackingProcess(pid: number | undefined): void {
  untrackGroup(pid);
}

/** SIGKILLs every live run's process group and every descendant's group (D-048). */
export function killAllLiveRuns(): void {
  let text = "";
  try {
    text = execFileSync("ps", ["-axo", "pid=,ppid=,pgid="], { encoding: "utf8", timeout: 2_000 });
  } catch {
    // No ps: the root groups still die below.
  }
  for (const pid of liveGroups.keys()) {
    signalTree(parseProcessTree(text, pid), "SIGKILL");
  }
  liveGroups.clear();
}

/** Runs a harness CLI in the worktree and streams its events (D-014 budget, process-group kill). */
export function startProcessRun(options: ProcessRunOptions): AdapterRun {
  const { task, worktree, bin, argv } = options;
  const graceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const events = new EventLog();
  const startedAt = performance.now();

  const parser = options.parser((event) => pushEvent(event));
  let stopReason: "timeout" | "cancelled" | "turn-cap" | "stall" | undefined;
  let hitTurnCap = false;
  let spawnError: string | undefined;
  let budgetTimer: NodeJS.Timeout | undefined;
  let stallTimer: NodeJS.Timeout | undefined;
  let stopping = false;
  let exited = false;
  let settled = false;
  let resolveResult: (result: RunResult) => void = () => {};
  const result = new Promise<RunResult>((resolve) => {
    resolveResult = resolve;
  });
  const stallMs = options.stallMs ?? STALL_MS;

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
  trackGroup(child);

  if (child.pid !== undefined) {
    pushEvent({
      type: "start",
      taskId: task.id,
      pid: child.pid,
      argv: [bin, ...argv],
      cwd: worktree,
    });
  }
  if (child.stdout) {
    readLines(child.stdout, (line) => {
      parser.line(line);
      checkTurnCap();
    });
  }
  if (child.stderr) {
    readLines(child.stderr, (line) => {
      pushEvent({ type: "log", stream: "stderr", line });
      parser.stderr?.(line);
    });
  }
  resetStall();

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

  /**
   * SIGTERM the run's group and each descendant's group (D-048), then SIGKILL after the
   * grace period and stop waiting on stdio. A nested run's child leads its own group, so
   * the descendant list is taken before the first signal.
   */
  function terminate(): void {
    if (stopping || settled) return;
    stopping = true;
    void stopTree();
  }

  async function stopTree(): Promise<void> {
    const pid = child.pid;
    const tree = pid === undefined ? { pids: [], groups: [] } : await processTree(pid);
    signalTree(tree, "SIGTERM");
    if (!exited) {
      try {
        child.kill("SIGTERM");
      } catch {
        // ESRCH: already gone.
      }
    }
    const kill = setTimeout(() => {
      signalTree(tree, "SIGKILL");
      if (!exited) {
        try {
          child.kill("SIGKILL");
        } catch {
          // ESRCH: already gone.
        }
      }
    }, graceMs);
    const destroy = setTimeout(() => {
      child.stdout?.destroy();
      child.stderr?.destroy();
    }, graceMs + 250);
    kill.unref();
    destroy.unref();
  }

  /** Every event resets the stall watchdog, stdout events and stderr lines included (D-048). */
  function pushEvent(event: AdapterEvent): void {
    events.push(event);
    resetStall();
  }

  /** Starts the no-output timer again; at STALL_MS the run stops like a timeout. */
  function resetStall(): void {
    clearTimeout(stallTimer);
    if (settled || !Number.isFinite(stallMs) || stallMs <= 0) return;
    stallTimer = setTimeout(
      () => {
        stopReason ??= "stall";
        terminate();
      },
      Math.min(stallMs, MAX_TIMER_MS),
    );
    stallTimer.unref();
  }

  /** The parser counted the cap: kill the run the way a cancel does, and report `error` (D-045). */
  function checkTurnCap(): void {
    if (hitTurnCap || settled || options.maxTurns === undefined) return;
    if ((parser.turnCount?.() ?? 0) < options.maxTurns) return;
    hitTurnCap = true;
    stopReason ??= "turn-cap";
    terminate();
  }

  function finish(exitCode: number | null): void {
    if (settled) return;
    settled = true;
    untrackGroup(child?.pid);
    clearTimeout(budgetTimer);
    clearTimeout(stallTimer);
    const parsed = parser.outcome(exitCode);
    const status = statusOf(exitCode, parsed);
    const run: RunResult = {
      status,
      exitCode,
      durationMs: Math.round(performance.now() - startedAt),
      tokens: parsed.tokens,
    };
    if (parsed.costUsd !== undefined) run.costUsd = parsed.costUsd;
    if (parsed.turns !== undefined) run.turns = parsed.turns;
    if (parsed.sessionId !== undefined) run.sessionId = parsed.sessionId;
    if (parsed.finalText !== undefined) run.finalText = parsed.finalText;
    const error = errorOf(status, exitCode, parsed);
    if (error !== undefined) run.error = error;
    if (stopReason === "stall") {
      run.reason = "stalled";
    } else if (hitTurnCap) {
      run.reason = "turn_cap";
    } else if (
      (status === "error" || status === "limited") &&
      spawnError === undefined &&
      parsed.reason !== undefined
    ) {
      run.reason = parsed.reason;
    }
    if (status === "limited" && parsed.resetAt !== undefined) run.resetAt = parsed.resetAt;
    pushEvent({ type: "end", result: run });
    events.close();
    resolveResult(run);
  }

  /** Order: timeout and cancel, then a stall, then the turn cap, then a spawn failure, then success, then a limit. */
  function statusOf(exitCode: number | null, parsed: ParsedOutcome): RunStatus {
    if (stopReason === "timeout" || stopReason === "cancelled") return stopReason;
    if (stopReason === "stall") return "error";
    if (hitTurnCap) return "error";
    if (spawnError !== undefined) return "error";
    if (parsed.ok && (exitCode === 0 || parsed.exitExplained)) return "ok";
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
    if (stopReason === "stall") return "stalled (no output for 10 min)";
    if (hitTurnCap && options.maxTurns !== undefined) {
      return `turn cap (${options.maxTurns} turns)`;
    }
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
