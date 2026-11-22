// Groups board issues into the columns the UI shows.
import type { BoardIssue, TokenSum } from "@harnessd/shared";
import { tokens } from "./format.ts";

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

/** One compact count for a card, such as "7.4M tok". */
export function tokenCount(sum: TokenSum): string {
  return `${tokens(sum.input + sum.cached + sum.output)} tok`;
}

/** The tooltip that splits the count into its three parts. */
export function tokenTooltip(sum: TokenSum): string {
  return `Input ${tokens(sum.input)} · Cached ${tokens(sum.cached)} · Output ${tokens(sum.output)}`;
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
