// The coordinator's review decision: what a blocking review asks the builder to fix, or the
// one D-011 question a human must answer (MET-241, MET-242). A read-only coordinator run
// reads the part, the open blocking findings and the earlier rounds, and replies with the
// strict JSON contract below. Any unusable reply, failed run or escalation without a D-011
// trigger falls back to a fix send-back, so nothing waits on a human by accident.

import {
  ESCALATION_TRIGGER_LABELS,
  ESCALATION_TRIGGERS,
  type EscalationTrigger,
  emptyTokenUsage,
  type HarnessAdapter,
  isEscalationTrigger,
  type LinkedIssue,
  type ResolvedAgentConfig,
  type Task,
  type TokenUsage,
} from "@harnessd/shared";
import { agentPromptHeader, COORDINATOR_MAX_TURNS } from "./dispatch.ts";
import { coordinatorTask, runForReply } from "./grill.ts";
import { type AgentMemory, memorySection } from "./prompt.ts";
import { partItems } from "./qa.ts";
import type { ReviewFinding } from "./review.ts";
import { extractSection } from "./split.ts";

/** One fix hint the review decision sends back for an open blocking finding. */
export interface ReviewFixHint {
  /** `R1`…`Rn`, the finding's id in the prompt. */
  id: string;
  /** What the builder must do to fix the finding. */
  hint: string;
}

/** The coordinator sends the findings back to the builder to fix. */
export interface ReviewFixDecision {
  decision: "fix";
  hints: ReviewFixHint[];
}

/** The fix needs a decision only the human can make, under a D-011 trigger. */
export interface ReviewEscalateDecision {
  decision: "escalate";
  /** Why the human must decide, from the D-011 trigger enum. */
  trigger: EscalationTrigger;
  question: string;
  /** The choices the human picks between. */
  options: string[];
  /** The coordinator's recommended option. */
  recommendation: string;
}

/** A checked review decision: send the findings back to the builder, or ask the human. */
export type ReviewDecision = ReviewFixDecision | ReviewEscalateDecision;

export type ParsedReviewDecision =
  | {
      ok: true;
      decision: ReviewDecision;
      /** A line the caller logs, when the reply escalated without a D-011 trigger. */
      log?: string;
    }
  | {
      ok: false;
      error: string;
      /** Set when the reply was not valid JSON, even after the backslash repair (D-052). */
      kind?: "not_json";
    };

/** The JSON shape a fix reply must use. */
export const FIX_DECISION_SHAPE = `{
  "decision": "fix",
  "findings": [{ "id": "R1", "hint": "string" }]
}`;

/** The JSON shape an escalate reply must use. */
export const ESCALATE_DECISION_SHAPE = `{
  "decision": "escalate",
  "trigger": ${ESCALATION_TRIGGERS.map((trigger) => `"${trigger}"`).join(" | ")},
  "question": "string",
  "options": ["string"],
  "recommendation": "string"
}`;

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function openBlockerIds(findings: readonly ReviewFinding[]): string[] {
  return findings.map((_, i) => `R${i + 1}`);
}

/**
 * One entry per open finding, in the reply's order: each id names an open blocking finding,
 * ids are unique, and every hint is non-empty. A missing or extra id is an error.
 */
function parseFixHints(
  raw: unknown,
  openIds: readonly string[],
  path: string,
): { hints: ReviewFixHint[] } | { error: string } {
  if (!Array.isArray(raw)) return { error: `${path}: expected an array` };
  const open = new Set(openIds);
  const seen = new Set<string>();
  const hints: ReviewFixHint[] = [];
  for (const [i, entry] of raw.entries()) {
    const at = `${path}[${i}]`;
    if (!isObj(entry)) return { error: `${at}: expected an object` };
    for (const key of Object.keys(entry)) {
      if (key !== "id" && key !== "hint") return { error: `${at}: unknown key "${key}"` };
    }
    if (!nonEmpty(entry.id)) {
      return { error: `${at}.id: expected a non-empty string` };
    }
    const id = entry.id.trim();
    if (!open.has(id)) {
      return { error: `${at}.id: not an open blocking finding "${id}"` };
    }
    if (seen.has(id)) return { error: `${at}.id: duplicate "${id}"` };
    if (!nonEmpty(entry.hint)) {
      return { error: `${at}.hint: expected a non-empty string` };
    }
    seen.add(id);
    hints.push({ id, hint: entry.hint.trim() });
  }
  for (const id of openIds) {
    if (!seen.has(id)) return { error: `${path}: missing finding "${id}"` };
  }
  return { hints };
}

/**
 * The hints an escalate reply may carry when it has no usable trigger. They are best-effort:
 * an entry with an unknown id or a blank hint is dropped, because the reply is a fix fallback.
 */
