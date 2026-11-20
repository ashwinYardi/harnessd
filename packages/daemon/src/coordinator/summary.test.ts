import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { Notice } from "./notifier.ts";
import {
  createDailySummary,
  createFileSummaryStore,
  type DailySummaryOptions,
  lastSummarySlot,
  type SummaryState,
  type SummaryStore,
} from "./summary.ts";

test("the summary slot is the last summary time in the time zone", () => {
  const slot = (now: string, tz = "Asia/Kolkata", time = "21:00") =>
    lastSummarySlot(new Date(now), tz, time).toISOString();
  // 21:00 IST is 15:30 UTC.
  assert.equal(slot("2026-11-20T16:00:00Z"), "2026-11-20T15:30:00.000Z");
  assert.equal(slot("2026-11-20T15:30:00Z"), "2026-11-20T15:30:00.000Z");
  assert.equal(slot("2026-11-20T15:29:00Z"), "2026-11-19T15:30:00.000Z");
  // Across midnight UTC and a month end.
  assert.equal(slot("2026-12-01T01:00:00Z"), "2026-11-30T15:30:00.000Z");
  // New York moves to summer time on 8 March 2026.
  assert.equal(slot("2026-03-09T02:00:00Z", "America/New_York"), "2026-03-09T01:00:00.000Z");
  assert.equal(slot("2026-03-09T00:30:00Z", "America/New_York"), "2026-03-08T02:00:00.000Z");
  assert.equal(slot("2026-11-20T08:00:00Z", "UTC", "07:15"), "2026-11-20T07:15:00.000Z");
});

const parent = { key: "MET-1", url: "https://linear.test/MET-1" };
const merged: Notice = {
  kind: "merged",
  issue: parent,
  part: "MET-2",
  prs: [{ number: 7, url: "https://github.test/pull/7" }],
};
const blocked: Notice = {
  kind: "needs_input",
  issue: { key: "MET-5", url: "https://linear.test/MET-5" },
  prs: [],
  reason: "QA failed twice",
};

function memoryStore(initial?: Partial<SummaryState>) {
  const box: { state: SummaryState; saves: number; fail: boolean } = {
    state: { version: 1, notices: [], ...initial },
    saves: 0,
    fail: false,
  };
  const store: SummaryStore = {
    async load() {
      return structuredClone(box.state);
    },
    async save(s) {
      if (box.fail) throw new Error("disk full");
      box.saves++;
      box.state = structuredClone(s);
    },
  };
  return { box, store };
}

function harness(
  start: string,
  initial?: Partial<SummaryState>,
  extra?: Partial<DailySummaryOptions>,
) {
  const { box, store } = memoryStore(initial);
  const clock = { now: new Date(start) };
  const posts: string[] = [];
  const logs: string[] = [];
  const forwarded: Notice[] = [];
  const summary = createDailySummary({
    store,
    now: () => clock.now,
    timeZone: "Asia/Kolkata",
    time: "21:00",
    post: (text) => posts.push(text),
    inProgress: () => [{ key: "MET-8" }],
    log: (line) => logs.push(line),
    ...extra,
  });
  const notifier = summary.wrap({
    async notify(n) {
      forwarded.push(n);
    },
  });
  const at = (iso: string) => {
    clock.now = new Date(iso);
  };
  return { box, summary, notifier, posts, logs, forwarded, at };
}

test("the first start sends no summary and starts counting from now", async () => {
  const h = harness("2026-11-20T16:00:00Z");
  assert.equal(await h.summary.check(), false);
  assert.deepEqual(h.posts, []);
  assert.equal(h.box.state.lastSentAt, "2026-11-20T16:00:00.000Z");
});

