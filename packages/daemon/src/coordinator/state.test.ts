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
  attempts: { "id-1": 1 },
  qaFailures: { "parent-1": 1 },
  qaFeedback: { "id-1": { prUrl: "https://github.test/pull/7", failing: ["Works: no test"] } },
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
      inFlight: [state.inFlight[0], { issueId: "x" }],
      attempts: { a: 1, b: 0, c: "2", d: 1.5 },
      qaFailures: { p: 1, q: -1 },
      qaFeedback: { a: { failing: ["x", 3], reviewUrl: "u" }, b: { failing: "x" }, c: null },
    }),
  );
  assert.deepEqual(parsed, {
    version: 1,
    lastPollAt: null,
    inFlight: state.inFlight,
    attempts: { a: 1 },
    qaFailures: { p: 1 },
    qaFeedback: { a: { failing: ["x"], reviewUrl: "u" } },
  });
  assert.deepEqual(
    parseLoopState('{"inFlight":[]}'),
    emptyLoopState(),
    "a file from before QA still loads",
  );
  assert.throws(() => parseLoopState("[]"), /no inFlight array/);
});
