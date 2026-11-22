import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  createFileLoopStore,
  emptyLoopState,
  type LoopState,
  loopStatePath,
  parseLoopState,
} from "./state.ts";

const roots: string[] = [];
after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function repo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "harnessd-state-"));
  roots.push(dir);
  return dir;
}

const state: LoopState = {
  version: 1,
  lastPollAt: "2026-11-19T10:00:00.000Z",
  inFlight: [
    {
      issueId: "id-1",
      issueKey: "MET-41",
      role: "backend",
      agent: "backend",
      worktree: "/wt/met-41",
      branch: "met-41-api",
      startedAt: "2026-11-19T10:00:00.000Z",
      pid: 7,
    },
  ],
  interrupted: [
    {
      issueId: "id-2",
      issueKey: "MET-42",
      role: "frontend",
      agent: "frontend",
      worktree: "/wt/met-42",
      branch: "met-42-ui",
      interruptedAt: "2026-11-19T10:01:00.000Z",
      reason: "paused",
    },
  ],
  attempts: { "id-1": 1 },
  qaFailures: { "parent-1": 1 },
  qaFeedback: { "id-1": { prUrl: "https://github.test/pull/7", failing: ["Works: no test"] } },
  merges: [
    {
      qaId: "qa-1",
      qaKey: "MET-43",
      parentId: "parent-1",
      parentKey: "MET-40",
      parentUrl: "https://linear.test/MET-40",
      approvedAt: "2026-11-19T10:02:00.000Z",
      prs: [
        {
          partId: "id-1",
          partKey: "MET-41",
          number: 7,
          url: "https://github.test/pull/7",
          sha: "abc123",
          needsHuman: "protected paths",
          labeled: true,
        },
      ],
    },
  ],
  gateFailures: { "parent-1": 1 },
  humanPings: { "https://github.test/pull/7": "2026-11-19T10:03:00.000Z" },
  selfUpdateNotices: { def456: "2026-11-19T10:04:00.000Z" },
  selfUpdate: {
    from: "abc1234",
    to: "def456",
    at: "2026-11-19T10:04:00.000Z",
    state: "failed",
    error: "build: tsc exited 2",
    trigger: { id: "parent-1", key: "MET-40", url: "https://linear.test/MET-40" },
  },
  limits: {
    "claude-code": {
      until: "2026-11-19T12:00:00.000Z",
      since: "2026-11-19T10:04:00.000Z",
      backoffMs: 900_000,
    },
  },
  splits: {
    "parent-1": {
      key: "MET-40",
      parts: ["id-1"],
      qa: "qa-1",
      at: "2026-11-19T10:02:00.000Z",
    },
  },
};

test("a missing file loads as the empty state", async () => {
  assert.deepEqual(await createFileLoopStore(await repo()).load(), emptyLoopState());
});

test("save writes loop.json atomically with a .gitignore, and load reads it back", async () => {
  const dir = await repo();
  const store = createFileLoopStore(dir);
  await store.save(state);
  await store.save({ ...state, lastPollAt: "2026-11-19T10:00:30.000Z" });
  assert.equal(loopStatePath(dir), join(dir, ".harnessd", "state", "loop.json"));
  const loaded = await store.load();
  assert.equal(loaded.lastPollAt, "2026-11-19T10:00:30.000Z");
  assert.deepEqual(loaded.inFlight, state.inFlight);
  assert.deepEqual(loaded.qaFailures, state.qaFailures);
  assert.deepEqual(loaded.qaFeedback, state.qaFeedback);
  assert.deepEqual(loaded.interrupted, state.interrupted);
  assert.deepEqual(loaded.merges, state.merges);
  assert.deepEqual(loaded.gateFailures, state.gateFailures);
  assert.deepEqual(loaded.humanPings, state.humanPings);
  assert.deepEqual(loaded.selfUpdateNotices, state.selfUpdateNotices);
  assert.deepEqual(loaded.selfUpdate, state.selfUpdate);
  assert.deepEqual(loaded.limits, state.limits, "a harness hold survives a reload");
  assert.deepEqual(loaded.splits, state.splits, "a split record survives a reload");
  const files = (await readdir(join(dir, ".harnessd", "state"))).sort();
  assert.deepEqual(files, [".gitignore", "loop.json"], "no tmp files left behind");
  assert.equal(await readFile(join(dir, ".harnessd", "state", ".gitignore"), "utf8"), "*\n");
});

test("a corrupt file is moved aside and the loop starts empty", async () => {
  const dir = await repo();
  const store = createFileLoopStore(dir);
  await store.save(state);
  await writeFile(loopStatePath(dir), "{not json");
  assert.deepEqual(await store.load(), emptyLoopState());
  const files = await readdir(join(dir, ".harnessd", "state"));
  assert.ok(files.some((f) => f.startsWith("loop.json.corrupt-")));
  assert.equal(files.includes("loop.json"), false);
});

