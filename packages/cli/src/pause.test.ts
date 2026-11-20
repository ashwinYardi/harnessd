import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  type PauseControl,
  type PauseState,
  pauseStatePath,
  startDaemon,
  writeDaemonInfo,
} from "@harnessd/daemon";
import { run } from "./index.ts";
import { parsePauseArgs } from "./pause.ts";

const roots: string[] = [];
after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function setup() {
  const home = await mkdtemp(join(tmpdir(), "harnessd-cli-pause-"));
  roots.push(home);
  const out: string[] = [];
  const err: string[] = [];
  const io = {
    out: (l: string) => out.push(l),
    err: (l: string) => err.push(l),
    env: { HARNESSD_HOME: home },
  };
  return { home, out, err, io };
}

async function flag(home: string): Promise<PauseState | undefined> {
  const file = pauseStatePath(home);
  return existsSync(file) ? JSON.parse(await readFile(file, "utf8")) : undefined;
}

test("pause and resume work with no daemon running", async () => {
  const s = await setup();
  assert.equal(await run(["pause", "--reason", "deploy freeze"], s.io), 0);
  assert.deepEqual(s.out, ["Paused. No daemon running; the flag applies at the next start."]);
  const state = await flag(s.home);
  assert.equal(state?.paused, true);
  assert.equal(state?.reason, "deploy freeze");
  assert.match(state?.since ?? "", /^\d{4}-\d\d-\d\dT/);

  assert.equal(await run(["resume"], s.io), 0);
  assert.equal(s.out[1], "Resumed. No daemon running.");
  assert.equal(await flag(s.home), undefined);
  assert.deepEqual(s.err, []);
});

test("pause and resume POST to the daemon named in daemon.json", async () => {
  const s = await setup();
  const calls: string[] = [];
  const control: PauseControl = {
    async status() {
      return { paused: false };
    },
    async pause(reason) {
      calls.push(`pause ${reason}`);
      return { paused: true, since: "2026-11-19T10:00:00.000Z", cancelled: 2 };
    },
    async resume() {
      calls.push("resume");
      return { paused: false };
    },
  };
  const daemon = await startDaemon({ pause: control });
  try {
    await writeDaemonInfo(s.home, { url: daemon.url, pid: 1, startedAt: "x" });
    assert.equal(await run(["pause", "--reason", "why"], s.io), 0);
    assert.equal(await run(["resume"], s.io), 0);
  } finally {
    await daemon.close();
  }
  assert.deepEqual(calls, ["pause why", "resume"]);
  assert.deepEqual(s.out, ["Paused. 2 runs cancelled; worktrees kept.", "Resumed."]);
  assert.equal(await flag(s.home), undefined, "the CLI wrote the flag itself too");
});

test("a stale daemon.json counts as no daemon, and an error reply still exits 0", async () => {
  const s = await setup();
  const closed = await startDaemon();
  const url = closed.url;
  await closed.close();
  await writeDaemonInfo(s.home, { url, pid: 1, startedAt: "x" });
  assert.equal(await run(["pause"], s.io), 0);
  assert.equal(s.out[0], "Paused. No daemon running; the flag applies at the next start.");

  const broken = createServer((_req, res) => {
    res.writeHead(500);
    res.end();
  });
  await new Promise<void>((resolve) => broken.listen(0, "127.0.0.1", resolve));
  const { port } = broken.address() as AddressInfo;
  try {
    await writeDaemonInfo(s.home, { url: `http://127.0.0.1:${port}`, pid: 1, startedAt: "x" });
    assert.equal(await run(["pause"], s.io), 0);
  } finally {
    await new Promise((resolve) => broken.close(resolve));
  }
  assert.match(s.out[1] ?? "", /^Paused\. Could not tell the daemon \(.* answered 500\); it stops/);
  assert.equal((await flag(s.home))?.paused, true);
});

test("bad arguments exit 2 with the usage line", async () => {
  const s = await setup();
  assert.equal(await run(["pause", "--reason"], s.io), 2);
  assert.equal(await run(["resume", "now"], s.io), 2);
  assert.match(s.err.join("\n"), /--reason: expected text\nUsage: harnessd pause/);
  assert.match(s.err.join("\n"), /unexpected argument "now"\nUsage: harnessd resume/);
  assert.equal(await flag(s.home), undefined, "nothing written");
  assert.deepEqual(parsePauseArgs(["--reason", "x"]), { reason: "x" });
  assert.equal(parsePauseArgs(["now"]), 'unexpected argument "now"');
});
