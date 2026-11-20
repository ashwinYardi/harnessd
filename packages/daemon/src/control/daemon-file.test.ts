import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  daemonInfoPath,
  readDaemonInfo,
  removeDaemonInfo,
  writeDaemonInfo,
} from "./daemon-file.ts";

const roots: string[] = [];
after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

const info = { url: "http://127.0.0.1:4747", pid: 10, startedAt: "2026-11-19T10:00:00.000Z" };

test("daemon.json round-trips and is removed only by the daemon it names", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harnessd-daemon-file-"));
  roots.push(dir);
  assert.equal(daemonInfoPath(dir), join(dir, "state", "daemon.json"));
  assert.equal(await readDaemonInfo(dir), undefined);
  await writeDaemonInfo(dir, info);
  assert.deepEqual(await readDaemonInfo(dir), info);

  await removeDaemonInfo(dir, { ...info, pid: 11 });
  assert.deepEqual(await readDaemonInfo(dir), info, "another daemon's file stays");
  await removeDaemonInfo(dir, info);
  assert.equal(await readDaemonInfo(dir), undefined);

  await writeFile(daemonInfoPath(dir), '{"url":"file:///etc","pid":1,"startedAt":"x"}');
  assert.equal(await readDaemonInfo(dir), undefined, "only http urls");
});
