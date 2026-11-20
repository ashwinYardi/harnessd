// Groups board issues into the columns the UI shows.
import type { BoardIssue } from "@harnessd/shared";

export type ColumnId = "needs-you" | "backlog" | "ready" | "in-progress" | "in-review" | "done";

export interface Column {
  id: ColumnId;
  title: string;
  issues: BoardIssue[];
}

const STATE_COLUMNS: ReadonlyArray<[ColumnId, string]> = [
  ["backlog", "Backlog"],
  ["ready", "Ready"],
  ["in-progress", "In Progress"],
  ["in-review", "In Review"],
  ["done", "Done"],
];

/** True for issues a human must act on: Needs input, or Blocked at the merge gate. */
export function needsYou(issue: BoardIssue): boolean {
  return issue.blocked !== undefined || issue.state.toLowerCase() === "needs input";
}

/**
 * Needs you first, then Backlog to Done. A state the board does not know (a custom one,
 * such as Triage) goes to Backlog. The order within a column is the order given.
 */
export function groupBoard(issues: readonly BoardIssue[]): Column[] {
  const columns: Column[] = [
    { id: "needs-you", title: "Needs you", issues: [] },
    ...STATE_COLUMNS.map(([id, title]): Column => ({ id, title, issues: [] })),
  ];
  const byState = new Map(STATE_COLUMNS.map(([, title], i) => [title.toLowerCase(), i + 1]));
  for (const issue of issues) {
    const index = needsYou(issue) ? 0 : (byState.get(issue.state.toLowerCase()) ?? 1);
    columns[index]?.issues.push(issue);
  }
  return columns;
}
