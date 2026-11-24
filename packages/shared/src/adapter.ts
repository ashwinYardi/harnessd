import type { HarnessId } from "./index.ts";

/** A unit of work handed to a harness adapter. */
export interface Task {
  id: string;
  title: string;
  /** Full prompt passed to the harness CLI. */
  prompt: string;
  /** Wall-clock budget (D-014). The run is killed and reported as `timeout` when it runs over. */
  budgetMs: number;
  /**
   * Model turns the run may take (D-045). Claude Code gets `--max-turns`; the Codex and
   * OpenCode adapters count turns and stop the run at the cap with `error` and "turn cap".
   */
  maxTurns?: number;
  /** Harness model name or alias. Omitted means the harness default. */
  model?: string;
  /** Continue the part's earlier session on a QA send-back (MET-156). */
  resumeSessionId?: string;
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
  /** Model turns the harness reported, when it did. In memory only, never in loop.json. */
  turns?: number;
  /** True when the harness sent no usage event. In memory only, never in loop.json. */
  usageUnknown?: true;
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

/**
 * A failure the human fixes outside the run: a usage limit, a harness that is not signed in,
 * a stalled run, or a turn-capped run (D-045, D-048). In memory only, never in loop.json.
 */
export type RunFailureReason = "usage_limit" | "auth" | "stalled" | "turn_cap";

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
  /** True when `Task.resumeSessionId` is honored (MET-156). Unset means a cold run. */
  canResume?: boolean;
  /** Starts the task with the worktree as working directory. */
  start(task: Task, worktree: string): AdapterRun;
}

export function emptyTokenUsage(): TokenUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}
