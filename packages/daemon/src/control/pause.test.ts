import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  cleanReason,
  createFilePauseStore,
  createPauseController,
  MAX_PAUSE_REASON,
  type PausableLoop,
  PauseStateError,
  parsePauseState,
  pauseStatePath,
} from "./pause.ts";

const roots: string[] = [];
after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function home(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "harnessd-pause-"));
  roots.push(dir);
  return dir;
}

const at = (iso: string) => () => new Date(iso);

test("a missing flag is running", async () => {
  assert.deepEqual(await createFilePauseStore(await home()).read(), { paused: false });
});

test("pause writes paused.json atomically under <global>/state and resume removes it", async () => {
  const dir = await home();
  const store = createFilePauseStore(dir, { now: at("2026-11-19T10:00:00.000Z") });
  assert.equal(pauseStatePath(dir), join(dir, "state", "paused.json"));
  const state = await store.pause("  deploy\n freeze ");
  assert.deepEqual(state, {
    paused: true,
    since: "2026-11-19T10:00:00.000Z",
    reason: "deploy freeze",
  });
  assert.deepEqual(JSON.parse(await readFile(pauseStatePath(dir), "utf8")), state);
  assert.deepEqual((await readdir(join(dir, "state"))).sort(), [".gitignore", "paused.json"]);

  assert.deepEqual(await store.resume(), { paused: false });
  assert.deepEqual(await readdir(join(dir, "state")), [".gitignore"]);
  assert.deepEqual(await store.resume(), { paused: false }, "resume is idempotent");
});

test("a second pause keeps since and the old reason unless given a new one", async () => {
  const dir = await home();
  await createFilePauseStore(dir, { now: at("2026-11-19T10:00:00.000Z") }).pause("first");
  const later = createFilePauseStore(dir, { now: at("2026-11-19T11:00:00.000Z") });
  assert.deepEqual(await later.pause(), {
    paused: true,
    since: "2026-11-19T10:00:00.000Z",
    reason: "first",
  });
  assert.equal((await later.pause("second")).reason, "second");
});

test("the flag persists for a new store instance", async () => {
  const dir = await home();
  await createFilePauseStore(dir).pause();
  assert.equal((await createFilePauseStore(dir).read()).paused, true);
});

test("an unreadable flag counts as paused", async () => {
  const dir = await home();
  await mkdir(join(dir, "state"), { recursive: true });
  await writeFile(pauseStatePath(dir), "{nope");
  const state = await createFilePauseStore(dir).read();
  assert.equal(state.paused, true);
  assert.match(state.reason ?? "", /unreadable \(invalid pause flag: not JSON\)/);
});

test("parsePauseState checks the shape", () => {
  assert.deepEqual(parsePauseState('{"paused":false,"since":"x"}'), { paused: false });
  assert.deepEqual(parsePauseState('{"paused":true,"since":"s","reason":" "}'), {
    paused: true,
    since: "s",
  });
  assert.throws(() => parsePauseState("[]"), PauseStateError);
  assert.throws(() => parsePauseState('{"paused":"yes"}'), /paused is not a boolean/);
  assert.equal(cleanReason("x".repeat(600))?.length, MAX_PAUSE_REASON);
  assert.equal(cleanReason(""), undefined);
});

test("the controller writes the flag, then pauses every loop and counts the runs", async () => {
  const dir = await home();
  const calls: string[] = [];
  const loop = (keys: string[]): PausableLoop => ({
    async pause() {
      calls.push(`pause ${keys.join(",")}`);
      return keys;
    },
    resume() {
      calls.push("resume");
    },
  });
  const store = createFilePauseStore(dir, { now: at("2026-11-19T10:00:00.000Z") });
  const control = createPauseController({ store, loops: [loop(["MET-1", "MET-2"]), loop([])] });
  assert.deepEqual(await control.status(), { paused: false });
  assert.deepEqual(await control.pause("why"), {
    paused: true,
    since: "2026-11-19T10:00:00.000Z",
    reason: "why",
    cancelled: 2,
  });
  assert.equal((await store.read()).paused, true, "flag written");
  assert.deepEqual(await control.resume(), { paused: false });
  assert.equal((await store.read()).paused, false);
  assert.deepEqual(calls, ["pause MET-1,MET-2", "pause ", "resume", "resume"]);
});
