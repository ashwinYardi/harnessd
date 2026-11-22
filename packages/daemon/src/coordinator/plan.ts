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

export interface PlanPart {
  role: PartRole;
  title: string;
  /** The brief the agent works from. */
  prompt: string;
  /** S or M. L is parsed so the loop can refuse it (D-014). */
  size: Size;
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
  "parts": [{ "role": "backend" | "frontend", "title": "string", "prompt": "string", "size": "S" | "M" }],
  "reason": "why the issue needs more than one part (only for a plan with more than one part; leave it out for a one-part plan)"
}`;

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const PART_KEYS = ["role", "title", "prompt", "size"] as const;

/** Strictly validates a plan reply: known keys only, non-empty strings, 1 to 6 parts. */
export function parsePlanReply(text: string): ParsedPlanReply {
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
    for (const key of PART_KEYS) {
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
    parts.push({
      role,
      title: (raw.title as string).trim(),
      prompt: (raw.prompt as string).trim(),
      size: size as Size,
    });
  }
  return reason === undefined ? { ok: true, parts } : { ok: true, parts, reason };
}

/**
 * The plan used when the model's is unusable: one part, frontend when the issue
 * carries the `ui` label, else backend, at the issue's size (M when it has none).
 */
export function fallbackPlan(issue: Issue): PlanPart[] {
  return [
    {
      role: issue.labels.includes("ui") ? "frontend" : "backend",
      title: issue.title,
      prompt: `Implement ${issue.key} as written: every "Done when" item, with tests.`,
      size: issue.size ?? "M",
    },
  ];
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
      '- "prompt" is the full brief for the agent: what to change, where, and which "Done when" items it covers.',
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
      `## Calls from the grill\n${calls.map((c) => `- ${c.question} → ${c.answer}`).join("\n")}`,
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
  /** Wall-clock budget of the planning run. Default 10 minutes. */
  budgetMs?: number;
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
  const parsed: ParsedPlanReply = reply.ok ? parsePlanReply(reply.text) : reply;
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
    parts: fallbackPlan(issue),
    source: "fallback",
    error: parsed.error,
    tokens: reply.tokens,
    ...turnsOf(reply),
  };
}

function turnsOf(reply: RunReply): { turns?: number } {
  return reply.turns === undefined ? {} : { turns: reply.turns };
}
