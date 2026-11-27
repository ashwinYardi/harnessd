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
  sessions: {
    "id-1": {
      harness: "claude-code",
      sessionId: "sess-1",
      worktree: "/wt/met-41",
      branch: "met-41-api",
      at: "2026-11-19T10:05:00.000Z",
    },
  },
  pendingQa: {
    "qa-1": {
      parentId: "parent-1",
      qaKey: "MET-43",
      reviews: [
        {
          partId: "id-1",
          partKey: "MET-41",
          decision: "approve",
          failing: [],
          prNumber: 7,
          prUrl: "https://github.test/pull/7",
          head: "abc123",
          event: "APPROVE",
          body: "**harnessd QA** (MET-43): approved.",
          done: false,
        },
      ],
      done: [],
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
  assert.deepEqual(loaded.sessions, state.sessions, "a part session survives a reload");
  assert.deepEqual(loaded.pendingQa, state.pendingQa, "a pending QA verdict survives a reload");
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

test("sessions are optional, and a malformed one is dropped", () => {
  assert.equal(parseLoopState('{"inFlight":[]}').sessions, undefined, "old files still load");
  const good = state.sessions?.["id-1"];
  const parsed = parseLoopState(
    JSON.stringify({
      inFlight: [],
      sessions: {
        a: good,
        b: { ...good, harness: "nope" },
        c: { ...good, sessionId: "" },
        d: { ...good, worktree: "" },
      },
      qaFeedback: { a: { failing: ["x"], testTail: "not ok" } },
    }),
  );
  assert.deepEqual(parsed.sessions, { a: good });
  assert.equal(parsed.qaFeedback.a?.testTail, "not ok");
});

test("pendingQa is optional, and a malformed entry is dropped (MET-213)", () => {
  assert.equal(parseLoopState('{"inFlight":[]}').pendingQa, undefined, "old files still load");
  const good = state.pendingQa?.["qa-1"];
  assert.ok(good);
  const parsed = parseLoopState(
    JSON.stringify({
      inFlight: [],
      pendingQa: {
        "qa-1": good,
        "qa-2": { ...good, reviews: [{ ...good.reviews[0], decision: "maybe" }] },
        "qa-3": { ...good, parentId: "" },
        "qa-4": { ...good, done: "comment" },
        "qa-5": { ...good, reviews: [{ ...good.reviews[0], head: undefined }] },
      },
    }),
  );
  assert.deepEqual(parsed.pendingQa, { "qa-1": good }, "the well-formed record stays");
});

test("qaFeedback cases are optional, and a malformed case drops only the array (D-054)", async () => {
  const good = {
    id: "C1",
    item: "It has tests",
    repro: "pnpm test -- avatars",
    expected: "the avatar test passes",
    actual: "not ok 3 - avatars",
  };
  const parsed = parseLoopState(
    JSON.stringify({
      inFlight: [],
      qaFeedback: {
        a: { failing: ["x"], cases: [good] },
        b: { failing: ["y"], cases: [{ ...good, repro: " " }] },
        c: { failing: ["z"] },
      },
    }),
  );
  assert.deepEqual(parsed.qaFeedback.a, { failing: ["x"], cases: [good] });
  assert.deepEqual(parsed.qaFeedback.b, { failing: ["y"] }, "the entry stays without its cases");
  assert.deepEqual(parsed.qaFeedback.c, { failing: ["z"] }, "an old entry still loads");

  const store = createFileLoopStore(await repo());
  const state = emptyLoopState();
  state.qaFeedback["id-1"] = { failing: ["x"], cases: [good] };
  await store.save(state);
  assert.deepEqual((await store.load()).qaFeedback["id-1"]?.cases, [good]);
});

test("reviewedHeads cases are optional, and a malformed one drops only the cases (D-054)", async () => {
  const good = {
    id: "C1",
    item: "It has tests",
    repro: "pnpm test -- avatars",
    expected: "the avatar test passes",
    actual: "not ok 3 - avatars",
  };
  const parsed = parseLoopState(
    JSON.stringify({
      inFlight: [],
      reviewedHeads: {
        a: { sha: "sha7", verdict: "changes_requested", cases: [good] },
        b: {
          sha: "sha8",
          verdict: "changes_requested",
          cases: [{ ...good, actual: " " }],
        },
        c: { sha: "sha9", verdict: "changes_requested" },
        d: { sha: "sha10", verdict: "approved", cases: [good] },
      },
    }),
  );
  assert.deepEqual(parsed.reviewedHeads?.a, {
    sha: "sha7",
    verdict: "changes_requested",
    cases: [good],
  });
  assert.deepEqual(
    parsed.reviewedHeads?.b,
    { sha: "sha8", verdict: "changes_requested" },
    "the head stays without its cases",
  );
  assert.deepEqual(parsed.reviewedHeads?.c, {
    sha: "sha9",
    verdict: "changes_requested",
  });
  assert.deepEqual(
    parsed.reviewedHeads?.d,
    { sha: "sha10", verdict: "approved", cases: [good] },
    "an approved head keeps what it was given",
  );

  const store = createFileLoopStore(await repo());
  const state = emptyLoopState();
  state.reviewedHeads = {
    "part-1": { sha: "sha7", verdict: "changes_requested", cases: [good] },
  };
  await store.save(state);
  assert.deepEqual((await store.load()).reviewedHeads?.["part-1"]?.cases, [good]);
});

test("qaLiveWarned is optional and survives a restart (MET-180)", async () => {
  assert.equal(parseLoopState('{"inFlight":[]}').qaLiveWarned, undefined, "old files still load");
  assert.equal(
    parseLoopState(JSON.stringify({ inFlight: [], qaLiveWarned: 7 })).qaLiveWarned,
    undefined,
    "a non-string is dropped",
  );
  assert.equal(
    parseLoopState(JSON.stringify({ inFlight: [], qaLiveWarned: "" })).qaLiveWarned,
    undefined,
    "an empty string is dropped",
  );
  const time = "2026-11-24T10:00:00.000Z";
  assert.equal(
    parseLoopState(JSON.stringify({ inFlight: [], qaLiveWarned: time })).qaLiveWarned,
    time,
  );

  const store = createFileLoopStore(await repo());
  const state = emptyLoopState();
  state.qaLiveWarned = time;
  await store.save(state);
  assert.equal((await store.load()).qaLiveWarned, time);
});

test("harnessSwitch is optional and drops a malformed entry (D-048)", () => {
  assert.equal(parseLoopState('{"inFlight":[]}').harnessSwitch, undefined, "old files still load");
  const parsed = parseLoopState(
    JSON.stringify({
      inFlight: [],
      harnessSwitch: {
        a: { from: "claude-code", reason: "timed out", at: "2026-11-23T09:00:00.000Z" },
        b: { from: "nope", reason: "timed out", at: "2026-11-23T09:00:00.000Z" },
        c: { from: "codex", reason: "", at: "2026-11-23T09:00:00.000Z" },
        d: { from: "codex", reason: "stalled" },
      },
    }),
  );
  assert.deepEqual(parsed.harnessSwitch, {
    a: { from: "claude-code", reason: "timed out", at: "2026-11-23T09:00:00.000Z" },
  });
});

test("harnessSwitch survives a save and a load (D-048)", async () => {
  const store = createFileLoopStore(await repo());
  const state = emptyLoopState();
  state.harnessSwitch = {
    "id-1": { from: "opencode", reason: "stalled", at: "2026-11-23T09:00:00.000Z" },
  };
  await store.save(state);
  assert.deepEqual((await store.load()).harnessSwitch, state.harnessSwitch);
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

test("reviewerHeads is optional, keeps a valid entry and drops a malformed one (MET-224)", async () => {
  assert.equal(parseLoopState('{"inFlight":[]}').reviewerHeads, undefined, "old files still load");
  const finding = {
    file: "src/a.ts",
    line: 12,
    severity: "blocking",
    kind: "code",
    text: "The loop reads the file on every tick.",
  };
  const nit = {
    file: "src/b.ts",
    line: 3,
    severity: "nit",
    kind: "design",
    text: "The name hides the seam.",
  };
  const at = "2026-11-27T10:00:00.000Z";
  const parsed = parseLoopState(
    JSON.stringify({
      inFlight: [],
      reviewerHeads: {
        a: { sha: "sha7", verdict: "changes_requested", findings: [finding, nit], at },
        b: { sha: "sha8", verdict: "approved", findings: [], at },
        c: { sha: "sha9", verdict: "approved", findings: [{ ...finding, line: 0 }], at },
        d: { sha: "", verdict: "approved", findings: [], at },
        e: { sha: "sha10", verdict: "perhaps", findings: [], at },
        f: { sha: "sha11", verdict: "approved", findings: [] },
      },
    }),
  );
  assert.deepEqual(parsed.reviewerHeads, {
    a: { sha: "sha7", verdict: "changes_requested", findings: [finding, nit], at },
    b: { sha: "sha8", verdict: "approved", findings: [], at },
  });

  const store = createFileLoopStore(await repo());
  const state = emptyLoopState();
  state.reviewerHeads = parsed.reviewerHeads ?? {};
  await store.save(state);
  assert.deepEqual((await store.load()).reviewerHeads, state.reviewerHeads);
});

test("pendingReview is optional, keeps a valid entry and drops a malformed one (MET-224, D-058)", async () => {
  assert.equal(parseLoopState('{"inFlight":[]}').pendingReview, undefined, "old files still load");
  const valid = {
    partId: "part-1",
    partKey: "MET-41",
    parentId: "parent-1",
    prNumber: 7,
    prUrl: "https://github.test/pull/7",
    head: "sha7",
    body: "**harnessd review**: approved.",
  };
  const parsed = parseLoopState(
    JSON.stringify({
      inFlight: [],
      pendingReview: {
        a: valid,
        b: { ...valid, partId: "" },
        c: { ...valid, prNumber: 0 },
        d: { ...valid, head: "" },
        e: { ...valid, body: 3 },
        f: { ...valid, reviewUrl: "https://github.test/pull/7#review-1" },
      },
    }),
  );
  assert.deepEqual(parsed.pendingReview, {
    a: valid,
    f: { ...valid, reviewUrl: "https://github.test/pull/7#review-1" },
  });

  const store = createFileLoopStore(await repo());
  const state = emptyLoopState();
  state.pendingReview = parsed.pendingReview ?? {};
  await store.save(state);
  assert.deepEqual((await store.load()).pendingReview, state.pendingReview);
});
