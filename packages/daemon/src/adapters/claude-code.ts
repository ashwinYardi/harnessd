import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  type AdapterEvent,
  emptyTokenUsage,
  type HarnessAdapter,
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
    start: (task, worktree) =>
      startProcessRun({
        task,
        worktree,
        bin: options.bin ?? process.env.HARNESSD_CLAUDE_BIN ?? "claude",
        argv: claudeArgs(task, options, worktree),
        parser: (emit) => new StreamJsonParser(emit),
        ...(options.killGraceMs !== undefined ? { killGraceMs: options.killGraceMs } : {}),
        ...(options.env !== undefined ? { env: options.env } : {}),
      }),
  };
}

/** Turns Claude Code stream-json lines into adapter events and tracks run totals. */
class StreamJsonParser implements LineParser {
  sessionId: string | undefined;
  finalText: string | undefined;
  costUsd: number | undefined;
  /** undefined until a `result` event arrives. */
  isError: boolean | undefined;
  errorSubtype: string | undefined;
  #lastStderr: string | undefined;
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

  stderr(line: string): void {
    if (line.trim() !== "") this.#lastStderr = line.trim();
  }

  outcome(exitCode: number | null): ParsedOutcome {
    const out: ParsedOutcome = { ok: this.isError === false, tokens: this.tokens() };
    if (this.costUsd !== undefined) out.costUsd = this.costUsd;
    if (this.sessionId !== undefined) out.sessionId = this.sessionId;
    if (this.finalText !== undefined) out.finalText = this.finalText;
    if (exitCode === 0 && out.ok) return out;
    const limit = this.#limitText();
    if (limit !== undefined) {
      out.limited = true;
      out.error = clip(limit);
      const resetAt = parseResetAt(limit, new Date());
      if (resetAt !== undefined) out.resetAt = resetAt;
      return out;
    }
    out.error = clip(this.#errorReason(exitCode));
    return out;
  }

  /**
   * The limit message of a failed run. The error result text decides when there is one.
   * Otherwise the last stderr line does: an earlier 429 that Claude retried is no limit.
   */
  #limitText(): string | undefined {
    const text = this.#errorResultText() ?? this.#lastStderr;
    return text !== undefined && classifyLimit(text) ? text : undefined;
  }

  #errorResultText(): string | undefined {
    const text = this.isError ? this.finalText?.trim() : undefined;
    return text === "" ? undefined : text;
  }

  /** The real reason a run did not succeed. Never the bare subtype "success". */
  #errorReason(exitCode: number | null): string {
    return (
      this.#errorResultText() ??
      this.#lastStderr ??
      this.errorSubtype ??
      (exitCode !== null && exitCode !== 0 ? `exited with code ${exitCode}` : undefined) ??
      (this.isError ? "harness reported an error" : "no result event")
    );
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
    // The subtype is "success" even on some errors (a usage limit); it is no reason then.
    if (this.isError && typeof value.subtype === "string" && value.subtype !== "success") {
      this.errorSubtype = value.subtype;
    }
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

const ERROR_MAX = 500;

export type LimitKind = "usage" | "rate" | "overloaded";

/**
 * Messages Claude Code prints when a usage or rate limit stops a run (MET-70).
 * They come in the result event's text or on stderr. Keep every pattern in this table.
 */
const LIMIT_PATTERNS: ReadonlyArray<{ kind: LimitKind; pattern: RegExp }> = [
  { kind: "usage", pattern: /usage limit reached/i },
  { kind: "usage", pattern: /hit your (?:usage )?limit/i },
  { kind: "usage", pattern: /\b(?:\d+-hour|weekly|session|opus) limit reached\b/i },
  // Not a bare "rate limit": an agent's own text may mention rate limiting.
  { kind: "rate", pattern: /\brate[ _-]?limit(?:ed\b|_error\b|\s+(?:reached|exceeded|hit)\b)/i },
  { kind: "rate", pattern: /(?:HTTP|status|API Error:?|\()\s*429\b|\b429 Too Many Requests\b/i },
  { kind: "overloaded", pattern: /overloaded_error|api[_ ]error\b.*overloaded/i },
];

/** Which limit, if any, a line of harness output names. */
export function classifyLimit(text: string): LimitKind | undefined {
  return LIMIT_PATTERNS.find(({ pattern }) => pattern.test(text))?.kind;
}

/**
 * The reset time a limit message gives, as an ISO time, or undefined.
 * Reads a unix epoch after a pipe ("...|1763660400") or a clock time with an optional zone
 * ("resets 7pm (America/New_York)", "resets 19:00"). A clock time is the next one after
 * `now`, in the stated zone, or in UTC when none is given.
 */
export function parseResetAt(text: string, now: Date): string | undefined {
  const epoch = /\|\s*(\d{9,13})\b/.exec(text);
  if (epoch?.[1] !== undefined) {
    // Seconds, or milliseconds when it has 12 or more digits.
    const ms = epoch[1].length >= 12 ? Number(epoch[1]) : Number(epoch[1]) * 1000;
    return new Date(ms).toISOString();
  }

  const clock = /\bresets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([^)]+)\))?/i.exec(
    text,
  );
  if (clock?.[1] === undefined) return undefined;
  let hour = Number(clock[1]);
  const minute = clock[2] === undefined ? 0 : Number(clock[2]);
  const meridiem = clock[3]?.toLowerCase();
  if (minute > 59) return undefined;
  if (meridiem !== undefined) {
    if (hour < 1 || hour > 12) return undefined;
    hour = (hour % 12) + (meridiem === "pm" ? 12 : 0);
  } else if (hour > 23) {
    return undefined;
  }
  const zone = clock[4]?.trim() ?? "UTC";
  try {
    const today = wallClock(now, zone);
    for (let day = 0; day <= 2; day++) {
      const at = zonedTime(today.year, today.month, today.day + day, hour, minute, zone);
      if (at > now.getTime()) return new Date(at).toISOString();
    }
  } catch {
    // RangeError: an unknown time zone.
  }
  return undefined;
}

function wallClock(at: Date | number, zone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value);
  return {
    year: part("year"),
    month: part("month"),
    day: part("day"),
    hour: part("hour"),
    minute: part("minute"),
    second: part("second"),
  };
}

/** The epoch ms of a wall-clock time in `zone`. Date.UTC rolls an overflowing day over. */
function zonedTime(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  zone: string,
): number {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  let at = wall;
  // Two passes settle the zone offset across a DST change.
  for (let i = 0; i < 2; i++) {
    const seen = wallClock(at, zone);
    const seenMs = Date.UTC(
      seen.year,
      seen.month - 1,
      seen.day,
      seen.hour,
      seen.minute,
      seen.second,
    );
    at += wall - seenMs;
  }
  return at;
}

function clip(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > ERROR_MAX ? `${line.slice(0, ERROR_MAX - 1)}…` : line;
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
  return oneLine(text);
}
