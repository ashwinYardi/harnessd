// The split plan: which backend and frontend parts an issue needs (SPEC "The team", D-014).
// See docs/LOOP.md.
import type {
  Call,
  HarnessAdapter,
  Issue,
  ResolvedAgentConfig,
  Size,
  Task,
  TokenUsage,
} from "@harnessd/shared";
import { COORDINATOR_MAX_TURNS } from "./dispatch.ts";
import { extractJson, type RunReply, runForReply } from "./grill.ts";
import type { GrillContext } from "./prompt.ts";

/** Roles a planned part can have. QA is added by harnessd, never planned. */
export const PART_ROLES = ["backend", "frontend"] as const;
export type PartRole = (typeof PART_ROLES)[number];

export function isPartRole(value: string): value is PartRole {
  return (PART_ROLES as readonly string[]).includes(value);
}

const SIZES: readonly Size[] = ["S", "M", "L"];

/** At most this many parts per issue; more means the issue itself is wrong. */
export const MAX_PLAN_PARTS = 6;

/** A decision record a part depends on, named in its brief (D-044). */
export interface PlanDecision {
  /** `D-NNN`, a file in `docs/decisions/`. */
  id: string;
  /** One sentence on why it applies to this part. */
  line: string;
}

export interface PlanPart {
  role: PartRole;
  title: string;
  /** The brief the agent works from. */
  prompt: string;
  /** S or M. L is parsed so the loop can refuse it (D-014). */
  size: Size;
  /** The records this part reads; the builder reads only these and its brief (D-044). */
  decisions?: PlanDecision[];
  /** Grill call numbers (1-based) or question texts that apply to this part (D-044). */
  calls?: (number | string)[];
}

export interface SplitPlan {
  parts: PlanPart[];
  /**
   * `fallback` when the model's reply was unusable. `limited` when the harness hit a
   * usage limit: there are no parts and the issue is not split (MET-70).
   */
  source: "model" | "fallback" | "limited";
  /** Why the issue needs more than one part. Required when `parts` has more than one. */
  reason?: string;
  /** Why the model's plan was not used. */
  error?: string;
  /** Tokens the plan run used (D-040). */
  tokens?: TokenUsage;
  /** Turns the plan run took, when the harness reports them. */
  turns?: number;
}

export type ParsedPlanReply =
  | { ok: true; parts: PlanPart[]; reason?: string }
  | { ok: false; error: string };

/** The JSON shape the coordinator must reply with. */
export const PLAN_REPLY_SHAPE = `{
  "parts": [{
    "role": "backend" | "frontend",
    "title": "string",
    "prompt": "string",
    "size": "S" | "M",
    "decisions": [{ "id": "D-NNN", "line": "why it applies to this part" }],
    "calls": [1, "a grill question this part follows"]
  }],
  "reason": "why the issue needs more than one part (only for a plan with more than one part; leave it out for a one-part plan)"
}`;

/** A decision id: D- and three digits, as in a `docs/decisions/` file name. */
export const DECISION_ID = /^D-\d{3}$/;

/** Ids of the records that exist, from the grill context. */
export function knownDecisionIds(context: GrillContext): Set<string> {
  const ids = new Set<string>();
  for (const decision of context.decisions) {
    const match = /^(D-\d{3})(?:-|$)/.exec(decision.name);
    if (match?.[1]) ids.add(match[1]);
  }
  return ids;
}

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const PART_KEYS = ["role", "title", "prompt", "size", "decisions", "calls"] as const;

export interface ParsePlanOptions {
  /**
   * The ids that have a record file. A well-formed id outside this set is dropped
   * with one log line (D-044). When absent, every well-formed id is kept.
   */
  knownIds?: ReadonlySet<string>;
  /** Receives one line per dropped decision id. */
  log?: (line: string) => void;
}