test("parseLoopState keeps only well-formed runs and attempts", () => {
  const parsed = parseLoopState(
    JSON.stringify({
      lastPollAt: 5,
      inFlight: [state.inFlight[0], { issueId: "x" }, { ...state.inFlight[0], pausedAt: 3 }],
      interrupted: [state.interrupted[0], { ...state.interrupted[0], reason: "crash" }],
      attempts: { a: 1, b: 0, c: "2", d: 1.5 },
      qaFailures: { p: 1, q: -1 },
      qaFeedback: { a: { failing: ["x", 3], reviewUrl: "u" }, b: { failing: "x" }, c: null },
      merges: [
        state.merges[0],
        { ...state.merges[0], prs: [{ number: 7 }] },
        { ...state.merges[0], prs: [{ ...state.merges[0]?.prs[0], sha: "" }] },
        { qaId: "x" },
      ],
      gateFailures: { p: 2, q: 0 },
      humanPings: { u: "t", v: 1 },
      limits: {
        "claude-code": state.limits["claude-code"],
        codex: { until: "2026-11-19T12:00:00.000Z", since: 3 },
        nope: { until: "x", since: "y" },
        cursor: { until: "a", since: "b", backoffMs: "1", endedAt: "c" },
      },
    }),
  );
  assert.deepEqual(parsed, {
    version: 1,
    lastPollAt: null,
    inFlight: state.inFlight,
    interrupted: state.interrupted,
    attempts: { a: 1 },
    qaFailures: { p: 1 },
    qaFeedback: { a: { failing: ["x"], reviewUrl: "u" } },
    merges: state.merges,
    gateFailures: { p: 2 },
    humanPings: { u: "t" },
    selfUpdateNotices: {},
    limits: {
      "claude-code": state.limits["claude-code"],
      cursor: { until: "a", since: "b", endedAt: "c" },
    },
  });
  assert.deepEqual(
    parseLoopState('{"inFlight":[]}'),
    emptyLoopState(),
    "a file from before QA still loads",
  );
  assert.deepEqual(parseLoopState('{"inFlight":[]}').interrupted, [], "MET-12 files still load");
  assert.throws(() => parseLoopState("[]"), /no inFlight array/);
});

test("an interrupted run from before the keep reasons loads as paused", () => {
  const old = {
    issueId: "id-2",
    issueKey: "MET-42",
    role: "frontend",
    agent: "frontend",
    worktree: "/wt/met-42",
    branch: "met-42-ui",
    interruptedAt: "2026-11-19T10:01:00.000Z",
  };
  const parsed = parseLoopState(JSON.stringify({ inFlight: [], interrupted: [old] }));
  assert.deepEqual(parsed.interrupted, [{ ...old, reason: "paused" }]);
  const kept = parseLoopState(
    JSON.stringify({
      inFlight: [],
      interrupted: [{ ...old, reason: "uncommitted changes" }],
    }),
  );
  assert.equal(kept.interrupted[0]?.reason, "uncommitted changes");
});

test("parseLoopState drops a malformed self-update record and keeps a valid one", () => {
  const base = { inFlight: [] };
  assert.equal(
    parseLoopState(JSON.stringify({ ...base, selfUpdate: { from: "a" } })).selfUpdate,
    undefined,
  );
  assert.equal(
    parseLoopState(
      JSON.stringify({ ...base, selfUpdate: { from: "a", to: "b", at: "t", state: "odd" } }),
    ).selfUpdate,
    undefined,
  );
  assert.deepEqual(
    parseLoopState(
      JSON.stringify({
        ...base,
        selfUpdate: { from: "a", to: "b", at: "t", state: "applying", trigger: 3 },
      }),
    ).selfUpdate,
    { from: "a", to: "b", at: "t", state: "applying" },
  );
  assert.deepEqual(parseLoopState(JSON.stringify(base)).selfUpdateNotices, {});
});

test("reviewed heads and usage load additively, and an old file still loads", () => {
  const old = parseLoopState(JSON.stringify({ inFlight: [] }));
  assert.equal(old.reviewedHeads, undefined);
  assert.equal(old.usage, undefined);
  assert.equal(old.usageBaseline, undefined);
  assert.equal(old.shipped, undefined);
  assert.equal(old.splits, undefined);

  const next = parseLoopState(
    JSON.stringify({
      inFlight: [],
      reviewedHeads: {
        "part-1": { sha: "sha7", verdict: "approved" },
        "part-2": { sha: "sha8", verdict: "changes_requested" },
      },
      usage: { "parent-1": { input: 100, cached: 35, output: 20 } },
      usageBaseline: { "parent-1": { input: 50, cached: 0, output: 5, at: "t" } },
      shipped: {
        "part-1": {
          key: "MET-41",
          branch: "met-41-ship-it",
          prUrl: "https://github.test/pull/7",
          at: "t",
        },
        "part-2": { key: "", branch: "met-42", prUrl: "", at: "t" },
        "part-3": { key: "MET-43", branch: "", prUrl: "", at: "t" },
      },
      splits: {
        "parent-1": {
          key: "MET-40",
          parts: ["part-1", "part-2"],
          qa: "qa-1",
          at: "t",
        },
        "parent-2": { key: "", parts: ["part-3"], qa: "", at: "t" },
        "parent-3": { key: "MET-44", parts: [], qa: "qa-3", at: "t" },
      },
    }),
  );
  assert.deepEqual(next.reviewedHeads?.["part-1"], { sha: "sha7", verdict: "approved" });
  assert.deepEqual(next.reviewedHeads?.["part-2"], {
    sha: "sha8",
    verdict: "changes_requested",
  });
  assert.deepEqual(next.usage?.["parent-1"], { input: 100, cached: 35, output: 20 });
  assert.deepEqual(next.usageBaseline?.["parent-1"], {
    input: 50,
    cached: 0,
    output: 5,
    at: "t",
  });
  assert.deepEqual(next.shipped, {
    "part-1": {
      key: "MET-41",
      branch: "met-41-ship-it",
      prUrl: "https://github.test/pull/7",
      at: "t",
    },
  });
  assert.deepEqual(next.splits, {
    "parent-1": {
      key: "MET-40",
      parts: ["part-1", "part-2"],
      qa: "qa-1",
      at: "t",
    },
  });
});
