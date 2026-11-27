import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { AgentsSnapshot, BoardIssue, BoardSnapshot } from "@harnessd/shared";
import { mergeLayers } from "../config/merge.ts";
import type { PauseControl, PauseState } from "../control/pause.ts";
import type { LoopSnapshot } from "../coordinator/loop.ts";
import { startDaemon } from "./daemon.ts";
import { createLogBuffer } from "./logs.ts";
import { staticRoutes } from "./static.ts";
import { agentsView, buildBoard, createBoardSource, createUiApi } from "./ui.ts";

const roots: string[] = [];
after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

const issue = (key: string, state: string, extra: Partial<BoardIssue> = {}): BoardIssue => ({
  id: `id-${key}`,
  key,
  title: `Title ${key}`,
  state,
  priority: 3,
  labels: [],
  url: `https://linear.test/${key}`,
  blockedBy: [],
  updatedAt: "2026-11-20T09:00:00.000Z",
  ...extra,
});

const idle: LoopSnapshot = { lastPollAt: null, runs: [], blocked: [], limits: [], usage: {} };

const running: LoopSnapshot = {
  lastPollAt: "2026-11-20T10:00:00.000Z",
  runs: [
    {
      issueId: "id-MET-41",
      issueKey: "MET-41",
      title: "Board API",
      agent: "backend",
      role: "backend",
      startedAt: "2026-11-20T09:50:00.000Z",
      budgetMs: 1_800_000,
      tokens: 1500,
      harness: "claude-code",
      lastAction: "Edit src/app.ts",
      stopping: false,
    },
  ],
  blocked: [
    {
      issueKey: "MET-43",
      parentKey: "MET-40",
      prUrl: "https://github.test/pull/7",
      reason: "touches protected paths",
    },
  ],
  limits: [],
  usage: { "id-MET-41": { input: 100, cached: 20, output: 5 } },
};

function fakePause() {
  let state: PauseState = { paused: false };
  const control: PauseControl = {
    status: async () => state,
    async pause(reason) {
      state = { paused: true, since: "2026-11-20T10:00:00.000Z" };
      if (reason) state.reason = reason;
      return { ...state, cancelled: 1 };
    },
    async resume() {
      state = { paused: false };
      return state;
    },
  };
  return control;
}

test("buildBoard marks running and blocked issues from the loop", () => {
  const board = buildBoard(
    [issue("MET-41", "In Progress"), issue("MET-43", "In Review"), issue("MET-44", "Ready")],
    running,
  );
  assert.equal(board[0]?.agent, "backend");
  assert.deepEqual(board[0]?.tokens, { input: 100, cached: 20, output: 5 });
  assert.equal(board[1]?.blocked, "touches protected paths");
  assert.equal(board[1]?.tokens, undefined);
  assert.equal(board[2]?.agent, undefined);
  assert.equal(board[2]?.blocked, undefined);
});

test("agentsView lists every agent in role order with its runs", () => {
  const view = agentsView(mergeLayers([]), running);
  assert.deepEqual(
    view.agents.map((a) => [a.name, a.role, a.harness, a.runs.map((r) => r.issueKey)]),
    [
      ["coordinator", "coordinator", "claude-code", []],
      ["backend", "backend", "claude-code", ["MET-41"]],
      ["frontend", "frontend", "claude-code", []],
      ["qa", "qa", "claude-code", []],
      ["reviewer", "reviewer", "codex", []],
    ],
  );
  assert.deepEqual(view.agents[1]?.runs[0], {
    issueKey: "MET-41",
    title: "Board API",
    startedAt: "2026-11-20T09:50:00.000Z",
    budgetMs: 1_800_000,
    tokens: 1500,
    harness: "claude-code",
    lastAction: "Edit src/app.ts",
    stopping: false,
  });
  assert.equal(view.lastPollAt, "2026-11-20T10:00:00.000Z");
  assert.equal(view.maxConcurrent, 1);
});

