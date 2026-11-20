// The UI's read routes and live event stream (MET-18, D-020). See docs/API.md.
import {
  AGENT_ROLES,
  type AgentsSnapshot,
  type AgentView,
  type BoardIssue,
  type BoardSnapshot,
  type LogLine,
  type MergedConfig,
  type RunView,
} from "@harnessd/shared";
import type { PauseControl } from "../control/pause.ts";
import type { LoopSnapshot } from "../coordinator/loop.ts";
import type { LogBuffer } from "./logs.ts";
import { EventStream, type Route, type SendEvent } from "./router.ts";

/** How long a read of Linear serves the board (D-020). */
export const BOARD_TTL_MS = 15_000;

/** How often open streams check the pause flag and the agents for a change. */
export const UI_POLL_MS = 1_000;

/** Marks the issues the loop is running, and the parts whose PR waits for a human. */
export function buildBoard(issues: readonly BoardIssue[], loop: LoopSnapshot): BoardIssue[] {
  const agents = new Map(loop.runs.map((r) => [r.issueKey, r.agent]));
  const blocked = new Map(loop.blocked.map((b) => [b.issueKey, b.reason]));
  return issues.map((issue) => {
    const out: BoardIssue = { ...issue };
    const agent = agents.get(issue.key);
    if (agent !== undefined) out.agent = agent;
    const reason = blocked.get(issue.key);
    if (reason !== undefined) out.blocked = reason;
    return out;
  });
}

/** Every configured agent, coordinator first, then backend, frontend and QA, with its runs. */
export function agentsView(config: MergedConfig, loop: LoopSnapshot): AgentsSnapshot {
  const order = (role: string) => (AGENT_ROLES as readonly string[]).indexOf(role);
  const agents = Object.entries(config.agents)
    .map(
      ([name, agent]): AgentView => ({
        name,
        role: agent.role,
        harness: agent.harness,
        runs: loop.runs
          .filter((r) => r.agent === name)
          .map((r) => {
            const run: RunView = {
              issueKey: r.issueKey,
              title: r.title,
              startedAt: r.startedAt,
              budgetMs: r.budgetMs,
              tokens: r.tokens,
              stopping: r.stopping,
            };
            if (r.lastAction !== undefined) run.lastAction = r.lastAction;
            return run;
          }),
      }),
    )
    .sort((a, b) => order(a.role) - order(b.role) || a.name.localeCompare(b.name));
  return { agents, lastPollAt: loop.lastPollAt, maxConcurrent: config.limits.max_concurrent };
}

export interface BoardReader {
  read(): Promise<BoardSnapshot>;
}

export interface BoardSourceOptions {
  /** One read of Linear, e.g. `() => linear.listBoard(team)`. */
  read: () => Promise<BoardIssue[]>;
  loop: () => LoopSnapshot;
  ttlMs?: number;
  now?: () => Date;
}

/**
 * The board through a cache: Linear is read at most once per `ttlMs`, and concurrent
 * reads share one call. A failed read keeps the last good issues and reports the error.
 */
