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

/**
 * Read-only view of the secret store. The store itself (keychain, env) ships separately;
 * this is the boundary integrations depend on.
 */
export interface SecretSource {
  get(name: string): Promise<string | undefined>;
}

/** Secret store name of the Linear personal API key. */
export const LINEAR_API_KEY_SECRET = "linear-api-key";
