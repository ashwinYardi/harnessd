// The coordinator's self-grill (SPEC "Autonomy loop" steps 2-3, D-011), with the
// grill-with-docs method (D-017) run headless (D-021). See docs/COORDINATOR.md.
import {
  type Call,
  ESCALATION_TRIGGER_LABELS,
  type Escalation,
  type GlossaryTerm,
  type GrillResult,
  type HarnessAdapter,
  type Issue,
  isEscalationTrigger,
  type Precedent,
  type ResolvedAgentConfig,
  type Task,
} from "@harnessd/shared";
import type { LinearClient } from "../linear/client.ts";
import type { DecisionSink } from "./decisions.ts";
import type { Notifier } from "./notifier.ts";
import { buildGrillPrompt, type GrillContext } from "./prompt.ts";

/** The two Linear writes the grill makes. A LinearClient satisfies it. */
export type GrillLinear = Pick<LinearClient, "comment" | "moveTo">;

export interface GrillDeps {
  /** Runs the coordinator model. Its id must match `agent.harness`. */
  adapter: HarnessAdapter;
  /** The coordinator's resolved config (resolveAgentConfig(merged, "coordinator")). */
  agent: ResolvedAgentConfig;
  context: GrillContext;
  /** Working directory of the run: the repo, so the model can read code and the vault. */
  cwd: string;
  linear: GrillLinear;
  notifier: Notifier;
  decisions: DecisionSink;
  /** Wall-clock budget per attempt. Default 10 minutes. */
  budgetMs?: number;
}

export const DEFAULT_GRILL_BUDGET_MS = 10 * 60_000;

/** A proposed escalation before its trigger is checked against D-011. */
export interface ProposedEscalation {
  trigger: string;
  question: string;
  why: string;
}

export type ParsedGrillReply =
  | {
      ok: true;
      calls: Call[];
      escalation: ProposedEscalation | null;
      /** Present when the reply has `terms`. */
      terms?: GlossaryTerm[];
      /** Present when the reply has `precedents`. */
      precedents?: Precedent[];
    }
  | { ok: false; error: string };

const REPLY_KEYS = ["calls", "escalation", "terms", "precedents"];

/** The JSON inside a reply: the whole text, or the first ``` / ```json fenced block. */
export function extractJson(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return trimmed;
  const fence = /```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?```/i.exec(trimmed);
  return fence?.[1] !== undefined ? fence[1].trim() : trimmed;
}

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkKeys(
  value: Obj,
  keys: readonly string[],
  path: string,
  optional: readonly string[] = [],
): string | undefined {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key) && !optional.includes(key)) return `${path}: unknown key "${key}"`;
  }
  for (const key of keys) {
    if (typeof value[key] !== "string" || (value[key] as string).trim() === "") {
      return `${path}.${key}: expected a non-empty string`;
    }
  }
  return undefined;
}

