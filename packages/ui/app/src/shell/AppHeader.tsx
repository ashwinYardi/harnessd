// The header across the content: the view title, the live state and the kill switch.
// While paused, it becomes an amber band, so the state shows from across the room.
// A harness held by its usage limit shows as quiet text next to the loop state (MET-70).

import { PlayIcon } from "lucide-react";
import type { Connection } from "../api.ts";
import { ServiceLogo } from "../components/service-logo.tsx";
import { Badge } from "../components/ui/badge.tsx";
import { Button } from "../components/ui/button.tsx";
import { Spinner } from "../components/ui/spinner.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip.tsx";
import { cn } from "../lib/cn.ts";
import { clockTime, sinceText } from "../lib/format.ts";
import { type HarnessLimit, limitParts, limitText } from "../lib/limits.ts";
import type { PauseView } from "../lib/pause.ts";
import { harnessService } from "../lib/services.ts";
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
  /** Harness holds in force; one entry each. */
  limits: readonly HarnessLimit[];
  needsYou: number;
  boardDown: boolean;
  now: Date;
  onShowNeedsYou: () => void;
  /** Set while the loop has not started (D-026). */
  setup?:
    | { ready: boolean; starting: boolean; onStart: () => void; onFinish: () => void }
    | undefined;
}

export function AppHeader({
  title,
  pause,
  pauseUnknown,
  onTogglePause,
  connection,
  lastPollAt,
  limits,
  needsYou,
  boardDown,
  now,
  onShowNeedsYou,
  setup,
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
            render={
              <button
                type="button"
                className="inline-flex min-h-6 min-w-6 shrink-0 cursor-default items-center justify-center gap-1.5 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            }
            aria-label={`Connection: ${c.text}. ${c.hint}`}
          >
            <span aria-hidden="true" className={cn("size-1.5 rounded-full", c.dot)} />
            {/* While a hold shows, the dot and its tooltip carry the state below lg. */}
            <span className={cn("hidden", limits.length > 0 ? "lg:inline" : "sm:inline")}>
              {c.text}
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom">{c.hint}</TooltipContent>
        </Tooltip>
        <p className="min-w-0 truncate" role="status" aria-live="polite">
          {paused && (
            <span className="font-medium text-warning-foreground">
              {pause.busy === "pausing"
                ? "Pausing all agents."
                : `Paused${since ? ` since ${clockTime(since)}` : ""}${pause.confirmed.reason ? `: ${pause.confirmed.reason}` : ""}. Nothing is dispatched.`}
            </span>
          )}
          {!paused && pauseUnknown && (
            <span className="text-warning-foreground">Pause state unknown: {pauseUnknown}</span>
          )}
        </p>
        {/* Always in the tree, so a screen reader hears a hold start and end. Empty, it
            gives back its flex gap, so the header does not move. */}
        <p className="flex min-w-0 items-center gap-2 empty:-ml-3 lg:gap-3" role="status">
          {limits.map((h) => {
            const service = harnessService(h.harness);
            const text = limitText(h);
            const parts = limitParts(h);
            // Below lg the logo names the harness: "until 18:37" shows. The title and a
            // screen reader keep the whole text.
            const narrow = service ? "sr-only lg:not-sr-only" : undefined;
            return (
              <span
                className={cn(
                  "inline-flex min-w-0 shrink-0 items-center gap-1.5 whitespace-nowrap lg:shrink",
                  paused && "text-warning-foreground",
                )}
                key={h.harness}
                // A narrow header cuts the text; the pointer gets it whole.
                title={text}
              >
                {service && <ServiceLogo className="size-3.5" service={service} />}
                <span className="truncate">
                  <span className={narrow}>{parts.name}</span>
                  <span className="tabular-nums">{parts.until}</span>
                  {parts.backoff && <span className={narrow}>{parts.backoff}</span>}
                </span>
              </span>
            );
          })}
        </p>
        {/* Outside the live region: it changes every second. A hold needs the room more. */}
        {!paused && !pauseUnknown && (
          <span className={cn("hidden truncate", limits.length > 0 ? "xl:inline" : "md:inline")}>
            {lastPollAt ? `Last poll ${sinceText(lastPollAt, now)}` : "No poll yet"}
          </span>
        )}
      </div>
      {boardDown && (
        <Badge variant="warning" size="lg">
          Board not read
        </Badge>
      )}
      {needsYou > 0 && (
        <Button
          aria-label={`${needsYou} ${needsYou === 1 ? "issue needs" : "issues need"} you`}
          className="whitespace-nowrap"
          onClick={onShowNeedsYou}
          size="sm"
          variant="destructive"
        >
          <span className="tabular-nums">{needsYou}</span>
          <span className="hidden sm:inline">{needsYou === 1 ? "needs you" : "need you"}</span>
        </Button>
      )}
      {setup && (
        <>
          <Badge className="hidden sm:inline-flex" variant="warning" size="lg">
            Not started
          </Badge>
          {setup.ready ? (
            <Button disabled={setup.starting} onClick={setup.onStart}>
              {setup.starting ? <Spinner /> : <PlayIcon aria-hidden="true" />}
              Start
            </Button>
          ) : (
            <Button className="hidden sm:inline-flex" onClick={setup.onFinish} variant="outline">
              Finish setup
            </Button>
          )}
        </>
      )}
      <PauseButton view={pause} onToggle={onTogglePause} />
    </header>
  );
}
