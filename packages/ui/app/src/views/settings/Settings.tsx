// Settings (MET-28): Harnesses, Connections and Team, under one sub-nav.
// While the loop is in setup, a banner says what blocks it, or offers Start.
import { CircleAlertIcon, PlayIcon } from "lucide-react";
import { Button } from "../../components/ui/button.tsx";
import { Spinner } from "../../components/ui/spinner.tsx";
import type { Loop } from "../../hooks/useLoop.ts";
import type { Status } from "../../hooks/useStatus.ts";
import type { Check } from "../../lib/checks.ts";
import { cn } from "../../lib/cn.ts";
import { hrefFor, type SettingsPage } from "../../lib/route.ts";
import { startState, worst } from "../../lib/setup.ts";
import { Connections } from "./Connections.tsx";
import { Harnesses } from "./Harnesses.tsx";
import { Team } from "./Team.tsx";

const PAGES: ReadonlyArray<{ page: SettingsPage; title: string; about: string }> = [
  { page: "harnesses", title: "Harnesses", about: "The coding CLIs your agents run on." },
  {
    page: "connections",
    title: "Connections",
    about: "GitHub, Linear, Slack, git, the port and skills.",
  },
  { page: "team", title: "Team", about: "Each agent's role, harness and model." },
];

function StartBanner({ loop, checks }: { loop: Loop; checks: readonly Check[] | undefined }) {
  if (loop.loop?.state !== "setup") return null;
  const { ready, areas, loading } = startState(checks, loop.loop);
  return (
    <div
      className={cn(
        "mb-4 flex items-center gap-3 rounded-xl border px-4 py-3",
        ready ? "border-success/40 bg-success/8" : "border-destructive/30 bg-error-surface",
      )}
      role="status"
    >
      {!ready && (
        <CircleAlertIcon
          aria-hidden="true"
          className="size-4 shrink-0 text-destructive-foreground"
        />
      )}
      <p className="min-w-0 flex-1 text-sm">
        {loading
          ? "Running the checks."
          : ready
            ? "Every required check passes. Start the loop to pick up Ready issues."
            : `The loop waits. Fix ${areas.length === 1 ? "one thing" : `${areas.length} things`}: ${areas.join(", ")}.`}
      </p>
      <Button disabled={!ready || loop.starting} onClick={() => void loop.start()}>
        {loop.starting ? <Spinner /> : <PlayIcon aria-hidden="true" />}
        Start
      </Button>
    </div>
  );
}

export function Settings({
  page,
  status,
  loop,
}: {
  page: SettingsPage;
  status: Status;
  loop: Loop;
}) {
  const checks = status.status.status === "ready" ? status.status.data : [];
  const stateOf: Record<SettingsPage, ReturnType<typeof worst> | undefined> = {
    harnesses: checks.length ? worst(checks.filter((c) => c.id.startsWith("harness."))) : undefined,
    connections: checks.length
      ? worst(
          checks.filter(
            (c) => !c.id.startsWith("harness.") && c.id !== "node" && c.id !== "config",
          ),
        )
      : undefined,
    team: checks.find((c) => c.id === "config")?.state,
  };
  const current = PAGES.find((p) => p.page === page) ?? PAGES[0];
  return (
    <section aria-label="Settings" className="flex min-h-0 flex-1 overflow-hidden">
      <nav aria-label="Settings pages" className="hidden w-52 shrink-0 border-r p-2 md:block">
        <ul className="flex flex-col gap-0.5">
          {PAGES.map((p) => (
            <li key={p.page}>
              <a
                aria-current={p.page === page ? "page" : undefined}
                className="flex h-8 items-center gap-2 rounded-[var(--control-radius)] px-2.5 font-medium text-muted-foreground text-sm outline-none transition-colors duration-100 hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring aria-[current=page]:bg-accent aria-[current=page]:text-foreground"
                href={hrefFor({ view: "settings", page: p.page })}
              >
                {p.title}
                {stateOf[p.page] && stateOf[p.page] !== "ok" && (
                  <span
                    className={cn(
                      "ms-auto size-1.5 rounded-full",
                      stateOf[p.page] === "warn" ? "bg-warning" : "bg-destructive",
                    )}
                  >
                    <span className="sr-only">
                      {stateOf[p.page] === "warn" ? "has a warning" : "needs a fix"}
                    </span>
                  </span>
                )}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-4 py-4">
          <nav aria-label="Settings pages" className="mb-3 flex gap-1 md:hidden">
            {PAGES.map((p) => (
              <a
                aria-current={p.page === page ? "page" : undefined}
                className="rounded-md px-2.5 py-1 font-medium text-muted-foreground text-sm aria-[current=page]:bg-accent aria-[current=page]:text-foreground"
                href={hrefFor({ view: "settings", page: p.page })}
                key={p.page}
              >
                {p.title}
              </a>
            ))}
          </nav>
          <StartBanner
            checks={status.status.status === "ready" ? status.status.data : undefined}
            loop={loop}
          />
          <header className="mb-3">
            <h2 className="font-semibold text-base">{current?.title}</h2>
            <p className="text-muted-foreground text-sm">{current?.about}</p>
          </header>
          {page === "harnesses" && <Harnesses onChecksChanged={status.retry} />}
          {page === "connections" && <Connections status={status} />}
          {page === "team" && <Team />}
        </div>
      </div>
    </section>
  );
}
