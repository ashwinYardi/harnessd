// The review run: a senior-dev code review of a part's PR before QA (MET-165, MET-223).
// The reviewer reads the diff, the parent issue and the part brief in a read-only PR-head
// checkout, then returns a strict JSON verdict. A blocking finding sends the PR back; a nit
// does not. See D-060.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  emptyTokenUsage,
  type HarnessAdapter,
  type Issue,
  type LinkedIssue,
  type ResolvedAgentConfig,
  type Task,
  type TokenUsage,
} from "@harnessd/shared";
import type { GitHub, PullRequest } from "../github/client.ts";
import type { LinearClient } from "../linear/client.ts";
import { isNetworkError } from "../net-error.ts";
import type { TaskWorktrees } from "../worktrees/index.ts";
import { agentPromptHeader, partBrief } from "./dispatch.ts";
import { runForReply } from "./grill.ts";
import type { Notifier } from "./notifier.ts";
import { type AgentMemory, memorySection } from "./prompt.ts";
import { cutDiff, MAX_PROMPT_DIFF, parseStrictJson } from "./qa.ts";
import { extractSection } from "./split.ts";
import type { LoopState, QaFeedback } from "./state.ts";

const runGit = promisify(execFile);

/** One finding of a review verdict. */
export interface ReviewFinding {
  /** Path from the repo root. */
  file: string;
  /** 1-based line the finding points at. */
  line: number;
  /** `blocking` sends the PR back; `nit` does not. */
  severity: "blocking" | "nit";
  /** `code` for the implementation, `design` for the shape of the change. */
  kind: "code" | "design";
  text: string;
}

export interface ReviewVerdict {
  decision: "approve" | "changes_requested";
  findings: ReviewFinding[];
}

export type ParsedReviewVerdict =
  | { ok: true; verdict: ReviewVerdict }
  | {
      ok: false;
      error: string;
      /** Set when the reply was not valid JSON, even after the backslash repair (D-052). */
      kind?: "not_json";
    };

/** The JSON shape the reviewer must end with. */
export const REVIEW_VERDICT_SHAPE = `{
  "decision": "approve" | "changes_requested",
  "findings": [
    { "file": "string", "line": 1, "severity": "blocking" | "nit", "kind": "code" | "design", "text": "string" }
  ]
}`;

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const FINDING_KEYS = ["file", "line", "severity", "kind", "text"];

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * Strictly validates a review verdict: known keys only, `decision` one of two values, a
 * non-empty file and text, an integer line >= 1, and `blocking`/`nit` plus `code`/`design`.
 * An approve with a blocking finding, or changes_requested with no blocking finding, is a
 * schema error. Invalid JSON after the backslash repair stays `not_json` (D-052).
 */