function keepHints(raw: unknown, openIds: readonly string[]): ReviewFixHint[] {
  if (!Array.isArray(raw)) return [];
  const open = new Set(openIds);
  const seen = new Set<string>();
  const hints: ReviewFixHint[] = [];
  for (const entry of raw) {
    if (!isObj(entry) || !nonEmpty(entry.id) || !nonEmpty(entry.hint)) continue;
    const id = entry.id.trim();
    if (!open.has(id) || seen.has(id)) continue;
    seen.add(id);
    hints.push({ id, hint: entry.hint.trim() });
  }
  return hints;
}

function parseOptions(raw: unknown, path: string): { options: string[] } | { error: string } {
  if (!Array.isArray(raw)) return { error: `${path}: expected an array` };
  if (raw.length === 0) return { error: `${path}: expected a non-empty array` };
  const options: string[] = [];
  for (const [i, entry] of raw.entries()) {
    if (!nonEmpty(entry)) return { error: `${path}[${i}]: expected a non-empty string` };
    options.push(entry.trim());
  }
  return { options };
}

/**
 * Strictly validates a review decision (MET-242). A fix reply has exactly one entry per open
 * blocking finding id, each with a non-empty hint. An escalate reply needs a D-011 trigger, a
 * question, at least one option and a recommendation. An escalate with no trigger or an
 * unknown trigger is a fix: the loop sends the findings back, with the reply's hints when it
 * carries any, and logs the fallback line.
 */
export function parseReviewDecision(
  text: string,
  findings: readonly ReviewFinding[],
  partKey: string,
): ParsedReviewDecision {
  const blocking = findings.filter((finding) => finding.severity === "blocking");
  const openIds = openBlockerIds(blocking);
  // The whole message is the reply: unlike QA and review verdicts, never pull an object out
  // of prose or repair an escape. A malformed escalation must fall back to fix, not ask the
  // human something the coordinator did not strictly say.
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: `not JSON: ${(error as Error).message}`, kind: "not_json" };
  }
  if (!isObj(value)) return { ok: false, error: "expected a JSON object" };
  if (value.decision !== "fix" && value.decision !== "escalate") {
    return { ok: false, error: 'decision: expected "fix" or "escalate"' };
  }

  if (value.decision === "fix") {
    for (const key of Object.keys(value)) {
      if (key !== "decision" && key !== "findings") {
        return { ok: false, error: `unknown key "${key}"` };
      }
    }
    const hints = parseFixHints(value.findings, openIds, "findings");
    if ("error" in hints) return { ok: false, error: hints.error };
    return { ok: true, decision: { decision: "fix", hints: hints.hints } };
  }

  const rawTrigger = nonEmpty(value.trigger) ? value.trigger.trim() : "";
  if (!isEscalationTrigger(rawTrigger)) {
    const hints = keepHints(value.findings, openIds);
    return {
      ok: true,
      decision: { decision: "fix", hints },
      log: `${partKey}: escalation without a D-011 trigger, sent back as fix`,
    };
  }

  for (const key of Object.keys(value)) {
    if (
      key !== "decision" &&
      key !== "trigger" &&
      key !== "question" &&
      key !== "options" &&
      key !== "recommendation"
    ) {
      return { ok: false, error: `unknown key "${key}"` };
    }
  }
  if (!nonEmpty(value.question)) {
    return { ok: false, error: "question: expected a non-empty string" };
  }
  const options = parseOptions(value.options, "options");
  if ("error" in options) return { ok: false, error: options.error };
  if (!nonEmpty(value.recommendation)) {
    return { ok: false, error: "recommendation: expected a non-empty string" };
  }
  return {
    ok: true,
    decision: {
      decision: "escalate",
      trigger: rawTrigger,
      question: value.question.trim(),
      options: options.options,
      recommendation: value.recommendation.trim(),
    },
  };
}

// --- the prompt ---------------------------------------------------------------

/** The part brief sections a review decision carries, in order (MET-242). */
const DECISION_BRIEF_SECTIONS = ["Goal", "Done when", "Files", "Verify", "Out of scope"] as const;

function decisionBrief(part: LinkedIssue): string {
  const blocks: string[] = [];
  for (const name of DECISION_BRIEF_SECTIONS) {
    const text = extractSection(part.description, name);
    if (text !== "") blocks.push(`**${name}**\n${text}`);
  }
  return blocks.join("\n\n") || part.description.trim() || "(none)";
}

function doneWhenItems(part: LinkedIssue): string {
  const items = partItems(part);
  return items.length === 0
    ? "- (none parsed from the part body)"
    : items.map((item) => `- ${item}`).join("\n");
}