test("agentsView carries the harness holds in force (MET-82)", () => {
  assert.deepEqual(agentsView(mergeLayers([]), idle).limits, []);
  const limits = [
    { harness: "claude-code" as const, until: "2026-11-20T12:00:00.000Z", backoff: false },
  ];
  assert.deepEqual(agentsView(mergeLayers([]), { ...idle, limits }).limits, limits);
});

test("a hold that starts goes out as an agents event on the open stream (MET-82)", async () => {
  let snapshot = idle;
  const { daemon, ui } = await api(() => snapshot);
  const held = {
    harness: "claude-code" as const,
    until: "2026-11-20T12:00:00.000Z",
    backoff: true,
  };
  try {
    const res = await fetch(`${daemon.url}/api/events`);
    const seen = readEvents(res, (events) =>
      events.some((e) => e.event === "agents" && (e.data as AgentsSnapshot).limits?.length === 1),
    );
    setTimeout(() => {
      snapshot = { ...idle, limits: [held] };
    }, 30);
    const agents = (await seen)
      .filter((e) => e.event === "agents")
      .map((e) => e.data as AgentsSnapshot);
    assert.deepEqual(agents[0]?.limits, [], "no hold at first");
    assert.deepEqual(agents.at(-1)?.limits, [held]);
  } finally {
    ui.close();
    await daemon.close();
  }
});

test("the board source caches Linear, and keeps the last good read on an error", async () => {
  let reads = 0;
  let fail = false;
  let now = 0;
  const board = createBoardSource({
    read: async () => {
      reads++;
      if (fail) throw new Error("Linear is down");
      return [issue("MET-41", "In Progress")];
    },
    loop: () => running,
    ttlMs: 15_000,
    now: () => new Date(Date.UTC(2026, 10, 20, 10) + now),
  });
  const first = await board.read();
  assert.equal(first.fetchedAt, "2026-11-20T10:00:00.000Z");
  assert.equal(first.issues[0]?.agent, "backend");
  await Promise.all([board.read(), board.read()]);
  assert.equal(reads, 1, "fresh reads come from the cache");

  now = 16_000;
  fail = true;
  const stale = await board.read();
  assert.equal(reads, 2);
  assert.equal(stale.error, "Linear is down");
  assert.equal(stale.fetchedAt, "2026-11-20T10:00:00.000Z", "the last good read stays");
  assert.equal(stale.issues.length, 1);
});

async function api(loop: () => LoopSnapshot = () => running) {
  const logs = createLogBuffer({ now: () => new Date("2026-11-20T10:00:00.000Z") });
  const pause = fakePause();
  const ui = createUiApi({
    board: { read: async (): Promise<BoardSnapshot> => ({ fetchedAt: null, issues: [] }) },
    agents: (): AgentsSnapshot => agentsView(mergeLayers([]), loop()),
    logs,
    pause,
    pollMs: 20,
  });
  const daemon = await startDaemon({ pause, routes: ui.routes });
  return { daemon, logs, pause, ui };
}

test("GET /api/board, /api/agents and /api/logs return the read models", async () => {
  const { daemon, logs, ui } = await api();
  try {
    logs.push("MET-41: backend started (S, 30 min)");
    assert.deepEqual(await (await fetch(`${daemon.url}/api/board`)).json(), {
      fetchedAt: null,
      issues: [],
    });
    const agents = (await (await fetch(`${daemon.url}/api/agents`)).json()) as AgentsSnapshot;
    assert.equal(agents.agents[1]?.runs[0]?.issueKey, "MET-41");
    const res = await fetch(`${daemon.url}/api/logs`);
    assert.equal(res.headers.get("content-type"), "application/json");
    assert.deepEqual(
      ((await res.json()) as { lines: { text: string }[] }).lines.map((l) => l.text),
      ["MET-41: backend started (S, 30 min)"],
    );
  } finally {
    ui.close();
    await daemon.close();
  }
});