export function parseReviewVerdict(text: string): ParsedReviewVerdict {
  const parsed = parseStrictJson(text);
  if ("error" in parsed) {
    return { ok: false, error: `not JSON: ${parsed.error.message}`, kind: "not_json" };
  }
  const value = parsed.value;
  if (!isObj(value)) return { ok: false, error: "expected a JSON object" };
  for (const key of Object.keys(value)) {
    if (key !== "decision" && key !== "findings") {
      return { ok: false, error: `unknown key "${key}"` };
    }
  }
  if (value.decision !== "approve" && value.decision !== "changes_requested") {
    return { ok: false, error: 'decision: expected "approve" or "changes_requested"' };
  }
  if (!Array.isArray(value.findings)) return { ok: false, error: "findings: expected an array" };

  const findings: ReviewFinding[] = [];
  for (const [i, raw] of value.findings.entries()) {
    const path = `findings[${i}]`;
    if (!isObj(raw)) return { ok: false, error: `${path}: expected an object` };
    for (const key of Object.keys(raw)) {
      if (!FINDING_KEYS.includes(key)) return { ok: false, error: `${path}: unknown key "${key}"` };
    }
    if (!nonEmpty(raw.file)) {
      return { ok: false, error: `${path}.file: expected a non-empty string` };
    }
    if (typeof raw.line !== "number" || !Number.isInteger(raw.line) || raw.line < 1) {
      return { ok: false, error: `${path}.line: expected an integer of at least 1` };
    }
    if (raw.severity !== "blocking" && raw.severity !== "nit") {
      return { ok: false, error: `${path}.severity: expected "blocking" or "nit"` };
    }
    if (raw.kind !== "code" && raw.kind !== "design") {
      return { ok: false, error: `${path}.kind: expected "code" or "design"` };
    }
    if (!nonEmpty(raw.text)) {
      return { ok: false, error: `${path}.text: expected a non-empty string` };
    }
    findings.push({
      file: raw.file.trim(),
      line: raw.line,
      severity: raw.severity,
      kind: raw.kind,
      text: raw.text.trim(),
    });
  }

  const blocking = findings.filter((finding) => finding.severity === "blocking");
  if (value.decision === "approve" && blocking.length > 0) {
    return { ok: false, error: "decision: approve had a blocking finding" };
  }
  if (value.decision === "changes_requested" && blocking.length === 0) {
    return {
      ok: false,
      error: "decision: changes_requested needs at least one blocking finding",
    };
  }
  return { ok: true, verdict: { decision: value.decision, findings } };
}

export interface ReviewPromptInput {
  agent: ResolvedAgentConfig;
  /** The part under review. */
  part: LinkedIssue;
  /** The parent issue whose body and decisions the part implements. */
  parent: Issue;
  pr: PullRequest;
  /** The PR's unified diff. Ignored when `delta` is set. */
  diff?: string;
  /** The diff since the last review, after a send-back. */
  delta?: string;
  /** The blocking findings of an earlier review round. */
  earlierFindings?: readonly ReviewFinding[];
  /** The vaults, when the loop synced the harness files into the checkout (MET-55). */
  memory?: AgentMemory;
}

/** The part's fixed brief plus the Decisions and Grill calls sections (D-044, D-049). */
function reviewBrief(part: LinkedIssue): string {
  const brief = partBrief(part.description);
  if (brief === undefined) return part.description.trim() || "(none)";
  const extra: string[] = [];
  for (const name of ["Decisions", "Grill calls"]) {
    const text = extractSection(part.description, name);
    if (text !== "") extra.push(`**${name}**\n${text}`);
  }
  return [brief, ...extra].join("\n\n");
}

function diffSection(diff: string | undefined, delta: string | undefined): string {
  const text = delta ?? diff;
  if (text === undefined) {
    return "## Diff\n(the daemon could not read it; review the files this PR changes in this checkout.)";
  }
  const cut = cutDiff(text);
  const title = delta === undefined ? "## Diff" : "## Delta since the last review";
  const body = `\`\`\`diff\n${cut.text || "(empty)"}\n\`\`\``;
  if (cut.omitted === 0) return `${title}\n${body}`;
  return (
    `${title}\n${body}\nThe diff was cut after ${MAX_PROMPT_DIFF} characters; ` +
    `${cut.omitted} were left out.`
  );
}

function findingLine(finding: ReviewFinding): string {
  return `- ${finding.file}:${finding.line} (${finding.severity}, ${finding.kind}): ${finding.text}`;
}

/** The senior-dev rubric: what a strong reviewer checks beyond the tests (MET-223). */
const RUBRIC = [
  "## Senior-dev rubric",
  "Judge the change as a senior developer on a strong model, against the code around the diff.",
  [
    "### Architecture and layering",
    "- Does the change sit in the right module, and are the seams in the right place?",
    "- Does it deepen a module or leak its details across a boundary?",
    "- Is a dependency added in the wrong layer, or does the change duplicate an existing path?",
  ].join("\n"),
  [
    "### Scalability",
    "- Hot paths: does the change add work to a path that runs per request, per tick or per token?",
    "- Repeated I/O: does it re-read a file, re-run a command or re-query a service in a loop that could be hoisted or batched?",
    "- Unbounded growth: does it keep a map, list, cache or log that can grow without a limit?",
    "- Blocking calls: does it block the event loop or a critical path where an async call belongs?",
  ].join("\n"),
  [
    "### Trade-offs",
    "- What does the change choose, and is the cost worth it?",
    "- Name the alternative it rejects, and say whether the reason holds for this repo.",
  ].join("\n"),
  [
    "### Best practices",
    "- Error handling: are failures surfaced, typed and handled at the right level?",
    "- Duplication: is there a second copy of logic, a prompt block or a parser that should be shared?",
    "- Dead code: does the change leave unused exports, parameters, branches or comments behind?",
  ].join("\n"),
].join("\n\n");