/** Strictly validates a plan reply: known keys only, non-empty strings, 1 to 6 parts. */
export function parsePlanReply(text: string, options: ParsePlanOptions = {}): ParsedPlanReply {
  let value: unknown;
  try {
    value = JSON.parse(extractJson(text));
  } catch (error) {
    return { ok: false, error: `not JSON: ${(error as Error).message}` };
  }
  if (!isObj(value)) return { ok: false, error: "expected a JSON object" };
  for (const key of Object.keys(value)) {
    if (key !== "parts" && key !== "reason") return { ok: false, error: `unknown key "${key}"` };
  }
  if (!Array.isArray(value.parts)) return { ok: false, error: "parts: expected an array" };
  if (value.parts.length === 0) return { ok: false, error: "parts: expected at least one part" };
  if (value.parts.length > MAX_PLAN_PARTS) {
    return { ok: false, error: `parts: expected at most ${MAX_PLAN_PARTS} parts` };
  }
  let reason: string | undefined;
  if (value.reason !== undefined) {
    if (typeof value.reason !== "string") {
      return { ok: false, error: "reason: expected a string" };
    }
    const trimmed = value.reason.trim();
    if (trimmed !== "") reason = trimmed;
  }
  if (value.parts.length > 1 && reason === undefined) {
    return {
      ok: false,
      error:
        "reason: a plan with more than one part must say why the issue cannot ship as one part",
    };
  }
  const parts: PlanPart[] = [];
  for (const [i, raw] of value.parts.entries()) {
    const path = `parts[${i}]`;
    if (!isObj(raw)) return { ok: false, error: `${path}: expected an object` };
    for (const key of Object.keys(raw)) {
      if (!(PART_KEYS as readonly string[]).includes(key)) {
        return { ok: false, error: `${path}: unknown key "${key}"` };
      }
    }
    for (const key of ["role", "title", "prompt", "size"] as const) {
      const v = raw[key];
      if (typeof v !== "string" || v.trim() === "") {
        return { ok: false, error: `${path}.${key}: expected a non-empty string` };
      }
    }
    const role = (raw.role as string).trim();
    if (!isPartRole(role)) {
      return { ok: false, error: `${path}.role: expected backend or frontend, got "${role}"` };
    }
    const size = (raw.size as string).trim().toUpperCase();
    if (!(SIZES as readonly string[]).includes(size)) {
      return { ok: false, error: `${path}.size: expected S or M, got "${raw.size as string}"` };
    }
    const decisions = parseDecisions(raw.decisions, `${path}.decisions`, options);
    if ("error" in decisions) return { ok: false, error: decisions.error };
    const calls = parsePartCalls(raw.calls, `${path}.calls`);
    if ("error" in calls) return { ok: false, error: calls.error };
    const part: PlanPart = {
      role,
      title: (raw.title as string).trim(),
      prompt: (raw.prompt as string).trim(),
      size: size as Size,
    };
    if (decisions.value.length > 0) part.decisions = decisions.value;
    if (calls.value.length > 0) part.calls = calls.value;
    parts.push(part);
  }
  return reason === undefined ? { ok: true, parts } : { ok: true, parts, reason };
}

/**
 * A part's optional `decisions`. A malformed entry makes the plan invalid. A well-formed
 * id with no record file is dropped with one log line, not a fallback (D-044).
 */
function parseDecisions(
  raw: unknown,
  path: string,
  options: ParsePlanOptions,
): { value: PlanDecision[] } | { error: string } {
  const value: PlanDecision[] = [];
  if (raw === undefined) return { value };
  if (!Array.isArray(raw)) return { error: `${path}: expected an array` };
  for (const [i, entry] of raw.entries()) {
    const at = `${path}[${i}]`;
    if (!isObj(entry)) return { error: `${at}: expected an object` };
    for (const key of Object.keys(entry)) {
      if (key !== "id" && key !== "line") return { error: `${at}: unknown key "${key}"` };
    }
    if (
      typeof entry.id !== "string" ||
      entry.id.trim() === "" ||
      typeof entry.line !== "string" ||
      entry.line.trim() === ""
    ) {
      return { error: `${at}: expected id and line strings` };
    }
    const id = entry.id.trim();
    if (!DECISION_ID.test(id)) {
      return { error: `${at}.id: expected D-NNN, got "${id}"` };
    }
    if (options.knownIds !== undefined && !options.knownIds.has(id)) {
      options.log?.(`plan: dropped decision ${id}: no record in docs/decisions/`);
      continue;
    }
    value.push({ id, line: entry.line.trim() });
  }
  return { value };
}

