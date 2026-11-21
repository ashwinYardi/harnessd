// The Codex CLI adapter: `codex exec --json` in the worktree (D-002, D-032).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AdapterEvent,
  emptyTokenUsage,
  type HarnessAdapter,
  type RunFailureReason,
  type Task,
  type TokenUsage,
} from "@harnessd/shared";
import { parse as parseToml } from "smol-toml";
import {
  count,
  isRecord,
  type LineParser,
  oneLine,
  type ParsedOutcome,
  startProcessRun,
} from "./process.ts";

export interface CodexOptions {
  /** Path to the `codex` binary. Defaults to $HARNESSD_CODEX_BIN, then `codex` on PATH. */
  bin?: string;
  /** Model used when the task sets none. */
  model?: string;
  /** Time between SIGTERM and SIGKILL when the run is killed. Default 5000. */
  killGraceMs?: number;
  /** Extra environment for the child, merged over process.env. */
  env?: Record<string, string>;
}

/**
 * Builds the argv for `codex exec --json` (D-032). `cwd` is the worktree: it holds the synced
 * `.codex/config.toml`, whose MCP servers go in as -c overrides, because codex ignores project
 * config in an untrusted directory.
 */
export function codexArgs(task: Task, options: CodexOptions = {}, cwd?: string): string[] {
  const args = [
    "exec",
    "--json",
    // D-031: no owner config, no execpolicy rules. Auth still comes from CODEX_HOME.
    "--ignore-user-config",
    "--ignore-rules",
    // The synced .codex/hooks.json comes from the skill pack, so the run need not trust it.
    "--dangerously-bypass-hook-trust",
    // D-032 (amended): no OS sandbox, as for Claude runs. The seatbelt sandbox hides the
    // keychain (so gh has no login) and keeps .git read-only (so git commit fails).
    "--sandbox",
    "danger-full-access",
    // Nobody is there to answer a prompt.
    "-c",
    'approval_policy="never"',
  ];
  if (cwd !== undefined) args.push(...mcpOverrides(cwd));
  const model = task.model ?? options.model;
  if (model) args.push("--model", model);
  args.push("--", task.prompt);
  return args;
}

export function createCodexAdapter(options: CodexOptions = {}): HarnessAdapter {
  return {
    id: "codex",
    start: (task, worktree) =>
      startProcessRun({
        task,
        worktree,
        bin: options.bin ?? process.env.HARNESSD_CODEX_BIN ?? "codex",
        argv: codexArgs(task, options, worktree),
        parser: (emit) => new CodexJsonParser(emit),
        ...(options.killGraceMs !== undefined ? { killGraceMs: options.killGraceMs } : {}),
        ...(options.env !== undefined ? { env: options.env } : {}),
      }),
  };
}

/** One `-c mcp_servers.<name>={...}` per server in the worktree's `.codex/config.toml`. */
function mcpOverrides(cwd: string): string[] {
  const file = join(cwd, ".codex", "config.toml");
  if (!existsSync(file)) return [];
  let servers: unknown;
  try {
    servers = parseToml(readFileSync(file, "utf8")).mcp_servers;
  } catch {
    // A broken synced file must not stop the run; the run just has no MCP servers.
    return [];
  }
  if (!isRecord(servers)) return [];
  return Object.entries(servers).flatMap(([name, server]) =>
    isRecord(server) ? ["-c", `mcp_servers.${tomlKey(name)}=${inlineToml(server)}`] : [],
  );
}

const BARE_KEY = /^[A-Za-z0-9_-]+$/;

function tomlKey(key: string): string {
  return BARE_KEY.test(key) ? key : JSON.stringify(key);
}