/** Reads server-sent events until `until` holds. */
async function readEvents(
  res: Response,
  until: (events: Array<{ event: string; data: unknown }>) => boolean,
) {
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  const events: Array<{ event: string; data: unknown }> = [];
  let buffer = "";
  while (!until(events)) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let end = buffer.indexOf("\n\n");
    while (end !== -1) {
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const event = /^event: (.*)$/m.exec(frame)?.[1];
      const data = /^data: (.*)$/m.exec(frame)?.[1];
      if (event && data) events.push({ event, data: JSON.parse(data) });
      end = buffer.indexOf("\n\n");
    }
  }
  await reader.cancel();
  return events;
}

test("GET /api/events streams the state, then pause, agent and log changes", async () => {
  let snapshot = idle;
  const { daemon, logs, ui } = await api(() => snapshot);
  try {
    const res = await fetch(`${daemon.url}/api/events`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/event-stream");
    assert.equal(res.headers.get("cache-control"), "no-store");
    let pushed = false;
    const pushLog = () => {
      if (pushed) return;
      pushed = true;
      logs.push("MET-41: paused, re-queued");
    };
    const seen = readEvents(res, (events) => {
      // The stream is the only signal that the pause and the agents change were read: push
      // the log only after both, so a slow poll never lets the log arrive first (T1).
      const paused = events.some((e) => e.event === "pause" && (e.data as PauseState).paused);
      const runningSeen = events.some(
        (e) =>
          e.event === "agents" &&
          (e.data as AgentsSnapshot).agents[1]?.runs[0]?.issueKey === "MET-41",
      );
      if (paused && runningSeen) pushLog();
      return events.some((e) => e.event === "log");
    });
    // If the pause never reaches the stream, the log still ends the read and the assertion
    // below fails on the last pause value instead of hanging the suite.
    const fallback = setTimeout(pushLog, 5_000);
    setTimeout(async () => {
      await fetch(`${daemon.url}/api/pause`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }).catch(() => {});
      snapshot = running;
    }, 30);
    const events = await seen.finally(() => clearTimeout(fallback));
    const names = events.map((e) => e.event);
    assert.deepEqual(names.slice(0, 3).sort(), ["agents", "board", "pause"], "the state first");
    const pauses = events.filter((e) => e.event === "pause").map((e) => e.data);
    assert.deepEqual(pauses.at(-1), { paused: true, since: "2026-11-20T10:00:00.000Z" });
    const agents = events.filter((e) => e.event === "agents").at(-1)?.data as AgentsSnapshot;
    assert.equal(agents.agents[1]?.runs[0]?.issueKey, "MET-41");
    assert.deepEqual(events.at(-1)?.event, "log");
    assert.equal(
      (events.at(-1)?.data as { text?: string } | undefined)?.text,
      "MET-41: paused, re-queued",
    );
  } finally {
    ui.close();
    await daemon.close();
  }
});

test("a pause that resolves slowly still reaches the stream before the next log line (T1)", async () => {
  const logs = createLogBuffer({ now: () => new Date("2026-11-20T10:00:00.000Z") });
  const base = fakePause();
  const pause: PauseControl = {
    status: base.status,
    async pause(reason) {
      // A loaded machine can take this long to record the pause.
      await new Promise((resolve) => setTimeout(resolve, 80));
      return base.pause(reason);
    },
    resume: base.resume,
  };
  const ui = createUiApi({
    board: { read: async (): Promise<BoardSnapshot> => ({ fetchedAt: null, issues: [] }) },
    agents: (): AgentsSnapshot => agentsView(mergeLayers([]), idle),
    logs,
    pause,
    pollMs: 20,
  });
  const daemon = await startDaemon({ pause, routes: ui.routes });
  try {
    const res = await fetch(`${daemon.url}/api/events`);
    let pushed = false;
    const pushLog = () => {
      if (pushed) return;
      pushed = true;
      logs.push("MET-41: paused, re-queued");
    };
    const seen = readEvents(res, (events) => {
      if (events.some((e) => e.event === "pause" && (e.data as PauseState).paused)) pushLog();
      return events.some((e) => e.event === "log");
    });
    const fallback = setTimeout(pushLog, 5_000);
    setTimeout(async () => {
      await fetch(`${daemon.url}/api/pause`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }).catch(() => {});
    }, 10);
    const events = await seen.finally(() => clearTimeout(fallback));
    const pauses = events.filter((e) => e.event === "pause").map((e) => e.data);
    assert.deepEqual(pauses.at(-1), { paused: true, since: "2026-11-20T10:00:00.000Z" });
    assert.equal(
      (events.at(-1)?.data as { text?: string } | undefined)?.text,
      "MET-41: paused, re-queued",
    );
  } finally {
    ui.close();
    await daemon.close();
  }
});

