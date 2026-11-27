// Turns a split plan into Linear sub-issues, idempotently. See docs/LOOP.md.
import {
  type BudgetSize,
  type Call,
  type Issue,
  isAreaLabel,
  type LinkedIssue,
  type QaConfig,
} from "@harnessd/shared";
import type { LinearClient } from "../linear/client.ts";
import type { PartQa, PartRole, PlanPart } from "./plan.ts";

/** Roles of a sub-issue: a planned part, or the QA part harnessd adds. */
export type SubIssueRole = PartRole | "qa";

/** Every sub-issue harnessd creates starts with this, so the loop can find its own. */
export const PART_MARKER_PREFIX = "harnessd part: ";

const MARKER = /^harnessd part: ((backend|frontend|qa)(?:-(\d+))?)[ \t]*$/m;

export interface PartMarker {
  /** "backend", "backend-2", "frontend" or "qa". */
  id: string;
  role: SubIssueRole;
}

/**
 * The first line of a sub-issue body, e.g. `harnessd part: backend`. Plain text rather than an
 * HTML comment, because Linear rewrites descriptions and may drop comments.
 */
export function partMarker(id: string): string {
  return `${PART_MARKER_PREFIX}${id}`;
}

export function readPartMarker(description: string): PartMarker | undefined {
  const match = MARKER.exec(description);
  if (!match?.[1] || !match[2]) return undefined;
  return { id: match[1], role: match[2] as SubIssueRole };
}

/** Marker ids for a plan: the first part of a role is `<role>`, later ones `<role>-2`, ... */
export function partIds(parts: readonly PlanPart[]): string[] {
  const seen = new Map<PartRole, number>();
  return parts.map((part) => {
    const n = (seen.get(part.role) ?? 0) + 1;
    seen.set(part.role, n);
    return n === 1 ? part.role : `${part.role}-${n}`;
  });
}