/** A part's optional `calls`: 1-based call numbers or the call's question text. */
function parsePartCalls(
  raw: unknown,
  path: string,
): { value: (number | string)[] } | { error: string } {
  const value: (number | string)[] = [];
  if (raw === undefined) return { value };
  if (!Array.isArray(raw)) return { error: `${path}: expected an array` };
  for (const [i, entry] of raw.entries()) {
    if (typeof entry === "number") {
      if (!Number.isInteger(entry) || entry < 1) {
        return { error: `${path}[${i}]: expected a positive call number or a question string` };
      }
      value.push(entry);
    } else if (typeof entry === "string" && entry.trim() !== "") {
      value.push(entry.trim());
    } else {
      return { error: `${path}[${i}]: expected a positive call number or a question string` };
    }
  }
  return { value };
}

/**
 * The plan used when the model's is unusable: one part, frontend when the issue
 * carries the `ui` label, else backend, at the issue's size (M when it has none).
 * It carries every grill call and no decision ids (D-044).
 */
export function fallbackPlan(issue: Issue, calls: readonly Call[] = []): PlanPart[] {
  const part: PlanPart = {
    role: issue.labels.includes("ui") ? "frontend" : "backend",
    title: issue.title,
    prompt: `Implement ${issue.key} as written: every "Done when" item, with tests.`,
    size: issue.size ?? "M",
  };
  if (calls.length > 0) part.calls = calls.map((_, i) => i + 1);
  return [part];
}

function doneWhenList(issue: Issue): string {
  if (issue.doneWhen.length === 0) return "(none parsed from the body)";
  return issue.doneWhen.map((d) => `- [${d.checked ? "x" : " "}] ${d.text}`).join("\n");
}

export interface PlanPromptInput {
  issue: Issue;
  context: GrillContext;
  /** The coordinator's resolved instruction text. */
  instructions?: string;
  /** Calls the grill settled; the plan must follow them. */
  calls?: Call[];
}

/** Builds the split prompt for one issue that passed the grill. */
export function buildPlanPrompt({ issue, context, instructions, calls }: PlanPromptInput): string {
  const decisions =
    context.decisions.length === 0
      ? "(none)"
      : context.decisions.map((d) => `### ${d.name}\n${d.text}`).join("\n\n");
  const parts = [
    "You are the harnessd coordinator. Split this Linear issue into parts for the Backend and Frontend agents.",
    [
      "Rules:",
      '- A part has role "backend" (daemon, CLI, adapters, integrations, shared types, docs) or "frontend" (the UI).',
      "- Plan ONE part by default: one part is one PR. Split only when the issue's Size is L, or one part cannot fit the M budget (about 2 hours).",
      "- Only plan parts with real work. An issue with no UI work gets no frontend part; one with only UI work gets no backend part.",
      "- Each part is size S (about 30 minutes) or M (about 2 hours). L is not allowed: split larger work into more parts (D-014).",
      '- When you plan more than one part, "reason" must say why the issue cannot ship as one part. A plan with more than one part and no reason is invalid. For a one-part plan, leave out "reason".',
      "- Do not plan QA; harnessd adds the QA part itself.",
      '- Each part lists the decision records it depends on in "decisions": [{ "id": "D-NNN", "line": "why it applies" }]. The builder reads only its brief and these records (D-044).',
      '- Each part lists the grill calls that apply to it in "calls": the call numbers below, or their question texts.',
      '- "prompt" is the full brief for the agent: what to change, where, which "Done when" items it covers, and the decision IDs it depends on. Never write "Read docs/SPEC.md and docs/decisions/" or tell the agent to read every record.',
      "You may read files in this repo; do not edit anything.",
    ].join("\n"),
    `Reply with strict JSON only, no prose and no code fence, in exactly this shape:\n${PLAN_REPLY_SHAPE}`,
  ];
  if (instructions?.trim()) parts.push(`## Coordinator instructions\n${instructions.trim()}`);
  parts.push(
    `## Issue ${issue.key}: ${issue.title}\nURL: ${issue.url}\nSize: ${issue.size ?? "unknown"}\n` +
      `Labels: ${issue.labels.join(", ") || "(none)"}\n\n` +
      `### Body\n${issue.description.trim() || "(empty)"}\n\n### Done when\n${doneWhenList(issue)}`,
  );
  if (calls && calls.length > 0) {
    parts.push(
      `## Calls from the grill\n${calls.map((c, i) => `${i + 1}. ${c.question} → ${c.answer}`).join("\n")}`,
    );
  }
  parts.push(
    `## Spec (docs/SPEC.md)\n${context.spec || "(missing)"}`,
    `## Decision records (docs/decisions/)\n${decisions}`,
  );
  return `${parts.join("\n\n")}\n`;
}

