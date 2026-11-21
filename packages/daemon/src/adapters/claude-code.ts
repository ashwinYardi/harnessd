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

  outcome(exitCode: number | null): ParsedOutcome {
    const out: ParsedOutcome = { ok: this.isError === false, tokens: this.tokens() };
    if (this.costUsd !== undefined) out.costUsd = this.costUsd;
    if (this.sessionId !== undefined) out.sessionId = this.sessionId;
    if (this.finalText !== undefined) out.finalText = this.finalText;
    if (this.isError) out.error = this.errorSubtype ?? "harness reported an error";
    else if (exitCode !== 0) out.error = `exited with code ${exitCode}`;
    return out;
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
