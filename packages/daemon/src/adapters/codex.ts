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
 *
 * MET-156: a QA send-back uses `codex exec resume <id>`. On 0.171.0 that subcommand refuses
 * `--sandbox`, so the same setting goes in as the `sandbox_mode` config override. Every
 * isolation flag stays; nothing is dropped for the resume.
 */
export function codexArgs(task: Task, options: CodexOptions = {}, cwd?: string): string[] {
  const resume = task.resumeSessionId;
  // MET-219: a coordinator run gets the read-only sandbox in place of full access.
  const sandbox = task.readOnly === true ? "read-only" : "danger-full-access";
  const args = [
    "exec",
    ...(resume === undefined ? [] : ["resume", resume]),
    "--json",
    // D-031: no owner config, no execpolicy rules. Auth still comes from CODEX_HOME.
    "--ignore-user-config",
    "--ignore-rules",
    // The synced .codex/hooks.json comes from the skill pack, so the run need not trust it.
    "--dangerously-bypass-hook-trust",
    // D-032 (amended): a normal run gets no OS sandbox, as for Claude runs. The seatbelt
    // sandbox hides the keychain (so gh has no login) and keeps .git read-only (so git commit
    // fails). MET-219: a read-only coordinator needs neither writes nor gh, so it uses it.
    ...(resume === undefined ? ["--sandbox", sandbox] : ["-c", `sandbox_mode="${sandbox}"`]),
    // Nobody is there to answer a prompt.
    "-c",
    'approval_policy="never"',
    // D-045: about 5k tokens of one tool result, matching the Claude Code cap.
    "-c",
    "tool_output_token_limit=5000",
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
    canResume: true,
    start: (task, worktree) =>
      startProcessRun({
        task,
        worktree,
        bin: options.bin ?? process.env.HARNESSD_CODEX_BIN ?? "codex",
        argv: codexArgs(task, options, worktree),
        parser: (emit) => new CodexJsonParser(emit),
        ...(options.killGraceMs !== undefined ? { killGraceMs: options.killGraceMs } : {}),
        ...(options.env !== undefined ? { env: options.env } : {}),
        ...(task.maxTurns === undefined ? {} : { maxTurns: task.maxTurns }),
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
/** Transient reconnect events are filtered before classifying terminal failures. */
const USAGE_LIMIT = /usage[ _]limit|insufficient_quota|quota (?:exceeded|exhausted)/i;
const RATE_LIMIT =
  /\brate[ _-]?limit(?:ed\b|_error\b|_exceeded\b|\s+(?:reached|exceeded|hit)\b)|(?:HTTP|status)\s*429\b|\b429 Too Many Requests\b/i;
const AUTH =
  /\b401\b|unauthori[sz]ed|not (logged|signed) in|log ?in again|codex login|authenticat|api key|token (has )?expired/i;

/** Sorts a failure message into a reason the human fixes outside the run. */
export function failureReason(message: string): RunFailureReason | undefined {
  if (USAGE_LIMIT.test(message) || RATE_LIMIT.test(message)) return "usage_limit";
  if (AUTH.test(message)) return "auth";
  return undefined;
}

const REASON_PREFIX: Record<RunFailureReason, string> = {
  usage_limit: "usage limit reached",
  auth: "not signed in",
  stalled: "stalled",
  turn_cap: "turn cap",
};

/** Codex can report either a retry interval or a dated retry time. */
function codexResetAt(message: string, now: number): string | undefined {
  const relative = /\btry again in (\d+) (second|minute|hour|day)s?\b/i.exec(message);
  if (relative?.[2] !== undefined) {
    const unitMs = { second: 1_000, minute: 60_000, hour: 3_600_000, day: 86_400_000 };
    const unit = relative[2].toLowerCase() as keyof typeof unitMs;
    const reset = new Date(now + Number(relative[1]) * unitMs[unit]);
    if (Number.isFinite(reset.getTime())) return reset.toISOString();
  }
  const absolute = /\btry again at (.+?)[.]?$/i.exec(message)?.[1];
  if (absolute === undefined) return undefined;
  const reset = Date.parse(absolute);
  return Number.isFinite(reset) ? new Date(reset).toISOString() : undefined;
}

type ItemPhase = "item.started" | "item.updated" | "item.completed";

/** Turns `codex exec --json` lines into adapter events and tracks run totals. */
class CodexJsonParser implements LineParser {
  #emit: (event: AdapterEvent) => void;
  #sessionId: string | undefined;
  #finalText: string | undefined;
  #tokens = emptyTokenUsage();
  /** Completed tool items, the turn count for the cap and the D-043 log line (D-045). */
  #turns = 0;
  /** One `turn.completed` per prompt marks a run that produced a turn. */
  #turnCompleted = 0;
  #failure: string | undefined;
  #lastStderr: string | undefined;
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
    if (line.trim() !== "") this.#lastStderr = line.trim();
  }

  turnCount(): number {
    return this.#turns;
  }

  outcome(exitCode: number | null): ParsedOutcome {
    const ok = this.#turnCompleted > 0 && this.#failure === undefined;
    const out: ParsedOutcome = { ok, tokens: { ...this.#tokens } };
    // A killed run never sends turn.completed, so its zeros mean "unknown", not "none" (MET-187).
    if (this.#turnCompleted === 0) out.usageUnknown = true;
    if (this.#turns > 0) out.turns = this.#turns;
    if (this.#sessionId !== undefined) out.sessionId = this.#sessionId;
    if (this.#finalText !== undefined) out.finalText = this.#finalText;
    const message = this.#failure ?? (!ok || exitCode !== 0 ? this.#lastStderr : undefined);
    const reason = message === undefined ? undefined : failureReason(message);
    if (reason !== undefined && message !== undefined) {
      out.reason = reason;
      out.error = `${REASON_PREFIX[reason]}: ${message}`;
      if (reason === "usage_limit") {
        const resetAt = codexResetAt(message, Date.now());
        if (resetAt !== undefined) out.resetAt = resetAt;
      }
    } else if (message !== undefined) {
      out.error = message;
    } else if (exitCode !== 0) {
      out.error = `exited with code ${exitCode}`;
    } else if (this.#turnCompleted === 0) {
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
      case "item.completed": {
        if (!isRecord(value.item)) return false;
        const handled = this.#item(value.type, value.item);
        if (handled && value.type === "item.completed" && countsAsTurn(value.item.type)) {
          this.#turns++;
        }
        return handled;
      }
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
    this.#turnCompleted++;
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

/** Completed items that count as one turn for the cap and the D-043 log line (D-045). */
function countsAsTurn(type: unknown): boolean {
  return (
    type === "command_execution" ||
    type === "file_change" ||
    type === "mcp_tool_call" ||
    type === "web_search"
  );
}

function todoSummary(items: unknown): string {
  const list = Array.isArray(items) ? items.filter(isRecord) : [];
  const done = list.filter((i) => i.completed === true).length;
  const texts = list.flatMap((i) => (typeof i.text === "string" ? [i.text] : []));
  return `${done}/${list.length} done: ${texts.join("; ")}`;
}