export interface PlanDeps {
  /** Runs the coordinator model. Its id must match `agent.harness`. */
  adapter: HarnessAdapter;
  agent: ResolvedAgentConfig;
  context: GrillContext;
  cwd: string;
  calls?: Call[];
  /** Receives one line per dropped decision id (D-044). */
  log?: (line: string) => void;
  /** Wall-clock budget of the planning run. Default 10 minutes. */
  budgetMs?: number;
  /** Turn cap of the planning run. Default `COORDINATOR_MAX_TURNS` (D-045). */
  maxTurns?: number;
}

export const DEFAULT_PLAN_BUDGET_MS = 10 * 60_000;

/**
 * Asks the coordinator's harness for a split plan. An invalid reply or a failed run
 * falls back to `fallbackPlan` deterministically; this never throws for model errors.
 */
export async function planIssue(issue: Issue, deps: PlanDeps): Promise<SplitPlan> {
  const input: PlanPromptInput = {
    issue,
    context: deps.context,
    instructions: deps.agent.instructions,
  };
  if (deps.calls !== undefined) input.calls = deps.calls;
  const task: Task = {
    id: `plan-${issue.key}`,
    title: `Plan ${issue.key}: ${issue.title}`,
    prompt: buildPlanPrompt(input),
    budgetMs: deps.budgetMs ?? DEFAULT_PLAN_BUDGET_MS,
    maxTurns: deps.maxTurns ?? COORDINATOR_MAX_TURNS,
  };
  if (deps.agent.model !== undefined) task.model = deps.agent.model;

  const reply: RunReply =
    deps.adapter.id === deps.agent.harness
      ? await runForReply(deps.adapter, task, deps.cwd)
      : ({
          ok: false,
          error: `adapter ${deps.adapter.id} does not match the ${deps.agent.name} harness ${deps.agent.harness}`,
          tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        } as const);
  if (!reply.ok && reply.limited) {
    return {
      parts: [],
      source: "limited",
      error: reply.error,
      tokens: reply.tokens,
      ...turnsOf(reply),
    };
  }
  const parsed: ParsedPlanReply = reply.ok
    ? parsePlanReply(reply.text, {
        knownIds: knownDecisionIds(deps.context),
        ...(deps.log === undefined ? {} : { log: deps.log }),
      })
    : reply;
  if (parsed.ok) {
    const plan: SplitPlan = {
      parts: parsed.parts,
      source: "model",
      tokens: reply.tokens,
      ...turnsOf(reply),
    };
    if (parsed.reason !== undefined) plan.reason = parsed.reason;
    return plan;
  }
  return {
    parts: fallbackPlan(issue, deps.calls ?? []),
    source: "fallback",
    error: parsed.error,
    tokens: reply.tokens,
    ...turnsOf(reply),
  };
}

function turnsOf(reply: RunReply): { turns?: number } {
  return reply.turns === undefined ? {} : { turns: reply.turns };
}