function findingLine(finding: ReviewFinding, id: string): string {
  return `- ${id} (${finding.file}:${finding.line}, ${finding.kind}): ${finding.text}`;
}

function earlierFindingLine(finding: ReviewFinding): string {
  return `- ${finding.file}:${finding.line} (${finding.severity}, ${finding.kind}): ${finding.text}`;
}

export interface ReviewDecisionPromptInput {
  /** The coordinator's resolved config. */
  agent: ResolvedAgentConfig;
  /** The part whose PR the review sent back. */
  part: LinkedIssue;
  /** The open blocking findings, in the order `R1`…`Rn`. */
  findings: readonly ReviewFinding[];
  /** The review round this decision answers, 1-based. */
  round: number;
  /** The round cap from `limits.max_review_rounds` (or the caller's value, D-062). */
  maxRounds: number;
  /** The blocking findings of the earlier rounds. */
  earlierFindings?: readonly ReviewFinding[];
  /** The vaults, when the loop synced the harness files into the checkout (MET-55). */
  memory?: AgentMemory;
}

/**
 * The coordinator's prompt for one blocking review (MET-242). It carries the part brief and
 * Done-when items, every open blocking finding as `R<n>`, the round and cap, the earlier
 * rounds' findings, the D-011 trigger list and the strict JSON contract. It carries no PR
 * diff; the coordinator may read files in the checkout read-only.
 */
export function buildReviewDecisionPrompt(input: ReviewDecisionPromptInput): string {
  const { agent, part, findings, round, maxRounds, earlierFindings, memory } = input;
  const blocking = findings.filter((finding) => finding.severity === "blocking");
  const openLines = blocking.map((finding, i) => findingLine(finding, `R${i + 1}`));
  const earlier = earlierFindings ?? [];
  const out = agentPromptHeader(agent, part, "");
  out.push(
    `## Part

${part.key}: ${part.title} (${part.url})
Parent: ${part.parentKey ?? "(none)"}`,
    `## Part brief

${decisionBrief(part)}`,
    `## Done when items

${doneWhenItems(part)}`,
    `## Open blocking findings (${blocking.length})

${openLines.length === 0 ? "- (none)" : openLines.join("\n")}`,
    `## Round

Round ${round} of ${maxRounds}.`,
    `## Earlier rounds' findings

${earlier.length === 0 ? "(none)" : earlier.map(earlierFindingLine).join("\n")}`,
    `## D-011 escalation triggers

Escalate only when the fix needs one of these reasons, and name its trigger:
${ESCALATION_TRIGGERS.map((trigger) => `- \`${trigger}\` — ${ESCALATION_TRIGGER_LABELS[trigger]}`).join("\n")}

A design finding alone is no trigger. A design finding escalates only when its fix needs a public API, the data model, a protected path, a secret or an account change, money, an irreversible step, or a taste call with no precedent in the spec. Never escalate only because a finding is about design.`,
    `## How to decide

- Read the part's code, the parent issue and any decision record the brief or a finding names. Read only what you need.
- Edit nothing: do not edit files, commit, push or comment. This run is read-only, and harnessd sends the decision to the builder or the human.
- This prompt carries no PR diff. Open the files in this checkout to see the current code.
- Choose \`fix\` when the builder can fix every open blocking finding without a human. Write one non-empty hint per finding that says what to change and where.
- Choose \`escalate\` only under a D-011 trigger. Ask one question, list the options and give a recommendation.`,
    `## Reply

Your final message is strict JSON only, no prose and no code fence. Either a fix reply:

\`\`\`json
${FIX_DECISION_SHAPE}
\`\`\`

A fix reply has exactly one entry per open blocking finding id (${openBlockerIds(blocking).join(", ") || "none"}), and each \`hint\` is non-empty.

Or an escalate reply:

\`\`\`json
${ESCALATE_DECISION_SHAPE}
\`\`\`

An escalate reply names one D-011 trigger, a non-empty question, at least one option and a non-empty recommendation.`,
  );
  if (memory) out.push(memorySection(memory));
  return `${out.join("\n\n")}\n`;
}

// --- the run ------------------------------------------------------------------

export const DEFAULT_REVIEW_DECISION_BUDGET_MS = 10 * 60_000;

export interface ReviewDecisionInput {
  /** The part whose review is blocking. */
  part: LinkedIssue;
  /** The review's findings; only blocking ones are open for the decision. */
  findings: readonly ReviewFinding[];
  /** The review round this decision answers, 1-based. */
  round: number;
  /** The round cap the parent set. */
  maxRounds: number;
  /** The blocking findings of the earlier rounds. */
  earlierFindings?: readonly ReviewFinding[];
  /** The vaults, when the loop synced the harness files into the checkout (MET-55). */
  memory?: AgentMemory;
}

