// Turns a split plan into Linear sub-issues, idempotently. See docs/LOOP.md.
import { type BudgetSize, type Issue, isAreaLabel, type LinkedIssue } from "@harnessd/shared";
import type { LinearClient } from "../linear/client.ts";
import type { PartRole, PlanPart } from "./plan.ts";

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

function doneWhenChecklist(issue: Issue, suffix = ""): string {
  if (issue.doneWhen.length === 0) return `- [ ] Matches ${issue.key} as written${suffix}`;
  return issue.doneWhen.map((d) => `- [ ] ${d.text}${suffix}`).join("\n");
}

/** QA runs at the parent's size, capped at M: an L parent's QA is still one M task. */
export function qaSize(parent: Issue): BudgetSize {
  return parent.size === "S" ? "S" : "M";
}

/** Body of a backend or frontend sub-issue. */
export function formatPartDescription(parent: Issue, part: PlanPart, id: string): string {
  const why = extractSection(parent.description, "Why") || `Part of ${parent.key}.`;
  return [
    partMarker(id),
    `Part of [${parent.key}](${parent.url}): ${parent.title}. Role: ${part.role}.`,
    "",
    "**Why**",
    why,
    "",
    "**Done when**",
    doneWhenChecklist(parent),
    "",
    "**Spec links**",
    `- ${parent.key}: ${parent.url}`,
    "",
    `**Size**: ${part.size}`,
    "",
    "**Brief**",
    part.prompt,
    "",
  ].join("\n");
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

/**
 * Creates one sub-issue per planned part and one QA sub-issue that every part blocks.
 * Sub-issues already present (matched by marker) are reused, never duplicated. When the
 * parent already has parts, `plan` may be empty: only QA and missing relations are added.
 * `children` is the parent's current children, when the caller already has them.
 */
export async function splitIssue(
  parent: Issue,
  plan: readonly PlanPart[],
  linear: SplitLinear,
  children?: LinkedIssue[],
): Promise<SplitResult> {
  const existing = children ?? (await linear.listChildren(parent.id));
  const byMarker = new Map<string, LinkedIssue>();
  for (const child of existing) {
    const marker = readPartMarker(child.description);
    if (marker && !byMarker.has(marker.id)) byMarker.set(marker.id, child);
  }
  const labels = parent.labels.filter(isAreaLabel);
  const created: string[] = [];

  const ids = partIds(plan);
  const parts: LinkedIssue[] = existing.filter(isWorkPart);
  for (const [i, part] of plan.entries()) {
    const id = ids[i] ?? part.role;
    if (byMarker.has(id)) continue;
    const child = await linear.createSubIssue(parent.id, {
      title: part.title,
      description: formatPartDescription(parent, part, id),
      state: "Ready",
      labels,
    });
    byMarker.set(id, child);
    parts.push(child);
    created.push(child.key);
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

/** The parent comment after a split that created something. */
export function formatSplitComment(
  result: SplitResult,
  source: "model" | "fallback",
  reason?: string,
): string {
  const lines = [`**Coordinator split**: ${result.parts.length + 1} sub-issues.`, ""];
  for (const part of result.parts) {
    const role = readPartMarker(part.description)?.role ?? "part";
    lines.push(`- ${part.key} ${role} (${part.size ?? "?"}): ${part.title}`);
  }
  lines.push(
    `- ${result.qa.key} qa (${result.qa.size ?? "?"}): blocked by ${result.parts.map((p) => p.key).join(", ")}`,
  );
  if (result.parts.length > 1) {
    lines.push(
      "",
      reason
        ? `Reason for more than one part: ${reason}`
        : "Reason for more than one part: not given.",
    );
  }
  if (source === "fallback") {
    lines.push("", "The plan reply was unusable, so this is the one-part fallback.");
  }
  return `${lines.join("\n")}\n`;
}
