// The OpenCode CLI adapter: `opencode run --format json` in the worktree (D-002, D-036).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import {
  type AdapterEvent,
  type AdapterRun,
  emptyTokenUsage,
  type HarnessAdapter,
  type RunFailureReason,
  type Task,
  type TokenUsage,
} from "@harnessd/shared";
import {
  count,
  isRecord,
  type LineParser,
  oneLine,
  type ParsedOutcome,
  startProcessRun,
} from "./process.ts";

export interface OpenCodeOptions {
  /** Path to the `opencode` binary. Defaults to $HARNESSD_OPENCODE_BIN, then `opencode` on PATH. */
  bin?: string;
  /** Model used when the task sets none, as `<provider>/<model>[#variant]`. */
  model?: string;
  /** Time between SIGTERM and SIGKILL when the run is killed. Default 5000. */
  killGraceMs?: number;
  /** Extra environment for the child, merged over process.env. */
  env?: Record<string, string>;
}

/**
 * Builds the argv for `opencode run --format json` (D-036). The model keeps its `#variant`:
 * OpenCode 2.x reads the thinking level from it. The run never continues a session.
 */
export function openCodeArgs(task: Task, options: OpenCodeOptions = {}): string[] {
  // --standalone: a private server for this run, not the owner's background service.
  // The non-interactive CLI rejects pending permissions and lets the session continue.
  const args = ["run", "--format", "json", "--standalone"];
  const model = task.model ?? options.model;
  if (model) args.push("-m", model);
  args.push("--", task.prompt);
  return args;
}

export function createOpenCodeAdapter(options: OpenCodeOptions = {}): HarnessAdapter {
  return {
    id: "opencode",
    start: (task, worktree) => {
      // D-036 isolation: an empty global config dir replaces ~/.config/opencode for this run.
      const configDir = mkdtempSync(join(tmpdir(), "harnessd-opencode-config-"));
      const run: AdapterRun = startProcessRun({
        task,
        worktree,
        bin: options.bin ?? process.env.HARNESSD_OPENCODE_BIN ?? "opencode",
        argv: openCodeArgs(task, options),
        parser: (emit) => new OpenCodeJsonParser(emit),
        ...(options.killGraceMs !== undefined ? { killGraceMs: options.killGraceMs } : {}),
        env: {
          ...options.env,
          OPENCODE_CONFIG_DIR: configDir,
          // OpenCode 1.x switch for ~/.claude files; 2.0.20 ignores it (D-036 gap).
          OPENCODE_DISABLE_CLAUDE_CODE: "1",
          OPENCODE_DISABLE_AUTOUPDATE: "1",
          // OpenCode takes its project folder from PWD before the process cwd.
          PWD: worktree,
        },
      });
      void run.result.finally(() => rmSync(configDir, { recursive: true, force: true }));
      return run;
    },
  };
}

const USAGE_LIMIT =
  /usage[ _]limit|quota|insufficient[ _](?:balance|credits?|funds)|\b402\b|payment required/i;
const RATE_LIMIT =
  /\brate[ _-]?limit(?:ed\b|_error\b|_exceeded\b|\s+(?:reached|exceeded|hit)\b)|(?:HTTP|status)\s*429\b|\b429 Too Many Requests\b/i;
const AUTH =
  /\b401\b|unauthori[sz]ed|not (?:logged|signed) in|opencode auth login|api[ _-]?key|authenticat|token (?:has )?expired/i;

/** OpenCode 2.x error types (`error.type`) that name the reason outright. */
const TYPED_REASON: Record<string, RunFailureReason> = {
  "provider.quota": "usage_limit",
  "provider.rate-limit": "usage_limit",
  "provider.auth": "auth",
};

/** Sorts a failure message into a reason the human fixes outside the run. */
export function openCodeFailureReason(message: string): RunFailureReason | undefined {
  if (USAGE_LIMIT.test(message) || RATE_LIMIT.test(message)) return "usage_limit";
  if (AUTH.test(message)) return "auth";
  return undefined;
}

