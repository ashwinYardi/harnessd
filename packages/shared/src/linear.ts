/** Workflow states harnessd reads and writes (SPEC "Linear filing rules"). */
export const WORKFLOW_STATES = [
  "Backlog",
  "Ready",
  "In Progress",
  "In Review",
  "Done",
  "Needs input",
] as const;

export type WorkflowStateName = (typeof WORKFLOW_STATES)[number];

export function isWorkflowStateName(value: string): value is WorkflowStateName {
  return (WORKFLOW_STATES as readonly string[]).includes(value);
}

/** Linear priority: 1 urgent, 2 high, 3 medium, 4 low, 0 none. */
export type Priority = 0 | 1 | 2 | 3 | 4;

/** Task size from the issue body. L must be split before work starts (D-014). */
export type Size = "S" | "M" | "L";

export interface DoneWhenItem {
  text: string;
  checked: boolean;
}

/** A Linear issue as the coordinator sees it. */
export interface Issue {
  /** Linear UUID. */
  id: string;
  /** Human key, e.g. "MET-12". */
  key: string;
  title: string;
  /** Markdown body; empty string when the issue has none. */
  description: string;
  priority: Priority;
  /** Linear's manual list position; a lower value sits higher in the list. */
  sortOrder?: number;
  /** Workflow state name as named in Linear; usually a WorkflowStateName. */
  state: string;
  labels: string[];
  /** Parsed from the "**Size**: S" line in the body. */
  size: Size | undefined;
  /** Parsed from the "Done when" checklist in the body. */
  doneWhen: DoneWhenItem[];
  url: string;
  /** Keys of blocking issues that are not completed or canceled. */
  blockedBy: string[];
  milestone?: string;
}

/** An issue that blocks another, with its workflow state name ("In Review"). */
export interface BlockerRef {
  id: string;
  key: string;
  state: string;
}

/** An issue with its parent and every blocker, finished or not. */
export interface LinkedIssue extends Issue {
  /** Linear UUID of the parent issue, when this is a sub-issue. */
  parentId?: string;
  parentKey?: string;
  /** Every issue with a "blocks" relation to this one. */
  blockers: BlockerRef[];
}

/** Area labels; an issue carries exactly one (SPEC "Linear filing rules"). */
export const AREA_LABELS = [
  "harness-adapter",
  "ui",
  "cloud",
  "memory",
  "coordinator",
  "infra",
] as const;

export type AreaLabel = (typeof AREA_LABELS)[number];

export function isAreaLabel(value: string): value is AreaLabel {
  return (AREA_LABELS as readonly string[]).includes(value);
}

/** Read-only view of a secret store, by name. The daemon's store is in secrets/store.ts. */
export interface SecretReader {
  get(name: string): Promise<string | undefined>;
}

/** Secret store name of the Linear personal API key. */
export const LINEAR_API_KEY_SECRET = "linear-api-key";
