import type { LogLine } from "@harnessd/shared";
import { useLayoutEffect, useRef, useState } from "react";
import type { Load } from "./api.ts";
import { ArrowDownIcon } from "./icons.tsx";
import { clockTime } from "./lib/format.ts";
import { isAtBottom } from "./lib/log.ts";

export function LogPane({ logs, retry }: { logs: Load<LogLine[]>; retry: () => void }) {
  const body = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  // While the reader is scrolled up, the view keeps its lines: no new line moves them.
  const [frozen, setFrozen] = useState<LogLine[] | null>(null);
  const lines = logs.status === "ready" ? logs.data : [];
  const shown = frozen ?? lines;
  const unseen = frozen ? lines.filter((l) => l.seq > (frozen.at(-1)?.seq ?? 0)).length : 0;

  useLayoutEffect(() => {
    const el = body.current;
    if (el && follow) el.scrollTop = el.scrollHeight;
  });

  function onScroll() {
    const el = body.current;
    if (!el) return;
    const bottom = isAtBottom(el);
    if (bottom && !follow) {
      setFrozen(null);
      setFollow(true);
    } else if (!bottom && follow) {
      setFrozen(lines);
      setFollow(false);
    }
  }

  // A pointer resting in the log also holds it, so following never scrolls text under it.
  const [resting, setResting] = useState(false);
  function hold(on: boolean) {
    setResting(on);
    if (!follow) return;
    setFrozen(on ? lines : null);
  }

  function jump() {
    setFrozen(null);
    setFollow(true);
  }

  return (
    <section
      className="region region-log"
      aria-labelledby="log-title"
      aria-busy={logs.status === "loading"}
    >
      <header className="region-head">
        <h2 id="log-title">Log</h2>
        <span className="meta">{follow ? "Following" : "Paused scrolling"}</span>
      </header>
      {logs.status === "loading" && (
        <div className="region-body" aria-hidden="true">
          {[0, 1, 2, 3, 4].map((i) => (
            <div className="skel skel-line" key={i} />
          ))}
        </div>
      )}
      {logs.status === "error" && (
        <div className="state-error" role="alert">
          <p>Could not load the log. {logs.error}</p>
          <button type="button" className="btn" onClick={retry}>
            Retry
          </button>
        </div>
      )}
      {logs.status === "ready" && shown.length === 0 && (
        <p className="state-empty">
          No log lines yet. Each loop step and agent tool call shows here.
        </p>
      )}
      {logs.status === "ready" && shown.length > 0 && (
        <div
          className="region-body log-body"
          ref={body}
          onScroll={onScroll}
          onPointerEnter={() => hold(true)}
          onPointerLeave={() => hold(false)}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: a scroll region must be reachable by keyboard
          tabIndex={0}
          role="log"
          aria-live="off"
          aria-label="Live log"
        >
          <ol className="log-lines">
            {shown.map((line) => (
              <li key={line.seq} className="log-line" data-level={line.level}>
                <time dateTime={line.at}>{clockTime(line.at)}</time>
                <span className="log-src">{line.source}</span>
                <span className="log-text">{line.text}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
      {(!follow || (resting && unseen > 0)) && (
        <button type="button" className="btn btn-small jump" onClick={jump}>
          <ArrowDownIcon />
          {unseen > 0 ? `${unseen} new ${unseen === 1 ? "line" : "lines"}` : "Latest"}
        </button>
      )}
    </section>
  );
}