test("closing the daemon ends open event streams", async () => {
  const { daemon, ui } = await api();
  const res = await fetch(`${daemon.url}/api/events`);
  assert.equal(res.status, 200);
  ui.close();
  await daemon.close();
  const rest = await res.text();
  assert.match(rest, /event: pause/);
});

test("staticRoutes serves the built UI with types, caching and a strict CSP", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harnessd-ui-"));
  roots.push(dir);
  await mkdir(join(dir, "assets"));
  await writeFile(join(dir, "index.html"), "<!doctype html><title>harnessd</title>");
  await writeFile(join(dir, "assets", "index-abc123.js"), "console.log(1)");
  await writeFile(join(dir, "assets", "index-abc123.css"), "body{}");
  const daemon = await startDaemon({ routes: await staticRoutes(dir) });
  try {
    const page = await fetch(`${daemon.url}/`);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(page.headers.get("cache-control"), "no-cache");
    assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'self'/);
    assert.match(page.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
    assert.equal(page.headers.get("x-content-type-options"), "nosniff");
    assert.equal(await page.text(), "<!doctype html><title>harnessd</title>");

    const js = await fetch(`${daemon.url}/assets/index-abc123.js`);
    assert.equal(js.headers.get("content-type"), "text/javascript; charset=utf-8");
    assert.equal(js.headers.get("cache-control"), "public, max-age=31536000, immutable");
    const css = await fetch(`${daemon.url}/assets/index-abc123.css`);
    assert.equal(css.headers.get("content-type"), "text/css; charset=utf-8");

    assert.equal((await fetch(`${daemon.url}/index.html`)).status, 200);
    assert.equal((await fetch(`${daemon.url}/assets/../index.html`)).status, 200);
    assert.equal((await fetch(`${daemon.url}/assets/missing.js`)).status, 404);
    assert.equal((await fetch(`${daemon.url}/%2e%2e/package.json`)).status, 404);
  } finally {
    await daemon.close();
  }
});

test("staticRoutes of a missing folder serves nothing", async () => {
  assert.deepEqual(await staticRoutes(join(tmpdir(), "harnessd-no-such-ui")), []);
});

test("a log line pushed while the first state is read still reaches the stream", async () => {
  const logs = createLogBuffer();
  const ui = createUiApi({
    board: {
      read: async (): Promise<BoardSnapshot> => {
        await new Promise((r) => setTimeout(r, 150));
        return { fetchedAt: null, issues: [] };
      },
    },
    agents: (): AgentsSnapshot => agentsView(mergeLayers([]), idle),
    logs,
    pollMs: 20,
  });
  const daemon = await startDaemon({ routes: ui.routes });
  try {
    const res = await fetch(`${daemon.url}/api/events`);
    setTimeout(() => logs.push("MET-41: backend started (S, 30 min)"), 30);
    const events = await readEvents(res, (e) => e.some((x) => x.event === "log"));
    assert.deepEqual(
      events.map((e) => e.event),
      ["agents", "board", "log"],
      "the state first, then the early line",
    );
  } finally {
    ui.close();
    await daemon.close();
  }
});
