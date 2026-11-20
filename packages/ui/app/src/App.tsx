// The app shell: a left sidebar of views, a header with the kill switch, and the command
// palette (Cmd+K) that runs every action.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useHarnessd } from "./api.ts";
import { CommandPalette } from "./components/ui/command.tsx";
import { SidebarInset } from "./components/ui/sidebar.tsx";
import { usePause } from "./hooks/usePause.ts";
import { useRoute } from "./hooks/useRoute.ts";
import { type Theme, useTheme } from "./hooks/useTheme.ts";
import { needsYou } from "./lib/board.ts";
import type { Command } from "./lib/commands.ts";
import type { View } from "./lib/route.ts";
import { goToView, isPaletteShortcut, isTypingTarget } from "./lib/shortcut.ts";
import { AppHeader } from "./shell/AppHeader.tsx";
import { AppSidebar } from "./shell/AppSidebar.tsx";
import { NAV } from "./shell/nav.ts";
import { Agents } from "./views/Agents.tsx";
import { Board } from "./views/Board.tsx";
import { Logs } from "./views/Logs.tsx";
import { Settings, useStatus } from "./views/Settings.tsx";

/** One clock for every elapsed time on the page, so they tick together. */
function useNow(ms = 1000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

type AppCommand = Command & { run: () => void };

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

export function App() {
  const api = useHarnessd();
  const now = useNow();
  const { route, go } = useRoute();
  const { theme, setTheme } = useTheme();
  const pause = usePause(api.pause, api.setPause);
  const status = useStatus();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const { recheck } = status;

  const waiting = api.board.status === "ready" ? api.board.data.issues.filter(needsYou).length : 0;
  const boardDown =
    api.board.status === "error" ||
    (api.board.status === "ready" && api.board.data.fetchedAt === null && !!api.board.data.error);
  const lastPollAt = api.agents.status === "ready" ? api.agents.data.lastPollAt : undefined;
  const running =
    api.agents.status === "ready"
      ? api.agents.data.agents.reduce((n, a) => n + a.runs.length, 0)
      : undefined;
  const failingChecks =
    status.status.status === "ready"
      ? status.status.data.filter((c) => c.state === "fail" || c.state === "missing").length
      : 0;

  const title = NAV.find((n) => n.view === route.view)?.title ?? "Board";
  useEffect(() => {
    document.title = `${waiting > 0 ? `(${waiting}) ` : ""}${title} · harnessd`;
  }, [waiting, title]);

  // A view change moves focus to the content, so a screen reader hears the new view.
  const firstView = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on each view change by design
  useEffect(() => {
    if (firstView.current) {
      firstView.current = false;
      return;
    }
    document.getElementById("main")?.focus({ preventScroll: true });
  }, [route.view]);

  const goTo = useCallback((view: View) => go({ view }), [go]);

  useEffect(() => {
    let prev: { key: string; at: number } | undefined;
    const onKey = (e: KeyboardEvent) => {
      if (isPaletteShortcut(e)) {
        e.preventDefault();
        setPaletteOpen((o) => !o);
        return;
      }
      if (
        isTypingTarget(e.target as HTMLElement | null) ||
        document.querySelector("[role=dialog]")
      ) {
        return;
      }
      // "G then B" within a second goes to Board; likewise A, L and S.
      const fresh = prev && Date.now() - prev.at < 1000 ? prev.key : undefined;
      const view = goToView(e, fresh);
      prev = { key: e.key.toLowerCase(), at: Date.now() };
      if (view) {
        e.preventDefault();
        goTo(view);
        prev = undefined;
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [goTo]);

  const commands = useMemo<AppCommand[]>(() => {
    const themeCmd = (t: Theme, title: string): AppCommand => ({
      id: `theme-${t}`,
      title,
      group: "Theme",
      keywords: ["appearance", "color"],
      disabled: theme === t,
      run: () => setTheme(t),
    });
    const GO_KEYS: Record<View, string> = {
      board: "G B",
      agents: "G A",
      logs: "G L",
      settings: "G S",
    };
    return [
      ...NAV.map(
        ({ view, title }): AppCommand => ({
          id: `go-${view}`,
          title: `Go to ${title}`,
          group: "Go to",
          shortcut: GO_KEYS[view],
          disabled: route.view === view,
          run: () => goTo(view),
        }),
      ),
      {
        id: "needs-you",
        title: "Show what needs you",
        group: "Go to",
        keywords: ["blocked", "needs input"],
        run: () => goTo("board"),
      },
      pause.view.shown.paused
        ? {
            id: "resume",
            title: "Resume all agents",
            group: "Loop",
            keywords: ["start", "play"],
            run: pause.toggle,
          }
        : {
            id: "pause",
            title: "Pause all agents",
            group: "Loop",
            keywords: ["stop", "kill"],
            run: pause.toggle,
          },
      {
        id: "recheck",
        title: "Run the checks again",
        group: "Settings",
        keywords: ["doctor", "status"],
        run: () => void recheck(),
      },
      {
        id: "reload-board",
        title: "Read the board again",
        group: "Board",
        keywords: ["refresh", "linear", "retry"],
        run: api.retry.board,
      },
      {
        id: "reload-agents",
        title: "Load the agents again",
        group: "Agents",
        keywords: ["refresh", "retry"],
        run: api.retry.agents,
      },
      {
        id: "reload-logs",
        title: "Load the log again",
        group: "Logs",
        keywords: ["refresh", "retry"],
        run: api.retry.logs,
      },
      themeCmd("system", "Use the system theme"),
      themeCmd("light", "Use the light theme"),
      themeCmd("dark", "Use the dark theme"),
    ];
  }, [
    pause.view.shown.paused,
    pause.toggle,
    route.view,
    goTo,
    theme,
    setTheme,
    recheck,
    api.retry,
  ]);

  return (
    <div className="flex h-full overflow-hidden">
      <a
        className="sr-only z-50 rounded-md bg-background px-3 py-2 text-sm focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:ring-2 focus:ring-ring"
        href="#main"
      >
        Skip to content
      </a>
      <AppSidebar
        failingChecks={failingChecks}
        modKey={IS_MAC ? "⌘" : "Ctrl"}
        needsYou={waiting}
        onOpenPalette={() => setPaletteOpen(true)}
        paused={pause.view.shown.paused}
        running={running}
        view={route.view}
      />
      <SidebarInset>
        <AppHeader
          boardDown={boardDown}
          connection={api.connection}
          lastPollAt={lastPollAt}
          needsYou={waiting}
          now={now}
          onShowNeedsYou={() => goTo("board")}
          onTogglePause={pause.toggle}
          pause={pause.view}
          pauseUnknown={pause.unknown}
          title={title}
        />
        <main className="flex min-h-0 flex-1 flex-col" id="main" aria-label={title} tabIndex={-1}>
          {route.view === "board" && (
            <Board
              board={api.board}
              now={now}
              paused={pause.view.shown.paused}
              retry={api.retry.board}
            />
          )}
          {route.view === "agents" && (
            <Agents agents={api.agents} now={now} retry={api.retry.agents} />
          )}
          {route.view === "logs" && <Logs logs={api.logs} retry={api.retry.logs} />}
          {route.view === "settings" && <Settings status={status} />}
        </main>
      </SidebarInset>
      <CommandPalette
        commands={commands}
        onOpenChange={setPaletteOpen}
        onRun={(c) => c.run()}
        open={paletteOpen}
        placeholder="Type a command or a view"
      />
    </div>
  );
}