/** Strictly validates a grill reply. Unknown triggers pass here; grillIssue downgrades them. */
export function parseGrillReply(text: string): ParsedGrillReply {
  let value: unknown;
  try {
    value = JSON.parse(extractJson(text));
  } catch (error) {
    return { ok: false, error: `not JSON: ${(error as Error).message}` };
  }
  if (!isObj(value)) return { ok: false, error: "expected a JSON object" };
  for (const key of Object.keys(value)) {
    if (!REPLY_KEYS.includes(key)) return { ok: false, error: `unknown key "${key}"` };
  }
  if (!Array.isArray(value.calls)) return { ok: false, error: "calls: expected an array" };
  if (!("escalation" in value)) return { ok: false, error: "escalation: missing (use null)" };

  const calls: Call[] = [];
  for (const [i, raw] of value.calls.entries()) {
    if (!isObj(raw)) return { ok: false, error: `calls[${i}]: expected an object` };
    const problem = checkKeys(raw, ["question", "answer", "basis"], `calls[${i}]`);
    if (problem) return { ok: false, error: problem };
    calls.push({
      question: (raw.question as string).trim(),
      answer: (raw.answer as string).trim(),
      basis: (raw.basis as string).trim(),
    });
  }

  let escalation: ProposedEscalation | null = null;
  const raw = value.escalation;
  if (raw !== null) {
    if (!isObj(raw)) return { ok: false, error: "escalation: expected null or an object" };
    const problem = checkKeys(raw, ["trigger", "question", "why"], "escalation");
    if (problem) return { ok: false, error: problem };
    escalation = {
      trigger: (raw.trigger as string).trim(),
      question: (raw.question as string).trim(),
      why: (raw.why as string).trim(),
    };
  }
  const parsed: ParsedGrillReply = { ok: true, calls, escalation };

  if ("terms" in value) {
    if (!Array.isArray(value.terms)) return { ok: false, error: "terms: expected an array" };
    const terms: GlossaryTerm[] = [];
    for (const [i, t] of value.terms.entries()) {
      if (!isObj(t)) return { ok: false, error: `terms[${i}]: expected an object` };
      const problem = checkKeys(t, ["term", "definition"], `terms[${i}]`, ["avoid"]);
      if (problem) return { ok: false, error: problem };
      const avoid = t.avoid ?? [];
      if (!Array.isArray(avoid) || !avoid.every((a) => typeof a === "string" && a.trim() !== "")) {
        return { ok: false, error: `terms[${i}].avoid: expected an array of non-empty strings` };
      }
      terms.push({
        term: (t.term as string).trim(),
        definition: (t.definition as string).trim(),
        avoid: (avoid as string[]).map((a) => a.trim()),
      });
    }
    parsed.terms = terms;
  }

  if ("precedents" in value) {
    if (!Array.isArray(value.precedents)) {
      return { ok: false, error: "precedents: expected an array" };
    }
    const precedents: Precedent[] = [];
    for (const [i, p] of value.precedents.entries()) {
      if (!isObj(p)) return { ok: false, error: `precedents[${i}]: expected an object` };
      const problem = checkKeys(p, ["title", "decision", "why"], `precedents[${i}]`);
      if (problem) return { ok: false, error: problem };
      precedents.push({
        title: (p.title as string).trim(),
        decision: (p.decision as string).trim(),
        why: (p.why as string).trim(),
      });
    }
    parsed.precedents = precedents;
  }
  return parsed;
}

/** Collapses whitespace so each call stays one bullet. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** What the grill adds to the vault besides decision notes. */
export interface GrillDocs {
  terms?: GlossaryTerm[];
  precedents?: Precedent[];
}