const REASON_PREFIX: Record<RunFailureReason, string> = {
  usage_limit: "usage limit reached",
  auth: "not signed in",
};

const UNIT_MS = { second: 1_000, minute: 60_000, hour: 3_600_000, day: 86_400_000 };

/** The reset time a limit message gives: "in N hours", or "at <date>". */
function resetFromMessage(message: string, now: number): string | undefined {
  const relative = /\b(?:try again|resets?) in (\d+) (second|minute|hour|day)s?\b/i.exec(message);
  if (relative?.[2] !== undefined) {
    const unit = relative[2].toLowerCase() as keyof typeof UNIT_MS;
    return new Date(now + Number(relative[1]) * UNIT_MS[unit]).toISOString();
  }
  const absolute = /\b(?:try again|resets?) at (\S+?)[.]?(?:\s|$)/i.exec(message)?.[1];
  if (absolute === undefined) return undefined;
  const reset = Date.parse(absolute);
  return Number.isFinite(reset) ? new Date(reset).toISOString() : undefined;
}

interface Failure {
  message: string;
  type?: string;
  retryAfterMs?: number;
}

const CANCELLED_INPUT = "Cancelled a request for input this run cannot answer:";

/** Turns `opencode run --format json` lines into adapter events and tracks run totals. */
class OpenCodeJsonParser implements LineParser {
  #emit: (event: AdapterEvent) => void;
  #sessionId: string | undefined;
  #finalText: string | undefined;
  #tokens = emptyTokenUsage();
  #cost: number | undefined;
  #steps = 0;
  #cancelledInput = false;
  #failure: Failure | undefined;
  #lastStderr: string | undefined;
  #stderrError: string | undefined;
  /** Tool calls already shown, so a call is shown once. */
  #shown = new Set<string>();

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
      this.#raw(raw);
      return;
    }
    if (!isRecord(value) || !this.#event(value)) this.#raw(raw);
  }

  stderr(line: string): void {
    const message = stripVTControlCharacters(line).trim();
    if (message !== "") this.#lastStderr = message;
    if (message.startsWith("Error: ")) this.#stderrError ??= message;
  }

  outcome(exitCode: number | null): ParsedOutcome {
    const ok = this.#steps > 0 && this.#failure === undefined;
    const out: ParsedOutcome = { ok, tokens: { ...this.#tokens } };
    if (this.#cost !== undefined) out.costUsd = this.#cost;
    if (this.#sessionId !== undefined) out.sessionId = this.#sessionId;
    if (this.#finalText !== undefined) out.finalText = this.#finalText;
    let failure = this.#failure;
    if (failure === undefined && (!ok || exitCode !== 0)) {
      const message = this.#stderrError ?? this.#lastStderr;
      if (message !== undefined) failure = { message };
    }
    const reason =
      failure === undefined
        ? undefined
        : ((failure.type === undefined ? undefined : TYPED_REASON[failure.type]) ??
          openCodeFailureReason(failure.message));
    if (
      ok &&
      this.#cancelledInput &&
      exitCode === 1 &&
      this.#stderrError === undefined &&
      reason === undefined
    ) {
      out.acceptedExitCode = 1;
      return out;
    }
    if (failure === undefined) {
      if (exitCode !== 0) out.error = `exited with code ${exitCode}`;
      else if (this.#steps === 0) out.error = "no step event";
      return out;
    }
    if (reason === undefined) {
      out.error = failure.message;
      return out;
    }
    out.reason = reason;
    out.error = `${REASON_PREFIX[reason]}: ${failure.message}`;
    if (reason === "usage_limit") {
      const now = Date.now();
      const resetAt =
        failure.retryAfterMs !== undefined
          ? new Date(now + failure.retryAfterMs).toISOString()
          : resetFromMessage(failure.message, now);
      if (resetAt !== undefined) out.resetAt = resetAt;
    }
    return out;
  }

  /** Handles one event; false means it is unknown and goes to the log as raw. */
  #event(value: Record<string, unknown>): boolean {
    if (typeof value.sessionID === "string") this.#sessionId ??= value.sessionID;
    const part = isRecord(value.part) ? value.part : {};
    switch (value.type) {
      case "step_start":
        this.#steps++;
        return true;
      case "step_finish":
        // 2.0.20 prints no step_finish for the last step, so a start alone counts as a step.
        this.#usage(part);
        return true;
      case "text":
        if (typeof part.text === "string" && part.text !== "") {
          this.#finalText = part.text;
          this.#emit({ type: "text", text: part.text });
        }
        return true;
      case "tool_use":
        this.#tool(part);
        return true;
      case "error":
        this.#error(value.error);
        return true;
      default:
        // reasoning (only with --thinking) and future event types.
        return false;
    }
  }

  #tool(part: Record<string, unknown>): void {
    const id = typeof part.id === "string" ? part.id : undefined;
    if (id !== undefined) {
      if (this.#shown.has(id)) return;
      this.#shown.add(id);
    }
    const name = typeof part.tool === "string" ? part.tool : "tool";
    const state = isRecord(part.state) ? part.state : {};
    let summary = inputSummary(state.input);
    if (state.status === "error") {
      const error = typeof state.error === "string" ? state.error : "failed";
      summary = summary === "" ? `error: ${error}` : `${summary} (error: ${error})`;
    }
    this.#emit({ type: "tool", name, summary: oneLine(summary) });
  }

  #usage(part: Record<string, unknown>): void {
    const t = isRecord(part.tokens) ? part.tokens : {};
    const cache = isRecord(t.cache) ? t.cache : {};
    // OpenCode's input already excludes cache reads: a cached step reports less input than read.
    const add: TokenUsage = {
      input: count(t.input),
      output: count(t.output) + count(t.reasoning),
      cacheRead: count(cache.read),
      cacheWrite: count(cache.write),
    };
    this.#tokens = {
      input: this.#tokens.input + add.input,
      output: this.#tokens.output + add.output,
      cacheRead: this.#tokens.cacheRead + add.cacheRead,
      cacheWrite: this.#tokens.cacheWrite + add.cacheWrite,
    };
    if (typeof part.cost === "number" && Number.isFinite(part.cost)) {
      this.#cost = (this.#cost ?? 0) + part.cost;
    }
    const event: AdapterEvent = { type: "usage", tokens: { ...this.#tokens } };
    if (this.#cost !== undefined) event.costUsd = this.#cost;
    this.#emit(event);
  }

  #error(error: unknown): void {
    const e = isRecord(error) ? error : {};
    const message =
      typeof e.message === "string" && e.message !== "" ? e.message : "harness reported an error";
    if (message.startsWith(CANCELLED_INPUT)) {
      this.#cancelledInput = true;
      const title = message.slice(CANCELLED_INPUT.length).trim();
      this.#raw(`${oneLine(title)} request cancelled; the run goes on`);
      return;
    }
    // Keep the first failure. Cancelled input is only a log event.
    if (this.#failure !== undefined) return;
    const failure: Failure = { message };
    if (typeof e.type === "string") failure.type = e.type;
    const retry = e.retryAfterMs ?? (isRecord(e.rateLimit) ? e.rateLimit.retryAfterMs : undefined);
    if (typeof retry === "number" && Number.isFinite(retry) && retry > 0) {
      failure.retryAfterMs = retry;
    }
    this.#failure = failure;
  }

  #raw(line: string): void {
    this.#emit({ type: "log", stream: "stdout", line });
  }
}

/** The one input field that says what a tool call did, else the input as JSON. */
function inputSummary(input: unknown): string {
  if (!isRecord(input)) return "";
  for (const key of ["command", "path", "filePath", "pattern", "url", "query", "description"]) {
    const value = input[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return Object.keys(input).length === 0 ? "" : (JSON.stringify(input) ?? "");
}