/** The reviewer's prompt for one PR. */
export function buildReviewPrompt(input: ReviewPromptInput): string {
  const { agent, part, parent, pr, diff, delta, earlierFindings, memory } = input;
  const out = agentPromptHeader(agent, part, "");
  const earlierBlocking = (earlierFindings ?? []).filter(
    (finding) => finding.severity === "blocking",
  );
  out.push(
    `## PR under review\nPart ${part.key}: ${part.title} (${part.url})\n` +
      `PR #${pr.number}: ${pr.title}\n${pr.url}\n` +
      `Branch \`${pr.headRefName}\` at \`${pr.headRefOid}\`, into \`${pr.baseRefName}\`.`,
    diffSection(diff, delta),
    `## Parent issue ${parent.key}: ${parent.title}\n${parent.url}\n\n` +
      `${parent.description.trim() || "(none)"}`,
    `## Part brief\n${reviewBrief(part)}`,
    ...(earlierBlocking.length > 0
      ? [
          `## Earlier blocking findings (${earlierBlocking.length})\n` +
            `${earlierBlocking.map(findingLine).join("\n")}\n\n` +
            "Say for each whether the new diff fixes it.",
        ]
      : []),
    [
      "## How to review",
      "- Read the diff, the parent issue and the part brief with its Decisions and Grill calls sections. Open the code around the diff that you need, GLOSSARY.md, the workspace glossary and any decision record the brief or the code names.",
      "- Do not read all of docs/SPEC.md. Read only the section the brief or a finding needs.",
      "- Edit nothing: do not edit files, commit, push, comment or review. This worktree is a detached checkout of the PR head, and harnessd posts the review from your verdict.",
      "- Judge the change, not the tests alone: a green test run does not excuse a design fault or a hot-path regression.",
      "- A finding names the file and the line closest to the fault. A design finding points at the line where the design breaks.",
      "- Mark a finding `blocking` only when it must be fixed before merge. A `nit` is polish that does not block.",
      "- Approve only when there is no blocking finding.",
    ].join("\n"),
    RUBRIC,
    `## Verdict\nYour final message is strict JSON only, no prose and no code fence:\n${REVIEW_VERDICT_SHAPE}\n` +
      "`decision` is `approve` only when there is no blocking finding. `changes_requested` needs at least one blocking finding. " +
      "Every finding names a `file` and a `line` of at least 1, and is marked `blocking` or `nit` and `code` or `design`.",
  );
  if (memory) out.push(memorySection(memory));
  return `${out.join("\n\n")}\n`;
}

export interface ReviewTaskInput {
  id: string;
  title: string;
  prompt: string;
  budgetMs: number;
  maxTurns?: number;
  model?: string;
}

/**
 * Builds the reviewer's task: read-only on every harness, with the reviewer role so Claude
 * Code keeps the Agent tool for the code-review sub-agents (MET-223, D-059).
 */