export interface ReviewDecisionDeps {
  /** Runs the coordinator model. The caller picks it from the coordinator harness order. */
  adapter: HarnessAdapter;
  /** The coordinator's resolved config. */
  agent: ResolvedAgentConfig;
  /** The owner's checkout: the coordinator reads the part's code there. */
  cwd: string;
  /** Wall-clock budget of the decision run. Default 10 minutes. */
  budgetMs?: number;
  /** Turn cap of the decision run. Default `COORDINATOR_MAX_TURNS` (50, D-045). */
  maxTurns?: number;
  log?: (line: string) => void;
}

export interface ReviewDecisionResult {
  decision: ReviewDecision;
  /** Tokens the run used, so the caller adds them to the parent's weighted budget (D-043). */
  tokens: TokenUsage;
  /** Turns the run took, when the harness reports them. */
  turns?: number;
  /** True when the run sent no usage event, so `tokens` counts nothing (MET-188). */
  usageUnknown?: true;
  /** Why the next coordinator run uses the next harness (D-048): limited, timed out or stalled. */
  switchReason?: string;
  /** Why the decision fell back to fix, when the reply or run was unusable. */
  error?: string;
}

function fixFallback(reason: string, partKey: string, log: (line: string) => void): void {
  log(`${partKey}: review decision failed (${oneLine(reason) || "no reason"}), sent back as fix`);
}

/**
 * Asks the coordinator to decide one blocking review (MET-242). It builds a read-only task
 * through `coordinatorTask`, runs it through `runForReply` in the owner's checkout, and
 * returns the checked decision with the run's usage. An invalid reply, a schema error or a
 * failed run (error, timeout, stall, turn cap, usage limit) returns `fix` with no hints, logs
 * one line and counts no review failure. A limited or timed-out run also returns the D-048
 * `switchReason` for the caller. It never writes state.
 */
export async function decideReview(
  input: ReviewDecisionInput,
  deps: ReviewDecisionDeps,
): Promise<ReviewDecisionResult> {
  const log = deps.log ?? (() => {});
  const { part } = input;
  const findings = input.findings.filter((finding) => finding.severity === "blocking");
  const task: Task = {
    id: `${part.key}-review-decision-r${input.round}`,
    title: `Decide review ${part.key} round ${input.round}`,
    prompt: buildReviewDecisionPrompt({
      agent: deps.agent,
      part,
      findings,
      round: input.round,
      maxRounds: input.maxRounds,
      ...(input.earlierFindings === undefined ? {} : { earlierFindings: input.earlierFindings }),
      ...(input.memory === undefined ? {} : { memory: input.memory }),
    }),
    budgetMs: deps.budgetMs ?? DEFAULT_REVIEW_DECISION_BUDGET_MS,
    maxTurns: deps.maxTurns ?? COORDINATOR_MAX_TURNS,
  };
  if (deps.agent.model !== undefined) task.model = deps.agent.model;

  let reply: Awaited<ReturnType<typeof runForReply>>;
  try {
    reply = await runForReply(deps.adapter, coordinatorTask(task), deps.cwd);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    fixFallback(reason, part.key, log);
    return {
      decision: { decision: "fix", hints: [] },
      tokens: emptyTokenUsage(),
      error: reason,
    };
  }

  if (!reply.ok) {
    fixFallback(reply.error, part.key, log);
    return {
      decision: { decision: "fix", hints: [] },
      tokens: reply.tokens,
      ...(reply.turns === undefined ? {} : { turns: reply.turns }),
      ...(reply.usageUnknown === undefined ? {} : { usageUnknown: reply.usageUnknown }),
      ...(reply.switchReason === undefined ? {} : { switchReason: reply.switchReason }),
      error: reply.error,
    };
  }

  const parsed = parseReviewDecision(reply.text, findings, part.key);
  if (!parsed.ok) {
    fixFallback(parsed.error, part.key, log);
    return {
      decision: { decision: "fix", hints: [] },
      tokens: reply.tokens,
      ...(reply.turns === undefined ? {} : { turns: reply.turns }),
      ...(reply.usageUnknown === undefined ? {} : { usageUnknown: reply.usageUnknown }),
      error: parsed.error,
    };
  }
  if (parsed.log !== undefined) log(parsed.log);
  return {
    decision: parsed.decision,
    tokens: reply.tokens,
    ...(reply.turns === undefined ? {} : { turns: reply.turns }),
    ...(reply.usageUnknown === undefined ? {} : { usageUnknown: reply.usageUnknown }),
  };
}