/** A TOML inline value. A JSON string is a valid TOML basic string. */
function inlineToml(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map(inlineToml).join(", ")}]`;
  if (isRecord(value)) {
    const pairs = Object.entries(value).map(([k, v]) => `${tomlKey(k)} = ${inlineToml(v)}`);
    return pairs.length === 0 ? "{}" : `{ ${pairs.join(", ")} }`;
  }
  return JSON.stringify(String(value));
}

/** Codex prints these while it retries; the run goes on, so they are logs, not failures. */
const TRANSIENT_ERROR = /^Reconnecting\.\.\./;
/** Codex retries a short rate limit itself, so only a spent plan or quota counts. */
const USAGE_LIMIT = /usage limit|usage_limit|quota/i;
const AUTH =
  /\b401\b|unauthori[sz]ed|not (logged|signed) in|log ?in again|codex login|authenticat|api key|token (has )?expired/i;

/** Sorts a failure message into a reason the human fixes outside the run. */
export function failureReason(message: string): RunFailureReason | undefined {
  if (USAGE_LIMIT.test(message)) return "usage_limit";
  if (AUTH.test(message)) return "auth";
  return undefined;
}

const REASON_PREFIX: Record<RunFailureReason, string> = {
  usage_limit: "usage limit reached",
  auth: "not signed in",
};

type ItemPhase = "item.started" | "item.updated" | "item.completed";

/** Turns `codex exec --json` lines into adapter events and tracks run totals. */
class CodexJsonParser implements LineParser {
  #emit: (event: AdapterEvent) => void;
  #sessionId: string | undefined;
  #finalText: string | undefined;
  #tokens = emptyTokenUsage();
  #turns = 0;
  #failure: string | undefined;
  #stderr: string[] = [];
  /** Items already shown as a tool event, so a started item is not shown twice. */
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
    if (line.trim() !== "") this.#stderr.push(line.trim());
  }

  outcome(exitCode: number | null): ParsedOutcome {
    const ok = this.#turns > 0 && this.#failure === undefined;
    const out: ParsedOutcome = { ok, tokens: { ...this.#tokens } };
    if (this.#sessionId !== undefined) out.sessionId = this.#sessionId;
    if (this.#finalText !== undefined) out.finalText = this.#finalText;
    let message = this.#failure;
    let reason = message === undefined ? undefined : failureReason(message);
    if (message === undefined && exitCode !== 0) {
      // No event said why: the CLI may have failed before its first event.
      const line = this.#stderr.find((l) => failureReason(l) !== undefined);
      if (line !== undefined) {
        message = line;
        reason = failureReason(line);
      }
    }
    if (reason !== undefined && message !== undefined) {
      out.reason = reason;
      out.error = `${REASON_PREFIX[reason]}: ${message}`;
    } else if (message !== undefined) {
      out.error = message;
    } else if (exitCode !== 0) {
      out.error = `exited with code ${exitCode}`;
    } else if (this.#turns === 0) {
      out.error = "no turn.completed event";
    }
    return out;
  }

  /** Handles one event; false means it is unknown and goes to the log as raw. */
  #event(value: Record<string, unknown>): boolean {
    switch (value.type) {
      case "thread.started":
        if (typeof value.thread_id === "string") this.#sessionId = value.thread_id;
        return true;
      case "turn.started":
        return true;
      case "turn.completed":
        this.#turn(value.usage);
        return true;
      case "turn.failed": {
        const error = isRecord(value.error) ? value.error.message : undefined;
        // The turn's own message is the final word, over an earlier error event.
        this.#failure = typeof error === "string" && error !== "" ? error : "turn failed";
        return true;
      }
      case "error": {
        const message = typeof value.message === "string" ? value.message : "";
        if (TRANSIENT_ERROR.test(message)) return false;
        this.#failure ??= message || "harness reported an error";
        return true;
      }
      case "item.started":
      case "item.updated":
      case "item.completed":
        return isRecord(value.item) && this.#item(value.type, value.item);
      default:
        return false;
    }
  }

  #item(phase: ItemPhase, item: Record<string, unknown>): boolean {
    const id = typeof item.id === "string" ? item.id : undefined;
    switch (item.type) {
      case "agent_message":
        if (phase === "item.completed" && typeof item.text === "string" && item.text !== "") {
          this.#finalText = item.text;
          this.#emit({ type: "text", text: item.text });
        }
        return true;
      case "command_execution": {
        const command = typeof item.command === "string" ? item.command : "";
        if (phase === "item.started") this.#tool("shell", command);
        if (phase === "item.completed") {
          const code = typeof item.exit_code === "number" ? ` (exit ${item.exit_code})` : "";
          this.#tool("shell", `${command}${code}`);
        }
        return true;
      }
      case "file_change": {
        if (phase !== "item.completed") return true;
        const changes = Array.isArray(item.changes) ? item.changes : [];
        const paths = changes.flatMap((c) =>
          isRecord(c) && typeof c.path === "string" ? [c.path] : [],
        );
        this.#tool("edit", paths.join(", "));
        return true;
      }
      case "mcp_tool_call": {
        const server = typeof item.server === "string" ? item.server : "mcp";
        const tool = typeof item.tool === "string" ? item.tool : "tool";
        const args = item.arguments === undefined ? "" : (JSON.stringify(item.arguments) ?? "");
        this.#once(id, phase, `${server}.${tool}`, args);
        return true;
      }
      case "web_search":
        this.#once(id, phase, "web_search", typeof item.query === "string" ? item.query : "");
        return true;
      case "todo_list":
        this.#once(id, phase, "todo", todoSummary(item.items));
        return true;
      default:
        // reasoning, error warnings and future item types.
        return false;
    }
  }

  /** Shows a tool once per item, at whichever of started or completed comes first. */
  #once(id: string | undefined, phase: ItemPhase, name: string, summary: string): void {
    if (phase === "item.updated") return;
    if (id !== undefined) {
      if (this.#shown.has(id)) return;
      this.#shown.add(id);
    }
    this.#tool(name, summary);
  }

  #tool(name: string, summary: string): void {
    this.#emit({ type: "tool", name, summary: oneLine(summary) });
  }

  #turn(usage: unknown): void {
    this.#turns++;
    // A turn with no usage still emits the running totals.
    const u = isRecord(usage) ? usage : {};
    const cached = count(u.cached_input_tokens);
    const add: TokenUsage = {
      input: Math.max(0, count(u.input_tokens) - cached),
      output: count(u.output_tokens),
      cacheRead: cached,
      cacheWrite: 0,
    };
    this.#tokens = {
      input: this.#tokens.input + add.input,
      output: this.#tokens.output + add.output,
      cacheRead: this.#tokens.cacheRead + add.cacheRead,
      cacheWrite: 0,
    };
    this.#emit({ type: "usage", tokens: { ...this.#tokens } });
  }

  #raw(line: string): void {
    this.#emit({ type: "log", stream: "stdout", line });
  }
}

function todoSummary(items: unknown): string {
  const list = Array.isArray(items) ? items.filter(isRecord) : [];
  const done = list.filter((i) => i.completed === true).length;
  const texts = list.flatMap((i) => (typeof i.text === "string" ? [i.text] : []));
  return `${done}/${list.length} done: ${texts.join("; ")}`;
}
