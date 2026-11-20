// The board (MET-18 behaviour, rebuilt on the primitives): Needs you first and loudest, then
// each state in flow order. Live changes wait while the pointer or focus is inside.
import type { BoardIssue, BoardSnapshot } from "@harnessd/shared";
import { CircleAlertIcon, ExternalLinkIcon } from "lucide-react";
import type { Load } from "../api.ts";
import { Badge } from "../components/ui/badge.tsx";
import { ScrollArea } from "../components/ui/scroll-area.tsx";
import { Skeleton } from "../components/ui/skeleton.tsx";
import { useHold } from "../hooks/useHold.ts";
import { type Column, type ColumnId, groupBoard, needsYou } from "../lib/board.ts";
import { cn } from "../lib/cn.ts";
import { sinceText } from "../lib/format.ts";
import { EmptyState, ErrorState, HeldUpdates, ViewToolbar } from "./common.tsx";

const EMPTY: Record<ColumnId, string> = {
  "needs-you": "Nothing needs you.",
  backlog: "No issues in Backlog.",
  ready: "No Ready issues. Move one to Ready in Linear to start work.",
  "in-progress": "Nothing in progress.",
  "in-review": "No PRs waiting for QA or the merge gate.",
  done: "Nothing done in the last 7 days.",
};

const PRIORITY: Record<number, string> = { 1: "Urgent", 2: "High" };

function IssueRow({ issue }: { issue: BoardIssue }) {
  const loud = needsYou(issue);
  return (
    <li>
      <a
        className={cn(
          "group flex flex-col gap-1 rounded-lg border bg-card px-2.5 py-2 text-sm shadow-xs/5 outline-none transition-colors duration-100 not-dark:bg-clip-padding hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring dark:hover:bg-accent",
          loud && "border-destructive/40",
        )}
        href={issue.url}
        rel="noreferrer"
        target="_blank"
      >
        <span className="flex items-center gap-1.5 text-muted-foreground text-xs">
          <span className="shrink-0 whitespace-nowrap font-mono">{issue.key}</span>
          {PRIORITY[issue.priority] && (
            <Badge size="sm" variant={issue.priority === 1 ? "warning" : "secondary"}>
              {PRIORITY[issue.priority]}
            </Badge>
          )}
          {issue.size && (
            <Badge size="sm" variant="secondary">
              {issue.size}
            </Badge>
          )}
          <ExternalLinkIcon
            aria-hidden="true"
            className="ms-auto size-3 opacity-0 transition-opacity group-hover:opacity-100"
          />
        </span>
        <span className="line-clamp-2 text-foreground leading-snug">{issue.title}</span>
        {issue.agent && (
          <span className="flex min-w-0 items-center gap-1.5 text-xs">
            <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-success" />
            <span className="truncate">
              <span className="sr-only">Run by </span>
              {issue.agent}
            </span>
          </span>
        )}
        {loud && (
          <span className="flex items-start gap-1 font-medium text-destructive-foreground text-xs">
            <CircleAlertIcon aria-hidden="true" className="mt-px size-3 shrink-0" />
            {issue.blocked ? `Blocked: ${issue.blocked}` : "Needs input: answer in Linear"}
          </span>
        )}
        {!loud && issue.blockedBy.length > 0 && (
          <span className="text-muted-foreground text-xs">
            Waits on {issue.blockedBy.join(", ")}
          </span>
        )}
        {!loud && issue.parentKey && issue.blockedBy.length === 0 && (
          <span className="text-muted-foreground text-xs">Part of {issue.parentKey}</span>
        )}
        <span className="sr-only">, opens in Linear</span>
      </a>
    </li>
  );
}

function BoardColumn({ column }: { column: Column }) {
  const id = `col-${column.id}`;
  const loud = column.id === "needs-you";
  const hasIssues = column.issues.length > 0;
  return (
    <section
      aria-labelledby={id}
      className={cn(
        "flex min-w-44 flex-1 basis-0 flex-col rounded-xl border bg-muted/50 dark:bg-card",
        loud && hasIssues && "border-destructive/40 bg-error-surface dark:bg-error-surface",
      )}
      data-col={column.id}
    >
      <h2
        className={cn(
          "flex h-9 shrink-0 items-center gap-2 px-3 font-semibold text-sm",
          loud && hasIssues && "text-destructive-foreground",
        )}
        id={id}
      >
        {loud && hasIssues && <CircleAlertIcon aria-hidden="true" className="size-4" />}
        <span>{column.title}</span>
        <Badge size="sm" variant={loud && hasIssues ? "destructive" : "secondary"}>
          {column.issues.length}
        </Badge>
      </h2>
      {hasIssues ? (
        <ul className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-2 pb-2">
          {column.issues.map((issue) => (
            <IssueRow issue={issue} key={issue.id} />
          ))}
        </ul>
      ) : (
        <p className="px-3 pb-3 text-muted-foreground text-xs">{EMPTY[column.id]}</p>
      )}
    </section>
  );
}

const SKELETON = [
  { id: "needs-you", rows: ["a", "b", "c"] },
  { id: "backlog", rows: ["a", "b"] },
  { id: "ready", rows: ["a", "b", "c", "d"] },
  { id: "in-progress", rows: ["a", "b"] },
  { id: "in-review", rows: ["a", "b", "c"] },
  { id: "done", rows: ["a", "b"] },
];

function BoardSkeleton() {
  return (
    <div className="flex gap-3 p-4 pt-0" aria-hidden="true">
      {SKELETON.map((col) => (
        <div
          className="flex min-w-44 flex-1 basis-0 flex-col gap-1.5 rounded-xl border bg-muted/50 p-2"
          key={col.id}
        >
          <Skeleton className="m-1 h-4 w-24" />
          {col.rows.map((row) => (
            <Skeleton className="h-16" shape="card" key={row} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function Board({
  board,
  retry,
  now,
}: {
  board: Load<BoardSnapshot>;
  retry: () => void;
  now: Date;
}) {
  const snapshot = board.status === "ready" ? board.data : undefined;
  const { shown, pending, apply, regionProps } = useHold(snapshot);
  // No good read of Linear yet: an empty board would claim nothing needs you.
  const neverRead = shown?.fetchedAt === null && shown.error !== undefined;

  return (
    <section
      aria-busy={board.status === "loading"}
      aria-label="Board"
      className="flex min-h-0 flex-1 flex-col"
      {...regionProps}
    >
      <ViewToolbar>
        {shown && (
          <span>
            {shown.fetchedAt
              ? `Linear, read ${sinceText(shown.fetchedAt, now)}`
              : "Not read from Linear yet"}
          </span>
        )}
        {shown?.error && !neverRead && (
          <span className="text-warning-foreground">
            Last read failed: {shown.error}. Showing the last good read.
          </span>
        )}
        <HeldUpdates pending={pending} onApply={apply} />
      </ViewToolbar>
      {board.status === "loading" && !shown && <BoardSkeleton />}
      {((board.status === "error" && !shown) || neverRead) && (
        <ErrorState
          onRetry={retry}
          text={`Could not read the board from Linear. ${board.status === "error" ? board.error : (shown?.error ?? "")}`}
        />
      )}
      {shown && !neverRead && shown.issues.length === 0 && (
        <EmptyState>
          No issues in this team and project. Ready issues in Linear show here.
        </EmptyState>
      )}
      {shown && !neverRead && shown.issues.length > 0 && (
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex h-full gap-3 px-4 pb-4">
            {groupBoard(shown.issues).map((column) => (
              <BoardColumn column={column} key={column.id} />
            ))}
          </div>
        </ScrollArea>
      )}
    </section>
  );
}
