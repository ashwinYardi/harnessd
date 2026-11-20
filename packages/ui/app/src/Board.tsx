import type { BoardIssue, BoardSnapshot } from "@harnessd/shared";
import type { Load } from "./api.ts";
import { type Column, type ColumnId, groupBoard, needsYou } from "./lib/board.ts";
import { sinceText } from "./lib/format.ts";
import { useHold } from "./useHold.ts";

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
        className="issue"
        data-loud={loud || undefined}
        href={issue.url}
        target="_blank"
        rel="noreferrer"
      >
        <span className="issue-line">
          <span className="issue-key">{issue.key}</span>
          {PRIORITY[issue.priority] && (
            <span className="tag" data-tone={issue.priority === 1 ? "signal" : undefined}>
              {PRIORITY[issue.priority]}
            </span>
          )}
          {issue.size && <span className="tag">{issue.size}</span>}
          {issue.agent && (
            <span className="issue-agent">
              <span className="dot" aria-hidden="true" />
              {issue.agent}
            </span>
          )}
        </span>
        <span className="issue-title">{issue.title}</span>
        {loud && (
          <span className="issue-reason">
            {issue.blocked ? `Blocked: ${issue.blocked}` : "Needs input: answer in Linear"}
          </span>
        )}
        {!loud && issue.blockedBy.length > 0 && (
          <span className="issue-note">Waits on {issue.blockedBy.join(", ")}</span>
        )}
        {!loud && issue.parentKey && issue.blockedBy.length === 0 && (
          <span className="issue-note">Part of {issue.parentKey}</span>
        )}
        <span className="sr-only">, opens in Linear</span>
      </a>
    </li>
  );
}

function BoardColumn({ column }: { column: Column }) {
  const id = `col-${column.id}`;
  return (
    <section className="col" data-col={column.id} aria-labelledby={id}>
      <h3 className="col-head" id={id}>
        <span>{column.title}</span>
        <span className="count">{column.issues.length}</span>
      </h3>
      {column.issues.length === 0 ? (
        <p className="col-empty">{EMPTY[column.id]}</p>
      ) : (
        <ul className="col-list">
          {column.issues.map((issue) => (
            <IssueRow key={issue.id} issue={issue} />
          ))}
        </ul>
      )}
    </section>
  );
}

function Skeleton() {
  return (
    <div className="columns" aria-hidden="true">
      {[3, 2, 4, 2, 3, 2].map((n, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed placeholder layout
        <div className="col" key={i}>
          <div className="col-head">
            <span className="skel skel-text" />
          </div>
          <div className="col-list">
            {Array.from({ length: n }, (_, j) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed placeholder layout
              <div className="skel skel-row" key={j} />
            ))}
          </div>
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
      className="region region-board"
      aria-labelledby="board-title"
      aria-busy={board.status === "loading"}
    >
      <header className="region-head">
        <h2 id="board-title">Board</h2>
        {shown && (
          <span className="meta">
            {shown.fetchedAt
              ? `Linear, read ${sinceText(shown.fetchedAt, now)}`
              : "Not read from Linear yet"}
          </span>
        )}
        {shown?.error && !neverRead && (
          <span className="meta meta-warn">
            Last read failed: {shown.error}. Showing the last good read.
          </span>
        )}
        <span className="head-end">
          {pending > 0 && (
            <button type="button" className="btn btn-small" onClick={apply}>
              Show updates
            </button>
          )}
        </span>
      </header>
      {board.status === "loading" && !shown && <Skeleton />}
      {((board.status === "error" && !shown) || neverRead) && (
        <div className="state-error" role="alert">
          <p>
            Could not read the board from Linear.{" "}
            {board.status === "error" ? board.error : shown?.error}
          </p>
          <button type="button" className="btn" onClick={retry}>
            Retry
          </button>
        </div>
      )}
      {shown && !neverRead && (
        <div className="columns" {...regionProps}>
          {groupBoard(shown.issues).map((column) => (
            <BoardColumn key={column.id} column={column} />
          ))}
        </div>
      )}
    </section>
  );
}
