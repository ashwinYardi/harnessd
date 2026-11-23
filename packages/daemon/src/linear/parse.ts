import type {
  BlockerRef,
  DoneWhenItem,
  Issue,
  LinkedIssue,
  Priority,
  Size,
} from "@harnessd/shared";

/** Shape of an issue node as selected by ISSUE_FIELDS in client.ts. */
export interface RawIssue {
  id: string;
  identifier: string;
  title: string;
  description?: string | null;
  priority?: number | null;
  /** Linear's manual list position. */
  sortOrder?: number | null;
  url: string;
  createdAt: string;
  /** Selected by the board query only. */
  updatedAt?: string;
  state?: { name: string } | null;
  team?: { id: string; key: string } | null;
  labels?: { nodes: { name: string }[] } | null;
  projectMilestone?: { name: string } | null;
  parent?: { id: string; identifier: string } | null;
  inverseRelations?: {
    nodes: {
      type: string;
      issue?: {
        id?: string;
        identifier: string;
        state?: { type: string; name?: string } | null;
      } | null;
    }[];
  } | null;
}

const FINISHED_STATE_TYPES = new Set(["completed", "canceled"]);

/** Matches "**Size**: S", "**Size:** M", "- Size: L (split)". */
const SIZE_LINE = /^[\s>*-]*\*{0,2}size\*{0,2}\s*:\s*\*{0,2}\s*([SML])\b/im;
const DONE_WHEN_HEADER = /^\s*(?:#{1,6}\s*)?\*{0,2}done when\*{0,2}\s*:?\s*\*{0,2}\s*$/i;
const CHECKLIST_ITEM = /^\s*[-*+]\s+\[([ xX])\]\s+(.*\S)\s*$/;
/** A new section: a markdown heading or a line that starts with bold text. */
const SECTION_START = /^\s*(?:#{1,6}\s|\*\*[^*]+\*\*)/;

export function parseSize(body: string): Size | undefined {
  return SIZE_LINE.exec(body)?.[1]?.toUpperCase() as Size | undefined;
}

/** Checklist items under the "Done when" header, up to the next section. */
export function parseDoneWhen(body: string): DoneWhenItem[] {
  const items: DoneWhenItem[] = [];
  let inSection = false;
  for (const line of body.split(/\r?\n/)) {
    if (!inSection) {
      inSection = DONE_WHEN_HEADER.test(line);
      continue;
    }
    const item = CHECKLIST_ITEM.exec(line);
    if (item) {
      items.push({ text: item[2] ?? "", checked: item[1] !== " " });
      continue;
    }
    if (SECTION_START.test(line)) break;
  }
  return items;
}

export function parsePriority(value: number | null | undefined): Priority {
  return value === 1 || value === 2 || value === 3 || value === 4 ? value : 0;
}

/** Keys of issues that block this one and are not completed or canceled. */
export function unfinishedBlockers(raw: RawIssue): string[] {
  const blockers: string[] = [];
  for (const relation of raw.inverseRelations?.nodes ?? []) {
    if (relation.type !== "blocks" || !relation.issue) continue;
    const stateType = relation.issue.state?.type ?? "";
    if (!FINISHED_STATE_TYPES.has(stateType)) blockers.push(relation.issue.identifier);
  }
  return blockers;
}

export function parseIssue(raw: RawIssue): Issue {
  const description = raw.description ?? "";
  const issue: Issue = {
    id: raw.id,
    key: raw.identifier,
    title: raw.title,
    description,
    priority: parsePriority(raw.priority),
    state: raw.state?.name ?? "",
    labels: (raw.labels?.nodes ?? []).map((label) => label.name),
    size: parseSize(description),
    doneWhen: parseDoneWhen(description),
    url: raw.url,
    blockedBy: unfinishedBlockers(raw),
  };
  if (raw.sortOrder !== undefined && raw.sortOrder !== null) issue.sortOrder = raw.sortOrder;
  if (raw.projectMilestone?.name) issue.milestone = raw.projectMilestone.name;
  return issue;
}

/** Every issue that blocks this one, finished or not, with its state name. */
export function blockerRefs(raw: RawIssue): BlockerRef[] {
  const refs: BlockerRef[] = [];
  for (const relation of raw.inverseRelations?.nodes ?? []) {
    if (relation.type !== "blocks" || !relation.issue) continue;
    refs.push({
      id: relation.issue.id ?? "",
      key: relation.issue.identifier,
      state: relation.issue.state?.name ?? "",
    });
  }
  return refs;
}

/** parseIssue plus the parent and every blocker. */
export function parseLinkedIssue(raw: RawIssue): LinkedIssue {
  const issue: LinkedIssue = { ...parseIssue(raw), blockers: blockerRefs(raw) };
  if (raw.parent?.id) {
    issue.parentId = raw.parent.id;
    issue.parentKey = raw.parent.identifier;
  }
  return issue;
}

/** Urgent first, no priority (0) last; ties broken by oldest createdAt. */
export function compareByPriority(
  a: { priority: Priority; createdAt: string },
  b: { priority: Priority; createdAt: string },
): number {
  const rank = (p: Priority) => (p === 0 ? 5 : p);
  return rank(a.priority) - rank(b.priority) || Date.parse(a.createdAt) - Date.parse(b.createdAt);
}

/** The fields the Ready queue orders by. */
export interface QueueOrderFields {
  sortOrder?: number;
  priority: Priority;
  createdAt: string;
  key: string;
}

/** The key's number: "MET-12" gives 12. */
export const keyNumber = (key: string): number => Number(key.slice(key.lastIndexOf("-") + 1)) || 0;

/**
 * The Ready queue (D-006): Linear's manual order, then urgent first, no priority last,
 * then oldest createdAt, then key number. An issue with no sortOrder sorts after the rest.
 */
export function compareQueueOrder(a: QueueOrderFields, b: QueueOrderFields): number {
  const order = (item: QueueOrderFields) => item.sortOrder ?? Number.POSITIVE_INFINITY;
  const rank = (p: Priority) => (p === 0 ? 5 : p);
  return (
    order(a) - order(b) ||
    rank(a.priority) - rank(b.priority) ||
    Date.parse(a.createdAt) - Date.parse(b.createdAt) ||
    keyNumber(a.key) - keyNumber(b.key)
  );
}