test("at 21:00 the summary lists merges, blocks and work in progress, once", async () => {
  const h = harness("2026-11-20T10:00:00Z", { lastSentAt: "2026-11-19T15:30:00.000Z" });
  assert.equal(await h.summary.check(), false, "not yet 21:00 IST");
  await h.notifier.notify(merged);
  await h.notifier.notify(blocked);
  assert.deepEqual(h.forwarded, [merged, blocked], "every notice still goes out at once");

  h.at("2026-11-20T15:30:00Z");
  assert.equal(await h.summary.check(), true);
  assert.deepEqual(h.posts, [
    [
      "*harnessd daily summary* since 19 Nov 21:00 (Asia/Kolkata)",
      "*Merged (1)*",
      "• MET-2 merged: <https://github.test/pull/7|PR #7> (<https://linear.test/MET-1|MET-1>)",
      "*Blocked (1)*",
      "• <https://linear.test/MET-5|MET-5> needs input (QA failed twice)",
      "*In progress (1)*: MET-8",
    ].join("\n"),
  ]);
  assert.deepEqual(h.box.state.notices, []);
  assert.equal(h.box.state.lastSentAt, "2026-11-20T15:30:00.000Z");

  h.at("2026-11-20T15:31:00Z");
  assert.equal(await h.summary.check(), false, "one summary per day");
  assert.equal(h.posts.length, 1);
});

test("an empty day still gets a short summary", async () => {
  const h = harness(
    "2026-11-20T15:35:00Z",
    { lastSentAt: "2026-11-19T15:30:00.000Z" },
    {
      inProgress: () => [],
    },
  );
  assert.equal(await h.summary.check(), true);
  assert.deepEqual(h.posts, [
    [
      "*harnessd daily summary* since 19 Nov 21:00 (Asia/Kolkata)",
      "*Merged*: none",
      "*Blocked*: none",
      "*In progress*: none",
    ].join("\n"),
  ]);
});

test("a summary missed while the daemon was off is sent once at the next start", async () => {
  // Last sent on the 17th; off from the 18th to the morning of the 21st.
  const h = harness("2026-11-21T04:00:00Z", {
    lastSentAt: "2026-11-17T15:30:00.000Z",
    notices: [{ at: "2026-11-18T09:00:00.000Z", notice: merged }],
  });
  assert.equal(await h.summary.check(), true);
  assert.equal(h.posts.length, 1);
  assert.match(h.posts[0] ?? "", /since 17 Nov 21:00/);
  assert.match(h.posts[0] ?? "", /\*Merged \(1\)\*/);

  h.at("2026-11-21T05:00:00Z");
  assert.equal(await h.summary.check(), false, "not repeated");
  h.at("2026-11-21T15:30:00Z");
  assert.equal(await h.summary.check(), true, "the 21st gets its own summary");
  assert.equal(h.posts.length, 2);
});

test("notices survive a restart through the store", async () => {
  const first = harness("2026-11-20T10:00:00Z", { lastSentAt: "2026-11-19T15:30:00.000Z" });
  await first.notifier.notify(merged);
  const { store } = memoryStore(first.box.state);
  const posts: string[] = [];
  const second = createDailySummary({
    store,
    now: () => new Date("2026-11-20T15:30:00Z"),
    timeZone: "Asia/Kolkata",
    time: "21:00",
    post: (text) => posts.push(text),
    inProgress: () => [],
  });
  assert.equal(await second.check(), true);
  assert.match(posts[0] ?? "", /\*Merged \(1\)\*/);
});

test("a store failure is logged, never thrown, and the summary is not repeated", async () => {
  const h = harness("2026-11-20T15:30:00Z", { lastSentAt: "2026-11-19T15:30:00.000Z" });
  h.box.fail = true;
  await h.notifier.notify(merged);
  assert.equal(h.forwarded.length, 1);
  assert.equal(await h.summary.check(), true);
  assert.equal(await h.summary.check(), false);
  assert.equal(h.posts.length, 1);
  assert.ok(h.logs.some((l) => /^summary: could not save .*disk full/.test(l)));
});

const roots: string[] = [];
after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

test("the file store keeps summary.json next to loop.json", async () => {
  const repo = await mkdtemp(join(tmpdir(), "harnessd-summary-"));
  roots.push(repo);
  const store = createFileSummaryStore(repo);
  assert.deepEqual(await store.load(), { version: 1, notices: [] });
  const state: SummaryState = {
    version: 1,
    lastSentAt: "2026-11-19T15:30:00.000Z",
    notices: [{ at: "2026-11-20T09:00:00.000Z", notice: merged }],
  };
  await store.save(state);
  assert.deepEqual(await store.load(), state);
  const file = join(repo, ".harnessd", "state", "summary.json");
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), state);
});
