import { useEffect, useState } from "react";
import { type Connection, type Load, type PauseState, pauseAll, resumeAll } from "./api.ts";
import { MoonIcon, PauseIcon, PlayIcon, SunIcon, SystemIcon } from "./icons.tsx";
import { clockTime, sinceText } from "./lib/format.ts";

type Theme = "system" | "light" | "dark";
const THEME_KEY = "harnessd.theme";
const NEXT: Record<Theme, Theme> = { system: "light", light: "dark", dark: "system" };

function readTheme(): Theme {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return t === "light" || t === "dark" ? t : "system";
  } catch {
    return "system";
  }
}

function ThemeButton() {
  const [theme, setTheme] = useState<Theme>(readTheme);
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") delete root.dataset.theme;
    else root.dataset.theme = theme;
    try {
      if (theme === "system") localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, theme);
    } catch {
      // The choice then lasts for this page only.
    }
  }, [theme]);
  const label = { system: "System", light: "Light", dark: "Dark" }[theme];
  return (
    <button
      type="button"
      className="btn btn-quiet"
      onClick={() => setTheme(NEXT[theme])}
      title={`Theme: ${label}. Click for ${NEXT[theme]}.`}
    >
      {theme === "light" ? <SunIcon /> : theme === "dark" ? <MoonIcon /> : <SystemIcon />}
      <span className="btn-label">{label}</span>
      <span className="sr-only">theme</span>
    </button>
  );
}

const CONNECTION_TEXT: Record<Connection, string> = {
  connecting: "Connecting",
  live: "Live",
  reconnecting: "Reconnecting",
};

interface TopBarProps {
  pause: Load<PauseState>;
  setPause: (p: Load<PauseState>) => void;
  connection: Connection;
  lastPollAt: string | null | undefined;
  needsYou: number;
  now: Date;
}

export function TopBar({ pause, setPause, connection, lastPollAt, needsYou, now }: TopBarProps) {
  const [busy, setBusy] = useState<"pausing" | "resuming" | null>(null);
  const [notice, setNotice] = useState("");
  const state = pause.status === "ready" ? pause.data : undefined;
  const paused = busy === "pausing" || (busy === null && state?.paused === true);

  const disabled = pause.status !== "ready" || busy !== null;

  async function toggle() {
    if (disabled) return;
    if (state?.paused) {
      setBusy("resuming");
      setNotice("Resuming.");
      try {
        setPause({ status: "ready", data: await resumeAll() });
        setNotice("Resumed. The loop dispatches again.");
      } catch (e) {
        setNotice(`Resume failed: ${(e as Error).message}`);
      }
    } else {
      // The band and the button change at once; the call returns when runs have exited.
      setBusy("pausing");
      setNotice("Pausing. Stopping every run.");
      try {
        const result = await pauseAll();
        const { cancelled, ...data } = result;
        setPause({ status: "ready", data });
        setNotice(
          `Paused. ${cancelled} ${cancelled === 1 ? "run" : "runs"} stopped; worktrees kept.`,
        );
      } catch (e) {
        setNotice(`Pause failed: ${(e as Error).message} Try again.`);
      }
    }
    setBusy(null);
  }

  const pauseText =
    busy === "pausing"
      ? "Pausing"
      : busy === "resuming"
        ? "Resuming"
        : paused
          ? "Resume"
          : "Pause all";
  return (
    <header className="bar" data-paused={paused || undefined}>
      <div className="bar-brand">harnessd</div>
      <div className="bar-status">
        <span className="conn" data-state={connection}>
          <span className="dot" aria-hidden="true" />
          <span className="conn-text">{CONNECTION_TEXT[connection]}</span>
        </span>
        {paused ? (
          <span className="bar-paused">
            {busy === "pausing"
              ? "Pausing all agents"
              : `Paused${state?.since ? ` since ${clockTime(state.since)}` : ""}${state?.reason ? `: ${state.reason}` : ""}. Nothing is dispatched.`}
          </span>
        ) : (
          <span className="bar-meta">
            {lastPollAt ? `Last poll ${sinceText(lastPollAt, now)}` : "No poll yet"}
          </span>
        )}
        {needsYou > 0 && (
          <span className="bar-alert">
            {needsYou}
            <span className="alert-long">
              {" "}
              {needsYou === 1 ? "issue needs" : "issues need"} you
            </span>
            <span className="alert-short"> need you</span>
          </span>
        )}
      </div>
      <p className="bar-notice" role="status" aria-live="polite">
        {notice || (pause.status === "error" ? `Pause state unknown: ${pause.error}` : "")}
      </p>
      <ThemeButton />
      <button
        type="button"
        className="btn btn-kill"
        onClick={toggle}
        aria-disabled={disabled || undefined}
        aria-label={paused ? "Resume all agents" : "Pause all agents"}
      >
        {paused ? <PlayIcon /> : <PauseIcon />}
        <span>{pauseText}</span>
      </button>
    </header>
  );
}
