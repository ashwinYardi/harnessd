import type { HarnessId } from "./index.ts";

/** A unit of work handed to a harness adapter. */
export interface Task {
  id: string;
  title: string;
  /** Full prompt passed to the harness CLI. */
  prompt: string;
  /** Wall-clock budget (D-014). The run is killed and reported as `timeout` when it runs over. */
  budgetMs: number;
  /** Harness model name or alias. Omitted means the harness default. */
  model?: string;
  /** Extra environment for this run, over the adapter's own (e.g. git config for the worktree). */
  env?: Record<string, string>;
}

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** `limited`: the harness hit a usage or rate limit; the task itself did not fail (MET-70). */
export type RunStatus = "ok" | "error" | "timeout" | "cancelled" | "limited";

export interface RunResult {
  status: RunStatus;
  /** Process exit code, or null when it died from a signal or never started. */
  exitCode: number | null;
  /** Wall-clock time measured by the adapter, spawn to exit. */
  durationMs: number;
  tokens: TokenUsage;
  costUsd?: number;
  sessionId?: string;
  /** Final assistant text reported by the harness. */
  finalText?: string;
  /** Short reason when status is not `ok`. */
  error?: string;
  /** Machine-readable reason when the harness reports a usage limit or a sign-in failure. */
  reason?: RunFailureReason;
  /** ISO time the limit resets, when status is `limited` and the harness said when. */
  resetAt?: string;
}

/** A failure the human fixes outside the run: a usage limit, or a harness that is not signed in. */
export type RunFailureReason = "usage_limit" | "auth";

/** Events streamed while a harness runs, in the order they happened. `end` is always last. */
export type AdapterEvent =
  | { type: "start"; taskId: string; pid: number; argv: string[]; cwd: string }
  | { type: "text"; text: string }
  | { type: "tool"; name: string; summary: string }
  /** Running token totals for the run so far. */
  | { type: "usage"; tokens: TokenUsage; costUsd?: number }
  /** A raw line the adapter did not turn into an event: stderr, or unparseable stdout. */
  | { type: "log"; stream: "stdout" | "stderr"; line: string }
  | { type: "end"; result: RunResult };

export type AdapterEventType = AdapterEvent["type"];

export interface AdapterRun {
  /** Every event of the run. Each iteration replays from the start and finishes after `end`. */
  events: AsyncIterable<AdapterEvent>;
  /** Resolves once the process has exited. Never rejects. */
  result: Promise<RunResult>;
  /** Kills the process tree; the result says `cancelled`. Resolves once the process has exited. */
  cancel(): Promise<void>;
}

/** One harness CLI driven headless (D-002). */
export interface HarnessAdapter {
  id: HarnessId;
  /** Starts the task with the worktree as working directory. */
  start(task: Task, worktree: string): AdapterRun;
}

export function emptyTokenUsage(): TokenUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}
