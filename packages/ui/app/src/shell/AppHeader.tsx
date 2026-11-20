// The header across the content: the view title, the live state and the kill switch.
// While paused, it becomes an amber band, so the state shows from across the room.

import type { Connection } from "../api.ts";
import { Badge } from "../components/ui/badge.tsx";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip.tsx";
import { cn } from "../lib/cn.ts";
import { clockTime, sinceText } from "../lib/format.ts";
import type { PauseView } from "../lib/pause.ts";
import { PauseButton } from "./PauseButton.tsx";

const CONNECTION: Record<Connection, { text: string; dot: string; hint: string }> = {
  connecting: { text: "Connecting", dot: "bg-warning", hint: "Opening the event stream." },
  live: { text: "Live", dot: "bg-success", hint: "Changes arrive as they happen." },
  reconnecting: {
    text: "Reconnecting",
    dot: "bg-warning",
    hint: "The event stream dropped. The browser retries it.",
  },
};

interface AppHeaderProps {
  title: string;
  pause: PauseView;
  pauseUnknown: string | undefined;
  onTogglePause: () => void;
  connection: Connection;
  lastPollAt: string | null | undefined;
  needsYou: number;
  boardDown: boolean;
  now: Date;
  onShowNeedsYou: () => void;
}

export function AppHeader({
  title,
  pause,
  pauseUnknown,
  onTogglePause,
  connection,
  lastPollAt,
  needsYou,
  boardDown,
  now,
  onShowNeedsYou,
}: AppHeaderProps) {
  const paused = pause.shown.paused;
  const c = CONNECTION[connection];
  const since = pause.confirmed.paused ? pause.confirmed.since : undefined;
  return (
    <header
      className={cn(
        "flex h-13 shrink-0 items-center gap-3 border-b px-4 transition-colors duration-150",
        paused && "border-warning/50 bg-warning/16 dark:bg-warning/20",
      )}
      data-paused={paused || undefined}
    >
      <h1 className="font-semibold text-sm">{title}</h1>
      <div className="flex min-w-0 flex-1 items-center gap-3 text-muted-foreground text-xs">
        <Tooltip>
          <TooltipTrigger
            render={<span className="inline-flex items-center gap-1.5" />}
            aria-label={`Connection: ${c.text}`}
          >
            <span aria-hidden="true" className={cn("size-1.5 rounded-full", c.dot)} />
            <span className="hidden sm:inline">{c.text}</span>
          </TooltipTrigger>
          <TooltipPopup side="bottom">{c.hint}</TooltipPopup>
        </Tooltip>
        <p className="min-w-0 truncate" role="status" aria-live="polite">
          {paused ? (
            <span className="font-medium text-warning-foreground">
              {pause.busy === "pausing"
                ? "Pausing all agents."
                : `Paused${since ? ` since ${clockTime(since)}` : ""}${pause.confirmed.reason ? `: ${pause.confirmed.reason}` : ""}. Nothing is dispatched.`}
            </span>
          ) : pauseUnknown ? (
            <span className="text-warning-foreground">Pause state unknown: {pauseUnknown}</span>
          ) : (
            <span className="hidden md:inline">
              {lastPollAt ? `Last poll ${sinceText(lastPollAt, now)}` : "No poll yet"}
            </span>
          )}
        </p>
      </div>
      {boardDown && (
        <Badge variant="warning" size="lg">
          Board not read
        </Badge>
      )}
      {needsYou > 0 && (
        <button
          type="button"
          onClick={onShowNeedsYou}
          className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md bg-destructive px-2.5 font-medium text-sm text-white outline-none transition-colors duration-100 hover:bg-destructive/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          <span className="tabular-nums">{needsYou}</span>
          <span className="hidden sm:inline">{needsYou === 1 ? "needs you" : "need you"}</span>
        </button>
      )}
      <PauseButton view={pause} onToggle={onTogglePause} />
    </header>
  );
}
