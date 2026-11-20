// The daemon's API (docs/API.md): reads on load, then live changes from /api/events.
import type { AgentsSnapshot, BoardSnapshot, LogLine, LogSnapshot } from "@harnessd/shared";
import { useCallback, useEffect, useState } from "react";
import { appendLines } from "./lib/log.ts";

import type { PauseState } from "./lib/pause.ts";

export type { PauseState };

export type Load<T> =
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "ready"; data: T };

/** "live" once the event stream is open; "reconnecting" while the browser retries it. */
export type Connection = "connecting" | "live" | "reconnecting";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { ...init, headers: { accept: "application/json", ...init?.headers } });
  } catch {
    throw new Error("The daemon is not reachable. Check that harnessd run is running.");
  }
  const body = (await res.json().catch(() => undefined)) as { message?: string } | undefined;
  if (!res.ok) throw new Error(body?.message ?? `HTTP ${res.status}`);
  return body as T;
}

const post = <T>(path: string, body: unknown) =>
  request<T>(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function useHarnessd() {
  const [board, setBoard] = useState<Load<BoardSnapshot>>({ status: "loading" });
  const [agents, setAgents] = useState<Load<AgentsSnapshot>>({ status: "loading" });
  const [logs, setLogs] = useState<Load<LogLine[]>>({ status: "loading" });
  const [pause, setPause] = useState<Load<PauseState>>({ status: "loading" });
  const [connection, setConnection] = useState<Connection>("connecting");

  const loadBoard = useCallback(() => {
    setBoard((b) => (b.status === "ready" ? b : { status: "loading" }));
    request<BoardSnapshot>("/api/board").then(
      (data) => setBoard({ status: "ready", data }),
      (e) => setBoard({ status: "error", error: message(e) }),
    );
  }, []);
  const loadAgents = useCallback(() => {
    setAgents((a) => (a.status === "ready" ? a : { status: "loading" }));
    request<AgentsSnapshot>("/api/agents").then(
      (data) => setAgents({ status: "ready", data }),
      (e) => setAgents({ status: "error", error: message(e) }),
    );
  }, []);
  const loadLogs = useCallback(() => {
    setLogs((l) => (l.status === "ready" ? l : { status: "loading" }));
    request<LogSnapshot>("/api/logs").then(
      (data) =>
        setLogs((l) => ({
          status: "ready",
          data: appendLines(l.status === "ready" ? l.data : [], data.lines),
        })),
      (e) => setLogs((l) => (l.status === "ready" ? l : { status: "error", error: message(e) })),
    );
  }, []);
  const loadPause = useCallback(() => {
    request<PauseState>("/api/pause").then(
      (data) => setPause({ status: "ready", data }),
      (e) => setPause((p) => (p.status === "ready" ? p : { status: "error", error: message(e) })),
    );
  }, []);

  useEffect(() => {
    loadBoard();
    loadAgents();
    loadLogs();
    loadPause();
    const events = new EventSource("/api/events");
    const on = <T>(name: string, apply: (data: T) => void) =>
      events.addEventListener(name, (e) => apply(JSON.parse((e as MessageEvent<string>).data)));
    on<PauseState>("pause", (data) => setPause({ status: "ready", data }));
    on<AgentsSnapshot>("agents", (data) => setAgents({ status: "ready", data }));
    on<BoardSnapshot>("board", (data) => setBoard({ status: "ready", data }));
    on<LogLine>("log", (line) =>
      setLogs((l) => ({
        status: "ready",
        data: appendLines(l.status === "ready" ? l.data : [], [line]),
      })),
    );
    events.onopen = () => {
      setConnection("live");
      // Lines sent before the stream opened, or while it was down, are fetched again.
      // Repeats are dropped by seq.
      loadLogs();
    };
    events.onerror = () => {
      setConnection("reconnecting");
    };
    return () => events.close();
  }, [loadBoard, loadAgents, loadLogs, loadPause]);

  return {
    board,
    agents,
    logs,
    pause,
    connection,
    setPause,
    reloadPause: loadPause,
    retry: { board: loadBoard, agents: loadAgents, logs: loadLogs },
  };
}

export interface PauseResult extends PauseState {
  cancelled: number;
}

export const pauseAll = () => post<PauseResult>("/api/pause", {});
export const resumeAll = () => post<PauseState>("/api/resume", {});

import type { Check } from "./lib/checks.ts";

export type { Check };

export const readStatus = () => request<{ checks: Check[] }>("/api/status");