export function buildReviewTask(input: ReviewTaskInput): Task {
  const task: Task = {
    id: input.id,
    title: input.title,
    prompt: input.prompt,
    budgetMs: input.budgetMs,
    readOnly: true,
    role: "reviewer",
  };
  if (input.maxTurns !== undefined) task.maxTurns = input.maxTurns;
  if (input.model !== undefined) task.model = input.model;
  return task;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Reads the delta `base..head` from the PR-head checkout; undefined when base is not its ancestor. */
async function gitDelta(worktree: string, base: string, head: string): Promise<string | undefined> {
  try {
    await runGit("git", ["-C", worktree, "merge-base", "--is-ancestor", base, head], {
      timeout: 30_000,
    });
  } catch {
    return undefined;
  }
  try {
    const { stdout } = await runGit("git", ["-C", worktree, "diff", `${base}..${head}`], {
      maxBuffer: 16 * 1024 * 1024,
      timeout: 30_000,
    });
    return stdout;
  } catch {
    return undefined;
  }
}

export interface ReviewCommentInput {
  part: LinkedIssue;
  parent: Issue;
  pr: PullRequest;
  verdict: ReviewVerdict;
}

/**
 * The PR comment review (MET-224, D-060): every blocking finding and nit, each with its
 * file and line. It is always a COMMENT: the account opened the PR, so GitHub refuses an
 * APPROVE, and the merge decision belongs to the gate (D-013).
 */
export function formatReviewComment(input: ReviewCommentInput): string {
  const { part, parent, pr, verdict } = input;
  const blocking = verdict.findings.filter((finding) => finding.severity === "blocking");
  const nits = verdict.findings.filter((finding) => finding.severity === "nit");
  const decision = verdict.decision === "approve" ? "approved" : "changes requested";
  const lines = [
    `**harnessd review** (reviewer): ${decision} at \`${pr.headRefOid}\` for ${part.key}, PR #${pr.number} (${parent.key}).`,
  ];
  if (blocking.length === 0) {
    lines.push("", "No blocking finding.");
  } else {
    lines.push("", `Blocking (${blocking.length}):`, ...blocking.map(findingLine));
  }
  if (nits.length > 0) {
    lines.push("", `Nits (${nits.length}):`, ...nits.map(findingLine));
  }
  return `${lines.join("\n")}\n`;
}

export interface ReviewRunInput {
  part: LinkedIssue;
  parent: Issue;
  pr: PullRequest;
  /** The part's size budget (D-014). */
  budgetMs: number;
  /** The reviewer turn cap for the part's size (D-045, D-047). */
  maxTurns?: number;
  /** The last judged head, so a new head gets a delta review (MET-225, D-060). */
  since?: { sha: string; findings: readonly ReviewFinding[] };
}

export interface ReviewRunDeps {
  github: Pick<GitHub, "prDiff" | "findPrByHead">;
  worktrees: Pick<TaskWorktrees, "checkout" | "remove">;
  adapter: HarnessAdapter;
  agent: ResolvedAgentConfig;
  /** Syncs the harness files into the checkout, as QA does (MET-55). */
  prepare?: (worktree: string, runId: string) => Promise<Record<string, string>>;
  /** Told the checkout in use ("" once removed), so a crash can clean it up. */
  onWorktree?: (path: string) => void;
  /** Reads `base..head` from the checkout, or undefined when base is not an ancestor. */
  deltaDiff?: (worktree: string, base: string, head: string) => Promise<string | undefined>;
  memory?: AgentMemory;
  /** Aborted by a pause: the reviewer is stopped and the checkout removed (D-041). */
  signal?: AbortSignal;
  log?: (line: string) => void;
}

export interface ReviewRunResult {
  pr: PullRequest;
  verdict?: ReviewVerdict;
  /** The comment body, set with the verdict. */
  body?: string;
  tokens: TokenUsage;
  turns?: number;
  usageUnknown?: true;
  /** The reviewer's harness hit a usage limit: no verdict, no failure (MET-70). */
  limited?: boolean;
  /** `signal` stopped the run. Nothing is posted and no verdict is recorded. */
  cancelled?: boolean;
  /** A turn cap, timeout, stall or invalid JSON: not judged, so no review failure (MET-225). */
  notJudged?: "turn_cap" | "timeout" | "stalled" | "not_json";
  error?: string;
}

/**
 * One review of a part's PR at its head (MET-224, D-060). It checks the PR head out, puts
 * the diff in the prompt, runs the reviewer read-only, and returns the verdict and comment for the loop to settle.
 * The scratch checkout is never kept (D-041).
 */
export async function runReview(
  input: ReviewRunInput,
  deps: ReviewRunDeps,
): Promise<ReviewRunResult> {
  const { part, parent, pr } = input;
  const { agent } = deps;
  const log = deps.log ?? (() => {});
  const id = `${part.key}-review-pr${pr.number}`;
  let tokens: TokenUsage = emptyTokenUsage();
  let turns: number | undefined;
  let usageUnknown: true | undefined;
  let path: string | undefined;
  const cancelled = (): boolean => deps.signal?.aborted === true;
  try {
    const checkout = await deps.worktrees.checkout({
      issueKey: part.key,
      title: `pr ${pr.number}`,
      branch: pr.headRefName,
      sha: pr.headRefOid,
    });
    path = checkout.path;
    deps.onWorktree?.(path);
    if (cancelled()) return { pr, tokens, cancelled: true };
    let env: Record<string, string> | undefined;
    if (deps.prepare !== undefined) {
      try {
        env = await deps.prepare(path, id);
      } catch (error) {
        throw new Error(`harnessd sync into the worktree failed: ${message(error)}`);
      }
    }
    const diff = await deps.github.prDiff(pr.number);
    const current = await deps.github.findPrByHead(pr.headRefName);
    if (current?.number !== pr.number || current.headRefOid !== pr.headRefOid) {
      throw new Error(`PR #${pr.number} changed while reading its diff`);
    }
    let delta: string | undefined;
    if (input.since !== undefined && input.since.sha !== pr.headRefOid) {
      const read = deps.deltaDiff ?? gitDelta;
      try {
        delta = await read(path, input.since.sha, pr.headRefOid);
      } catch (error) {
        log(`${part.key}: could not read the review delta: ${message(error)}`);
      }
    }
    const prompt = buildReviewPrompt({
      agent,
      part,
      parent,
      pr,
      diff,
      ...(delta === undefined ? {} : { delta }),
      ...(input.since === undefined ? {} : { earlierFindings: input.since.findings }),
      ...(deps.memory === undefined ? {} : { memory: deps.memory }),
    });

    const task = buildReviewTask({
      id,
      title: `Review ${part.key}: PR #${pr.number}`,
      prompt,
      budgetMs: input.budgetMs,
      ...(input.maxTurns === undefined ? {} : { maxTurns: input.maxTurns }),
      ...(agent.model === undefined ? {} : { model: agent.model }),
    });
    if (env !== undefined) task.env = env;
    if (cancelled()) return { pr, tokens, cancelled: true };

    const reply = await runForReply(deps.adapter, task, path);
    tokens = reply.tokens;
    turns = reply.turns;
    usageUnknown = reply.usageUnknown;
    if (cancelled())
      return { pr, tokens, cancelled: true, ...(turns === undefined ? {} : { turns }) };
    if (!reply.ok) {
      const notJudged =
        reply.reason === "turn_cap" || reply.reason === "stalled"
          ? reply.reason
          : reply.timeout === true
            ? "timeout"
            : undefined;
      return {
        pr,
        tokens,
        ...(turns === undefined ? {} : { turns }),
        ...(usageUnknown === undefined ? {} : { usageUnknown }),
        ...(reply.limited ? { limited: true } : {}),
        ...(notJudged === undefined ? {} : { notJudged }),
        error: reply.error,
      };
    }
    const parsed = parseReviewVerdict(reply.text);
    if (!parsed.ok) {
      return {
        pr,
        tokens,
        ...(turns === undefined ? {} : { turns }),
        ...(usageUnknown === undefined ? {} : { usageUnknown }),
        ...(parsed.kind === "not_json" ? { notJudged: "not_json" as const } : {}),
        error: `the review verdict was unusable: ${parsed.error}`,
      };
    }
    const body = formatReviewComment({ part, parent, pr, verdict: parsed.verdict });
    return {
      pr,
      verdict: parsed.verdict,
      body,
      tokens,
      ...(turns === undefined ? {} : { turns }),
      ...(usageUnknown === undefined ? {} : { usageUnknown }),
    };
  } catch (error) {
    return {
      pr,
      tokens,
      ...(turns === undefined ? {} : { turns }),
      ...(usageUnknown === undefined ? {} : { usageUnknown }),
      ...(cancelled() ? { cancelled: true } : { error: message(error) }),
    };
  } finally {
    // A review PR-head checkout is never kept, even when it has local changes (D-041).
    if (path !== undefined) {
      try {
        const result = await deps.worktrees.remove(path, { force: true });
        if (result.removed) deps.onWorktree?.("");
      } catch (error) {
        log(`${part.key}: could not remove ${path}: ${message(error)}`);
      }
    }
  }
}

// --- settling a review verdict (MET-225, D-014, D-046, D-052, D-059) ------------

/** A review that gave no usable verdict (MET-225, D-052). */
export type ReviewNotJudged = "turn_cap" | "timeout" | "stalled" | "not_json";

/** What a review settle did: send back, approve, ask a human, or retry. */
export type ReviewSettlement = "approved" | "sent_back" | "escalated" | "requeued" | "pending";

/** The Linear calls a review settle makes. A LinearClient satisfies it. */
export type ReviewLinear = Pick<LinearClient, "comment" | "moveTo">;

/** The settle writes a retry may skip, kept across ticks (D-058). */
export interface ReviewSettleSteps {
  done: string[];
  mark(step: string): void | Promise<void>;
}

export interface ReviewSettleInput {
  part: LinkedIssue;
  parent: Issue;
  pr: PullRequest;
  /** The judged verdict; unset when the run gave no verdict. */
  verdict?: ReviewVerdict;
  /** Why the run could not judge the head, when it could not (D-052). */
  notJudged?: ReviewNotJudged;
  /** The run's error, for the log line of a failed review. */
  error?: string;
  /** The GitHub review comment, when it was posted. */
  reviewUrl?: string;
}

export interface ReviewSettleDeps {
  linear: ReviewLinear;
  notifier: Notifier;
  /** `limits.qa_max_failures`: failed reviews on one part before a human is asked (D-014). */
  maxFailures: number;
  log?: (line: string) => void;
  /**
   * The steps a retry already finished, by the name the log gives them (D-058).
   * A retry skips a done step and a network error leaves the rest for the next tick.
   */
  steps?: ReviewSettleSteps;
}

/**
 * In-memory not-judged reviews per part, with the head they happened on and why (MET-225,
 * like D-052 for QA). A restart resets it, which costs at most one extra review run.
 */
const reviewNotJudgedRuns = new Map<string, { head: string; count: number; reasons: string[] }>();

/** Forgets the counted not-judged reviews; tests start clean with it. */
export function resetReviewNotJudged(): void {
  reviewNotJudgedRuns.clear();
}

function nextNotJudged(
  partId: string,
  head: string,
  reason: string,
): { head: string; count: number; reasons: string[] } {
  const previous = reviewNotJudgedRuns.get(partId);
  const sameHead = previous?.head === head;
  return {
    head,
    count: sameHead ? (previous?.count ?? 0) + 1 : 1,
    reasons: sameHead ? [...(previous?.reasons ?? []), reason] : [reason],
  };
}

function clearNotJudged(partId: string): void {
  reviewNotJudgedRuns.delete(partId);
}

function times(n: number): string {
  return n === 1 ? "once" : n === 2 ? "twice" : `${n} times`;
}

function notJudgedReason(notJudged: ReviewNotJudged, error: string | undefined): string {
  switch (notJudged) {
    case "timeout":
      return "timed out";
    case "stalled":
      return "stalled";
    case "turn_cap": {
      const cap = /turn cap \(\d+ turns\)/.exec(error ?? "");
      return cap?.[0] ?? "turn cap";
    }
    case "not_json": {
      const text = error ?? "unknown";
      const at = text.indexOf("not JSON: ");
      return `verdict not JSON: ${at === -1 ? oneLine(text) : text.slice(at + 10)}`;
    }
  }
}

/** One numbered blocking fix for the builder: `R1 (file:line) text` (MET-225). */
export function reviewFindingList(findings: readonly ReviewFinding[]): string[] {
  return findings
    .filter((finding) => finding.severity === "blocking")
    .map((finding, i) => `R${i + 1} (${finding.file}:${finding.line}) ${finding.text}`);
}

/**
 * Applies one review. A blocking design finding moves the part and parent to Needs input
 * with one parent comment and one notice: the coordinator cannot re-plan by itself (D-059).
 * A blocking code finding sets `qaFeedback` with source `review` and moves the part to
 * Ready, so its next run resumes the builder (D-046). An approve sends nothing back and
 * leaves nits only in the PR comment. Two failed reviews, or two not-judged reviews on one
 * head, move the part and parent to Needs input (D-014, D-052).
 *
 * A network error stops the writes and returns `pending` without changing any state; the
 * loop keeps the record for a retry and skips the steps already done (D-058).
 */
export async function settleReview(
  state: Pick<LoopState, "reviewFailures" | "qaFeedback"> & {
    harnessSwitch?: LoopState["harnessSwitch"];
  },
  input: ReviewSettleInput,
  deps: ReviewSettleDeps,
): Promise<ReviewSettlement> {
  const { part, parent, pr } = input;
  const log = deps.log ?? (() => {});
  const steps = deps.steps;
  const done = new Set(steps?.done ?? []);
  /** A network error stopped the writes: the rest waits for the next tick (D-058). */
  let stopped = false;
  const mark = async (step: string): Promise<void> => {
    if (done.has(step)) return;
    done.add(step);
    await steps?.mark(step);
  };
  const safely = async (
    what: string,
    fn: () => Promise<unknown>,
    retryNetwork = true,
  ): Promise<void> => {
    if (done.has(what) || stopped) return;
    try {
      await fn();
    } catch (error) {
      log(`could not ${what}: ${message(error)}`);
      if (retryNetwork && isNetworkError(error)) {
        stopped = true;
        return;
      }
      // A non-network failure is logged and the settle goes on.
    }
    await mark(what);
  };
  const escalate = async (
    reason: string,
    detail: string,
    comment: string,
  ): Promise<ReviewSettlement> => {
    await safely(`comment on ${parent.key}`, () =>
      deps.linear.comment(parent.id, `**harnessd review**: ${comment}\n`),
    );
    await safely(`move ${parent.key} to Needs input`, () =>
      deps.linear.moveTo(parent.id, "Needs input"),
    );
    await safely(`move ${part.key} to Needs input`, () =>
      deps.linear.moveTo(part.id, "Needs input"),
    );
    await safely("send the notice", () =>
      deps.notifier.notify({
        kind: "needs_input",
        issue: { key: parent.key, url: parent.url },
        prs: [{ number: pr.number, url: pr.url }],
        reason,
        detail,
      }),
    );
    if (stopped) return "pending";
    delete state.reviewFailures[part.id];
    delete state.qaFeedback[part.id];
    if (state.harnessSwitch !== undefined) {
      // Needs input ends any harness switch for the part and the parent (D-048).
      delete state.harnessSwitch[part.id];
      delete state.harnessSwitch[parent.id];
    }
    clearNotJudged(part.id);
    log(`${part.key}: ${detail}, Needs input`);
    return "escalated";
  };

  const blocking = (input.verdict?.findings ?? []).filter(
    (finding) => finding.severity === "blocking",
  );
  const design = blocking.filter((finding) => finding.kind === "design");

  // The design rule wins in a mixed verdict: nothing goes back to the builder (D-059).
  if (design.length > 0) {
    return escalate(
      "reviewer found a design fault",
      `review found a design fault on ${part.key} PR #${pr.number}`,
      [
        `the review found ${design.length} blocking design finding${design.length === 1 ? "" : "s"} on ${part.key} [PR #${pr.number}](${pr.url}).`,
        "A human decides; nothing was sent back to the builder (D-059).",
        "",
        ...design.map(findingLine),
      ].join("\n"),
    );
  }

  if (input.notJudged !== undefined) {
    const reason = notJudgedReason(input.notJudged, input.error);
    const counted = nextNotJudged(part.id, pr.headRefOid, reason);
    if (counted.count >= 2) {
      const head = counted.head.slice(0, 7);
      return escalate(
        "review not judged twice",
        `review was not judged twice on ${part.key} PR #${pr.number} at ${head}: ${counted.reasons.join("; ")}. No review failure counted.`,
        `the review was not judged twice on ${part.key} [PR #${pr.number}](${pr.url}) at \`${head}\`: ${counted.reasons.join("; ")}. No review failure counted. A human decides (D-052).`,
      );
    }
    reviewNotJudgedRuns.set(part.id, counted);
    log(`${part.key}: review not judged (${reason}), re-queued`);
    return "requeued";
  }

  if (input.verdict === undefined) {
    const failures = (state.reviewFailures[part.id] ?? 0) + 1;
    if (failures >= deps.maxFailures) {
      return escalate(
        `review failed ${times(failures)}`,
        `review failed ${times(failures)} on ${part.key}`,
        `the review failed ${times(failures)} on ${part.key} [PR #${pr.number}](${pr.url}), so this needs a human (D-014). ${part.key} and ${parent.key} are in Needs input.\n\n${oneLine(input.error ?? "no verdict")}`,
      );
    }
    state.reviewFailures[part.id] = failures;
    log(`${part.key}: review failed (${oneLine(input.error ?? "no verdict")}), re-queued`);
    return "requeued";
  }

  // A judged verdict clears the not-judged count for this part (D-052).
  clearNotJudged(part.id);

  if (input.verdict.decision === "approve") {
    // Keep the failure count until the part is Done or escalated (MET-230): an approval
    // does not erase the two-failure rule set on earlier rounds (D-014).
    const feedback = state.qaFeedback[part.id];
    if (feedback?.source === "review") delete state.qaFeedback[part.id];
    log(`${part.key}: review approved, PR #${pr.number}`);
    return "approved";
  }

  const failures = (state.reviewFailures[part.id] ?? 0) + 1;
  if (failures >= deps.maxFailures) {
    return escalate(
      `review failed ${times(failures)}`,
      `review failed ${times(failures)} on ${part.key}`,
      [
        `the review found blocking findings ${times(failures)} on ${part.key} [PR #${pr.number}](${pr.url}), so this needs a human (D-014). ${part.key} and ${parent.key} are in Needs input, and nothing is sent back again.`,
        "",
        ...blocking.map(findingLine),
      ].join("\n"),
    );
  }

  const feedback: QaFeedback = {
    source: "review",
    prUrl: pr.url,
    failing: reviewFindingList(blocking),
  };
  if (input.reviewUrl !== undefined) feedback.reviewUrl = input.reviewUrl;
  const body = [
    `**harnessd review**: changes requested on [PR #${pr.number}](${pr.url}) (round ${failures} of ${deps.maxFailures}, D-014). Back to Ready so the builder fixes these findings.`,
    "",
    ...reviewFindingList(blocking).map((line) => `- ${line}`),
  ].join("\n");
  await safely(`comment on ${part.key}`, () => deps.linear.comment(part.id, `${body}\n`));
  await safely(`re-queue ${part.key}`, () => deps.linear.moveTo(part.id, "Ready"));
  if (stopped) return "pending";
  state.qaFeedback[part.id] = feedback;
  state.reviewFailures[part.id] = failures;
  log(
    `${part.key}: review changes requested, sent back with ${blocking.length} finding${blocking.length === 1 ? "" : "s"}`,
  );
  return "sent_back";
}
