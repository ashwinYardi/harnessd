// The review run: a senior-dev code review of a part's PR before QA (MET-165, MET-223).
// The reviewer reads the diff, the parent issue and the part brief in a read-only PR-head
// checkout, then returns a strict JSON verdict. A blocking finding sends the PR back; a nit
// does not. See docs/LOOP.md "Review".
import type { Issue, LinkedIssue, ResolvedAgentConfig, Task } from "@harnessd/shared";
import type { PullRequest } from "../github/client.ts";
import { agentPromptHeader, partBrief } from "./dispatch.ts";
import { type AgentMemory, memorySection } from "./prompt.ts";
import { cutDiff, MAX_PROMPT_DIFF, parseStrictJson } from "./qa.ts";
import { extractSection } from "./split.ts";

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