/** The single Linear comment posted per grill. */
export function formatGrillComment(
  calls: Call[],
  escalation: Escalation | null,
  docs: GrillDocs = {},
): string {
  const count = `${calls.length} ${calls.length === 1 ? "call" : "calls"}`;
  const status = escalation ? "needs input" : "proceeding";
  const lines = [`**Coordinator grill**: ${status}, ${count}.`, ""];
  if (calls.length === 0) lines.push("- No open questions.");
  for (const c of calls) {
    lines.push(`- ${oneLine(c.question)} → ${oneLine(c.answer)} (basis: ${oneLine(c.basis)})`);
  }
  if (docs.terms && docs.terms.length > 0) {
    lines.push("", "**New terms** (workspace vault glossary):");
    for (const t of docs.terms) lines.push(`- ${oneLine(t.term)}: ${oneLine(t.definition)}`);
  }
  if (docs.precedents && docs.precedents.length > 0) {
    lines.push("", "**Draft decision records** (for a docs PR):");
    for (const p of docs.precedents) lines.push(`- ${oneLine(p.title)}: ${oneLine(p.decision)}`);
  }
  if (escalation) {
    lines.push(
      "",
      `**Question for the human:** ${oneLine(escalation.question)}`,
      `D-011 trigger: \`${escalation.trigger}\` (${ESCALATION_TRIGGER_LABELS[escalation.trigger]}). ${oneLine(escalation.why)}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

/** The one Slack line sent on escalation. */
export function formatGrillPing(issue: Issue, escalation: Escalation): string {
  return `${issue.key} needs input (${escalation.trigger}): ${oneLine(escalation.question)} ${issue.url}`;
}

/** Title of a call's decision note: the question, without the question mark, at most 80 chars. */
export function noteTitle(question: string): string {
  const title = oneLine(question).replace(/\?+$/, "");
  return title.length <= 80 ? title : `${title.slice(0, 79)}…`;
}

/** Runs one task to the end and returns the final assistant text, or why there is none. */
export async function runForReply(
  adapter: HarnessAdapter,
  task: Task,
  cwd: string,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  let lastText: string | undefined;
  let finalText: string | undefined;
  let status: string | undefined;
  let runError: string | undefined;
  try {
    const run = adapter.start(task, cwd);
    for await (const event of run.events) {
      if (event.type === "text") lastText = event.text;
      if (event.type === "end") {
        status = event.result.status;
        finalText = event.result.finalText;
        runError = event.result.error;
      }
    }
  } catch (error) {
    return { ok: false, error: `harness run failed: ${(error as Error).message}` };
  }
  if (status !== "ok") {
    return {
      ok: false,
      error: `harness run ${status ?? "ended without a result"}${runError ? `: ${runError}` : ""}`,
    };
  }
  const text = finalText ?? lastText;
  if (text === undefined || text.trim() === "") return { ok: false, error: "empty reply" };
  return { ok: true, text };
}

/**
 * Self-grills one picked issue. Calls become decision notes and one Linear comment.
 * A D-011 escalation also moves the issue to Needs input and sends exactly one ping.
 * An unreadable model reply (twice) or a failed side effect returns `error`; nothing
 * after the failure runs, so the human is never pinged by a broken run.
 */
export async function grillIssue(issue: Issue, deps: GrillDeps): Promise<GrillResult> {
  if (deps.adapter.id !== deps.agent.harness) {
    return {
      calls: [],
      escalation: null,
      outcome: "error",
      error: `adapter ${deps.adapter.id} does not match the ${deps.agent.name} harness ${deps.agent.harness}`,
    };
  }

  const prompt = buildGrillPrompt({
    issue,
    context: deps.context,
    instructions: deps.agent.instructions,
  });
  const task = (attempt: number, text: string): Task => {
    const t: Task = {
      id: `grill-${issue.key}-${attempt}`,
      title: `Grill ${issue.key}: ${issue.title}`,
      prompt: text,
      budgetMs: deps.budgetMs ?? DEFAULT_GRILL_BUDGET_MS,
    };
    if (deps.agent.model !== undefined) t.model = deps.agent.model;
    return t;
  };

  let parsed: ParsedGrillReply = { ok: false, error: "not run" };
  for (let attempt = 1; attempt <= 2; attempt++) {
    const text =
      attempt === 1
        ? prompt
        : `${prompt}\nYour previous reply was rejected (${parsed.ok ? "" : parsed.error}). Reply again with only the JSON object.\n`;
    const reply = await runForReply(deps.adapter, task(attempt, text), deps.cwd);
    parsed = reply.ok ? parseGrillReply(reply.text) : reply;
    if (parsed.ok) break;
  }
  if (!parsed.ok) {
    return {
      calls: [
        {
          question: "Can the coordinator's grill reply be used?",
          answer:
            "No: it was invalid twice. Outcome error; no comment, no state change and no ping, the issue stays where it is.",
          basis: `MET-11: a broken model must never spam the human. Last error: ${parsed.error}`,
        },
      ],
      escalation: null,
      outcome: "error",
      error: parsed.error,
    };
  }

  const calls = [...parsed.calls];
  let escalation: Escalation | null = null;
  const proposed = parsed.escalation;
  if (proposed && isEscalationTrigger(proposed.trigger)) {
    escalation = { trigger: proposed.trigger, question: proposed.question, why: proposed.why };
  } else if (proposed) {
    calls.push({
      question: proposed.question,
      answer: `Not escalated: "${proposed.trigger}" is not a D-011 trigger, so the coordinator decides it from the spec and proceeds.`,
      basis: `D-011 lists the only reasons to ask the human. Model's reason: ${proposed.why}`,
    });
  }

  const terms = parsed.terms ?? [];
  const precedents = parsed.precedents ?? [];
  let step = "write decision notes";
  try {
    for (const call of calls) {
      await deps.decisions.write({
        issue: issue.key,
        title: noteTitle(call.question),
        question: call.question,
        decision: call.answer,
        basis: call.basis,
      });
    }
    step = "write glossary terms";
    if (deps.decisions.term) {
      for (const t of terms) await deps.decisions.term({ issue: issue.key, ...t });
    }
    step = "write draft decision records";
    if (deps.decisions.draft) {
      for (const p of precedents) await deps.decisions.draft({ issue: issue.key, ...p });
    }
    step = "post the Linear comment";
    await deps.linear.comment(
      issue.id,
      formatGrillComment(calls, escalation, { terms, precedents }),
    );
    if (escalation) {
      step = "move the issue to Needs input";
      await deps.linear.moveTo(issue.id, "Needs input");
      step = "send the ping";
      await deps.notifier.notify(formatGrillPing(issue, escalation));
    }
  } catch (error) {
    return {
      calls,
      escalation,
      outcome: "error",
      error: `could not ${step}: ${(error as Error).message}`,
      terms,
      precedents,
    };
  }
  return {
    calls,
    escalation,
    outcome: escalation ? "needs_input" : "proceed",
    terms,
    precedents,
  };
}