const SECTION_HEADER = /^\s*(?:#{1,6}\s*)?\*{0,2}([A-Za-z][A-Za-z ]*?)\*{0,2}\s*:?\s*\*{0,2}\s*$/;
const SECTION_START = /^\s*(?:#{1,6}\s|\*\*[^*]+\*\*)/;

/** The text under a `**Why**` / `## Why` header, up to the next section. Empty when absent. */
export function extractSection(body: string, name: string): string {
  const lines = body.split(/\r?\n/);
  const wanted = name.toLowerCase();
  const start = lines.findIndex(
    (line) => SECTION_HEADER.exec(line)?.[1]?.trim().toLowerCase() === wanted,
  );
  if (start === -1) return "";
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (SECTION_START.test(line)) break;
    out.push(line);
  }
  return out.join("\n").trim();
}

/** The body without the named sections, their headers and their text. Other lines stay. */
export function withoutSections(body: string, names: readonly string[]): string {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  const out: string[] = [];
  let skipping = false;
  for (const line of body.split(/\r?\n/)) {
    const header = SECTION_HEADER.exec(line)?.[1]?.trim().toLowerCase();
    if (header !== undefined && wanted.has(header)) {
      skipping = true;
      continue;
    }
    if (skipping && SECTION_START.test(line)) {
      skipping = false;
    }
    if (!skipping) out.push(line);
  }
  return out.join("\n").trim();
}

/** The items of a bullet-list section, as `- item` or `* item`. Empty when absent. */
export function sectionList(section: string): string[] {
  const out: string[] = [];
  for (const line of section.split(/\r?\n/)) {
    const match = /^\s*[-*]\s+(.+?)\s*$/.exec(line);
    if (match?.[1]) out.push(match[1]);
  }
  return out;
}

/** The text of each checklist line in a `Done when` section, checked or not. */
export function sectionChecklist(section: string): string[] {
  const out: string[] = [];
  for (const line of section.split(/\r?\n/)) {
    const match = /^\s*[-*]\s*\[[ xX]\]\s*(.+?)\s*$/.exec(line);
    if (match?.[1]) out.push(match[1]);
  }
  return out;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function doneWhenChecklist(issue: Issue, suffix = ""): string {
  if (issue.doneWhen.length === 0) return `- [ ] Matches ${issue.key} as written${suffix}`;
  return issue.doneWhen.map((d) => `- [ ] ${d.text}${suffix}`).join("\n");
}

/** QA runs at the parent's size, capped at M: an L parent's QA is still one M task. */
export function qaSize(parent: Issue): BudgetSize {
  return parent.size === "S" ? "S" : "M";
}

/** The grill calls a part names, by 1-based number or question text (D-044). */
export function resolvePartCalls(part: PlanPart, calls: readonly Call[]): Call[] {
  const out: Call[] = [];
  for (const ref of part.calls ?? []) {
    const match =
      typeof ref === "number" ? calls[ref - 1] : calls.find((c) => c.question.trim() === ref);
    if (match !== undefined && !out.includes(match)) out.push(match);
  }
  return out;
}

/** The parent's Done-when items a part covers, copied as text (MET-160). */
export function partDoneWhen(parent: Issue, part: PlanPart): string[] {
  if (parent.doneWhen.length === 0) return [`Matches ${parent.key} as written`];
  const out: string[] = [];
  for (const n of part.doneWhen) {
    const item = parent.doneWhen[n - 1];
    if (item !== undefined) out.push(item.text);
  }
  // The plan check proves that the numbers are in range. A hand-made part may still be
  // empty: it then carries the issue as written, like QA does.
  return out.length === 0 ? [`Matches ${parent.key} as written`] : out;
}

/** Body of a backend or frontend sub-issue: the part's fixed brief (MET-160). */
export function formatPartDescription(
  parent: Issue,
  part: PlanPart,
  id: string,
  calls: readonly Call[] = [],
): string {
  const why = extractSection(parent.description, "Why") || `Part of ${parent.key}.`;
  const decisions = part.decisions ?? [];
  const partCalls = resolvePartCalls(part, calls);
  // A part from before this field, or a hand-made plan, gets agent QA (D-053).
  const qa: PartQa = part.qa === "tests" ? "tests" : "agent";
  const lines = [
    partMarker(id),
    `Part of [${parent.key}](${parent.url}): ${parent.title}. Role: ${part.role}.`,
    "",
    "**Goal**",
    part.goal,
    "",
    "**Done when**",
    ...partDoneWhen(parent, part).map((text) => `- [ ] ${text}`),
    "",
    "**Files**",
    ...part.files.map((file) => `- ${file}`),
    "",
    "**Steps**",
    ...part.steps.map((step, i) => `${i + 1}. ${step}`),
    "",
    "**Verify**",
    ...part.verify.map((check) => `- \`${check.run}\` → ${check.expect}`),
    "",
    `**QA**: ${qa}`,
    "",
    "**Out of scope**",
    part.outOfScope,
    "",
  ];
  if (decisions.length > 0) {
    lines.push("**Decisions**");
    for (const decision of decisions) lines.push(`- ${decision.id}: ${decision.line}`);
    lines.push("");
  }
  if (partCalls.length > 0) {
    lines.push("**Grill calls**");
    for (const call of partCalls) lines.push(`- ${call.question} → ${call.answer}`);
    lines.push("");
  }
  lines.push(
    "**Why**",
    why,
    "",
    "**Spec links**",
    `- ${parent.key}: ${parent.url}`,
    "",
    `**Size**: ${part.size}`,
    "",
  );
  return lines.join("\n");
}

/** Body of the QA sub-issue, which every part blocks. */
export function formatQaDescription(parent: Issue, parts: readonly LinkedIssue[]): string {
  const keys = parts.map((p) => p.key).join(", ");
  return [
    partMarker("qa"),
    `QA for [${parent.key}](${parent.url}): ${parent.title}. Blocked by ${keys}.`,
    "",
    "**Why**",
    `Every "Done when" item of ${parent.key} is verified before merge (D-013).`,
    "",
    "**Done when**",
    doneWhenChecklist(parent, " (verified)"),
    "",
    "**Spec links**",
    `- ${parent.key}: ${parent.url}`,
    "",
    `**Size**: ${qaSize(parent)}`,
    "",
  ].join("\n");
}

/** The Linear calls a split makes. A LinearClient satisfies it. */
export type SplitLinear = Pick<
  LinearClient,
  "listChildren" | "createSubIssue" | "createBlocksRelation"
>;

export interface SplitResult {
  /** Backend and frontend sub-issues, in plan order (existing ones first when reused). */
  parts: LinkedIssue[];
  qa: LinkedIssue;
  /** Keys of the sub-issues this call created. */
  created: string[];
  /** Number of "blocks" relations this call created. */
  related: number;
}

/** True when the child is a backend or frontend part (not QA). */
export function isWorkPart(child: { description: string }): boolean {
  const marker = readPartMarker(child.description);
  return marker !== undefined && marker.role !== "qa";
}

/** True for Linear's Canceled state, whichever spelling the workflow uses. */
export function isCanceledState(state: string): boolean {
  const name = state.toLowerCase();
  return name === "canceled" || name === "cancelled";
}

/** True when a child is neither Done nor Canceled, so a split may reuse it (MET-216). */
export function isLiveChild(child: { state: string }): boolean {
  return child.state.toLowerCase() !== "done" && !isCanceledState(child.state);
}

/**
 * Creates one sub-issue per planned part and one QA sub-issue that every part blocks.
 * Only the children the caller passes as the reuse set are reused, never duplicated. A child
 * that is Done or Canceled is never reused, even when it is in that set. When the parent
 * already has parts, `plan` may be empty: only QA and missing relations are added. The
 * `parts` list is built in plan order, or in the caller's order when there is no plan.
 */
export async function splitIssue(
  parent: Issue,
  plan: readonly PlanPart[],
  linear: SplitLinear,
  children?: LinkedIssue[],
  calls: readonly Call[] = [],
): Promise<SplitResult> {
  const existing = (children ?? (await linear.listChildren(parent.id))).filter(isLiveChild);
  const byMarker = new Map<string, LinkedIssue>();
  for (const child of existing) {
    const marker = readPartMarker(child.description);
    if (marker && !byMarker.has(marker.id)) byMarker.set(marker.id, child);
  }
  const labels = parent.labels.filter(isAreaLabel);
  const created: string[] = [];

  const ids = partIds(plan);
  const parts: LinkedIssue[] = [];
  for (const [i, part] of plan.entries()) {
    const id = ids[i] ?? part.role;
    const reused = byMarker.get(id);
    if (reused !== undefined) {
      parts.push(reused);
      continue;
    }
    const child = await linear.createSubIssue(parent.id, {
      title: part.title,
      description: formatPartDescription(parent, part, id, calls),
      state: "Ready",
      labels,
    });
    byMarker.set(id, child);
    parts.push(child);
    created.push(child.key);
  }
  // A recorded split passes no plan on the next tick: keep its live parts in the order the
  // caller gave, which is the record's plan order.
  if (plan.length === 0) {
    for (const child of existing) {
      if (isWorkPart(child) && !parts.includes(child)) parts.push(child);
    }
  }
  if (parts.length === 0) throw new Error(`${parent.key}: nothing to split, the plan is empty`);

  let qa = byMarker.get("qa");
  if (qa === undefined) {
    qa = await linear.createSubIssue(parent.id, {
      title: `QA: ${parent.title}`,
      description: formatQaDescription(parent, parts),
      state: "Ready",
      labels,
    });
    created.push(qa.key);
  }

  let related = 0;
  for (const part of parts) {
    if (qa.blockers.some((b) => b.id === part.id || b.key === part.key)) continue;
    await linear.createBlocksRelation(part.id, qa.id);
    related++;
  }
  // Parts of one parent run one after another: part n blocks part n+1. A split that was
  // interrupted gets the missing relations on the next tick (D-040).
  for (let i = 1; i < parts.length; i++) {
    const previous = parts[i - 1];
    const part = parts[i];
    if (previous === undefined || part === undefined) continue;
    if (part.blockers.some((b) => b.id === previous.id || b.key === previous.key)) continue;
    await linear.createBlocksRelation(previous.id, part.id);
    related++;
  }
  return { parts, qa, created, related };
}

/**
 * The once-per-repo warning the first split note carries while the repo runs no live app
 * (MET-180). It points at the config key that turns live QA on.
 */
export const NO_LIVE_QA_NOTE =
  "QA runs no live app: .harnessd/config.toml has no [qa] kind (docs/CONFIG.md).";

/**
 * The line a split note adds when `qa.kind` is missing and the repo never warned, with the
 * time to record as `qaLiveWarned`. Undefined once kind is set or the warning went out.
 */
export function noLiveQaWarning(
  qa: Pick<QaConfig, "kind">,
  warnedAt: string | undefined,
  now: string,
): { line: string; warnedAt: string } | undefined {
  if (qa.kind !== undefined || warnedAt !== undefined) return undefined;
  return { line: NO_LIVE_QA_NOTE, warnedAt: now };
}

/**
 * The parent comment after a split that created something (MET-162). Each part names its
 * goal and files; the QA line names the parts that block it. The note always ends with
 * `Reason: <reason>`, for a split and for a one-part plan. `noLiveQa` is the warning line
 * that goes just before the reason (MET-180).
 */
export function formatSplitComment(
  result: SplitResult,
  reason?: string,
  noLiveQa?: string,
): string {
  const lines = [`**Coordinator split**: ${result.parts.length + 1} sub-issues.`, ""];
  for (const part of result.parts) {
    const role = readPartMarker(part.description)?.role ?? "part";
    const goal = oneLine(extractSection(part.description, "Goal") || part.title);
    const files = sectionList(extractSection(part.description, "Files"));
    lines.push(`- ${part.key} ${role} (${part.size ?? "?"}): ${goal}`);
    lines.push(`  Files: ${files.length > 0 ? files.join(", ") : "(none)"}`);
  }
  lines.push(
    `- ${result.qa.key} qa (${result.qa.size ?? "?"}): blocked by ${result.parts.map((p) => p.key).join(", ")}`,
    "",
    ...(noLiveQa === undefined ? [] : [noLiveQa]),
    `Reason: ${reason?.trim() ? oneLine(reason) : "not given"}`,
  );
  return `${lines.join("\n")}\n`;
}
