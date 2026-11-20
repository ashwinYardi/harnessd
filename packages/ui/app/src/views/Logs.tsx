// The live log (MET-18). It follows the end until the reader scrolls up or rests the pointer
// in it; then it holds still and offers a button with the count of new lines.
import type { LogLine } from "@harnessd/shared";
import { ArrowDownIcon } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import type { Load } from "../api.ts";
import { Badge } from "../components/ui/badge.tsx";
import { Button } from "../components/ui/button.tsx";
import { Card } from "../components/ui/card.tsx";
import { Skeleton } from "../components/ui/skeleton.tsx";
import { cn } from "../lib/cn.ts";
import { clockTime } from "../lib/format.ts";
import { isAtBottom } from "../lib/log.ts";
import { EmptyState, ErrorState, ViewToolbar } from "./common.tsx";

export function Logs({ logs, retry }: { logs: Load<LogLine[]>; retry: () => void }) {
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
      aria-busy={logs.status === "loading"}
      aria-label="Log"
      className="flex min-h-0 flex-1 flex-col"
    >
      <ViewToolbar>
        <Badge variant={follow ? "success" : "secondary"}>
          {follow ? "Following" : "Scrolled up"}
        </Badge>
        <span>{lines.length} lines</span>
      </ViewToolbar>
      {logs.status === "loading" && (
        <div className="flex flex-col gap-2 px-4" aria-hidden="true">
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton className="h-4" key={i} />
          ))}
        </div>
      )}
      {logs.status === "error" && (
        <ErrorState onRetry={retry} text={`Could not load the log. ${logs.error}`} />
      )}
      {logs.status === "ready" && shown.length === 0 && (
        <EmptyState>No log lines yet. Each loop step and agent tool call shows here.</EmptyState>
      )}
      {logs.status === "ready" && shown.length > 0 && (
        <div className="relative flex min-h-0 flex-1 flex-col px-4 pb-4">
          <Card className="min-h-0 flex-1 overflow-hidden">
            <div
              aria-label="Live log"
              aria-live="off"
              className="h-full overflow-y-auto py-2 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              onPointerEnter={() => hold(true)}
              onPointerLeave={() => hold(false)}
              onScroll={onScroll}
              ref={body}
              role="log"
              // biome-ignore lint/a11y/noNoninteractiveTabindex: a scroll region must be reachable by keyboard
              tabIndex={0}
            >
              <ol className="font-mono text-xs leading-[18px]">
                {shown.map((line) => (
                  <li
                    className={cn(
                      "grid grid-cols-[4.5rem_6rem_1fr] gap-3 px-4 hover:bg-accent/50",
                      line.level === "warn" && "bg-warning-surface text-warning-foreground",
                    )}
                    key={line.seq}
                  >
                    <time className="text-muted-foreground" dateTime={line.at}>
                      {clockTime(line.at)}
                    </time>
                    <span className="truncate text-muted-foreground">{line.source}</span>
                    <span className="wrap-anywhere">{line.text}</span>
                  </li>
                ))}
              </ol>
            </div>
          </Card>
          {(!follow || (resting && unseen > 0)) && (
            <Button
              className="absolute right-8 bottom-8 shadow-md/10"
              onClick={jump}
              size="sm"
              variant="outline"
            >
              <ArrowDownIcon aria-hidden="true" />
              {unseen > 0 ? `${unseen} new ${unseen === 1 ? "line" : "lines"}` : "Latest"}
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