export function createBoardSource(options: BoardSourceOptions): BoardReader {
  const ttl = options.ttlMs ?? BOARD_TTL_MS;
  const now = options.now ?? (() => new Date());
  let issues: BoardIssue[] = [];
  let fetchedAt: string | null = null;
  let readAt = Number.NEGATIVE_INFINITY;
  let error: string | undefined;
  let reading: Promise<void> | undefined;

  async function refresh(): Promise<void> {
    const at = now();
    try {
      issues = await options.read();
      fetchedAt = at.toISOString();
      error = undefined;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    readAt = at.getTime();
  }

  return {
    async read() {
      if (now().getTime() - readAt >= ttl) {
        reading ??= refresh().finally(() => {
          reading = undefined;
        });
        await reading;
      }
      const snapshot: BoardSnapshot = { fetchedAt, issues: buildBoard(issues, options.loop()) };
      if (error !== undefined) snapshot.error = error;
      return snapshot;
    },
  };
}

export interface UiApiOptions {
  board: BoardReader;
  agents: () => AgentsSnapshot;
  logs: LogBuffer;
  /** Without it the stream sends no pause events. */
  pause?: PauseControl;
  /** Default UI_POLL_MS. */
  pollMs?: number;
  /** Default BOARD_TTL_MS. */
  boardPollMs?: number;
}

export interface UiApi {
  routes: Route[];
  /** Stops the polling. Open streams end when the daemon closes. */
  close(): void;
}

type Channel = "pause" | "agents" | "board";

/**
 * GET /api/board, /api/agents, /api/logs and /api/events. While a stream is open, the
 * pause flag and the agents are checked every `pollMs` and the board every
 * `boardPollMs`. Each change goes out once, to every stream. Log lines go out as they come.
 */
export function createUiApi(options: UiApiOptions): UiApi {
  const pollMs = options.pollMs ?? UI_POLL_MS;
  const boardPollMs = options.boardPollMs ?? BOARD_TTL_MS;
  const clients = new Set<SendEvent>();
  const last = new Map<Channel, string>();
  let timers: ReturnType<typeof setInterval>[] = [];

  function publish(channel: Channel, data: unknown): void {
    const json = JSON.stringify(data);
    if (last.get(channel) === json) return;
    last.set(channel, json);
    for (const send of clients) send(channel, data);
  }

  const ignore = (): void => {};
  // A poll that is still running is not started again, so an old value never wins.
  const busy = new Set<string>();
  async function once(name: string, poll: () => Promise<void>): Promise<void> {
    if (busy.has(name)) return;
    busy.add(name);
    try {
      await poll();
    } finally {
      busy.delete(name);
    }
  }
  const pollFast = () =>
    once("fast", async () => {
      if (options.pause) publish("pause", await options.pause.status());
      publish("agents", options.agents());
    });
  const pollBoard = () =>
    once("board", async () => {
      publish("board", await options.board.read());
    });

  function start(): void {
    timers = [
      setInterval(() => void pollFast().catch(ignore), pollMs),
      setInterval(() => void pollBoard().catch(ignore), boardPollMs),
    ];
    for (const t of timers) t.unref();
  }

  function stop(): void {
    for (const t of timers) clearInterval(t);
    timers = [];
    last.clear();
  }

  const events = (): EventStream =>
    new EventStream((send) => {
      let open = true;
      // Each stream hears log lines from the moment it opens. Lines that come before its
      // first state wait, so the state still goes out first and no line is lost.
      let early: LogLine[] | undefined = [];
      const offLog = options.logs.subscribe((line) => {
        if (early) early.push(line);
        else send("log", line);
      });
      void (async () => {
        // A failed read leaves that event out; the polls send it once it works.
        const [pause, board] = await Promise.allSettled([
          options.pause?.status(),
          options.board.read(),
        ]);
        if (!open) return;
        const first: Array<[Channel, unknown]> = [["agents", options.agents()]];
        if (pause.status === "fulfilled" && pause.value !== undefined) {
          first.unshift(["pause", pause.value]);
        }
        if (board.status === "fulfilled") first.push(["board", board.value]);
        for (const [channel, data] of first) {
          send(channel, data);
          // The polls only send changes: a newer value they already sent goes out now.
          const newer = last.get(channel);
          if (newer !== undefined && newer !== JSON.stringify(data))
            send(channel, JSON.parse(newer));
        }
        for (const line of early ?? []) send("log", line);
        early = undefined;
        // Joined after its first state, so a poll never overtakes it.
        if (clients.size === 0) start();
        clients.add(send);
      })().catch(ignore);
      return () => {
        open = false;
        offLog();
        clients.delete(send);
        if (clients.size === 0) stop();
      };
    });

  return {
    routes: [
      { method: "GET", path: "/api/board", handler: () => options.board.read() },
      { method: "GET", path: "/api/agents", handler: () => options.agents() },
      { method: "GET", path: "/api/logs", handler: () => ({ lines: options.logs.tail() }) },
      { method: "GET", path: "/api/events", handler: events },
    ],
    close: stop,
  };
}
