import assert from "node:assert/strict";
import { test } from "node:test";
import type { Job } from "../setupApi.ts";
import { copyText, jobStream, loginLink, signinPanel } from "./signin.ts";

const job = (over: Partial<Job> = {}): Job => ({
  id: "j1",
  harness: "codex",
  action: "signin",
  command: "codex login",
  state: "running",
  lines: [],
  startedAt: "2026-11-20T10:00:00.000Z",
  ...over,
});

test("loginLink keeps only an https url and names its host", () => {
  assert.deepEqual(loginLink("https://auth.example.com/device?x=1"), {
    href: "https://auth.example.com/device?x=1",
    host: "auth.example.com",
  });
  assert.equal(loginLink(undefined), undefined);
  assert.equal(loginLink("http://auth.example.com/device"), undefined);
  assert.equal(loginLink("javascript:alert(1)"), undefined);
  assert.equal(loginLink("HTTPS://auth.example.com"), undefined);
  assert.equal(loginLink("https://"), undefined);
  assert.equal(loginLink(" https://auth.example.com"), undefined);
});

test("signinPanel shows the link and the code while the sign-in runs", () => {
  assert.deepEqual(
    signinPanel(job({ url: "https://auth.example.com/device", code: "ABCD-EFGH" }), false),
    {
      link: { href: "https://auth.example.com/device", host: "auth.example.com" },
      code: "ABCD-EFGH",
      fallback: false,
    },
  );
});

test("signinPanel renders no link for a url that is not https", () => {
  const p = signinPanel(job({ url: "http://auth.example.com/device", code: "ABCD-EFGH" }), false);
  assert.equal(p.link, undefined);
  assert.equal(p.code, "ABCD-EFGH");
});

test("signinPanel shows the copy-command fallback when the sign-in fails", () => {
  const failed = job({ state: "failed", exitCode: 1, url: "https://auth.example.com/device" });
  assert.deepEqual(signinPanel(failed, false), {
    link: undefined,
    code: undefined,
    fallback: true,
  });
});

test("signinPanel shows the fallback when the job ends with no url and no code", () => {
  assert.equal(signinPanel(job({ state: "ok", exitCode: 0 }), false).fallback, true);
  // A job that gave the person a link ended because they signed in, so no fallback.
  const ok = job({ state: "ok", exitCode: 0, url: "https://auth.example.com/device" });
  assert.equal(signinPanel(ok, false).fallback, false);
});

test("signinPanel shows nothing once the harness is signed in, or for other actions", () => {
  assert.deepEqual(signinPanel(job({ state: "failed", exitCode: 1 }), true), {
    link: undefined,
    code: undefined,
    fallback: false,
  });
  assert.deepEqual(signinPanel(job({ action: "install", state: "failed" }), false), {
    link: undefined,
    code: undefined,
    fallback: false,
  });
  assert.deepEqual(signinPanel(null, false), {
    link: undefined,
    code: undefined,
    fallback: false,
  });
});

test("jobStream rechecks once on a job's final event, and not for replayed jobs", () => {
  const shown: Job[] = [];
  const ended: Job[] = [];
  let rechecks = 0;
  const onJob = jobStream({
    show: (j) => shown.push(j),
    ended: (j) => ended.push(j),
    recheck: () => rechecks++,
  });
  // A job that ended before the stream opened is replayed on connect: shown, not announced.
  onJob(job({ id: "old", state: "ok" }));
  assert.equal(rechecks, 0);
  // A fake sign-in stream: start, a url line, the code line, then the final event.
  onJob(job({ id: "j2" }));
  onJob(job({ id: "j2", url: "https://auth.example.com/device" }));
  onJob(job({ id: "j2", url: "https://auth.example.com/device", code: "ABCD-EFGH" }));
  assert.equal(rechecks, 0);
  onJob(job({ id: "j2", state: "ok", exitCode: 0 }));
  assert.equal(rechecks, 1);
  assert.deepEqual(
    ended.map((j) => [j.id, j.state]),
    [["j2", "ok"]],
  );
  // The same final state again is not a second end.
  onJob(job({ id: "j2", state: "ok", exitCode: 0 }));
  assert.equal(rechecks, 1);
  // A failed job is a final event too.
  onJob(job({ id: "j3" }));
  onJob(job({ id: "j3", state: "failed", exitCode: 1 }));
  assert.equal(rechecks, 2);
  assert.equal(shown.length, 8);
});

test("jobStream rechecks after a job this page started, seen first as running", () => {
  let rechecks = 0;
  const onJob = jobStream({ show: () => {}, ended: () => {}, recheck: () => rechecks++ });
  onJob.started(job({ id: "j4" }));
  onJob(job({ id: "j4", state: "failed", exitCode: 1 }));
  assert.equal(rechecks, 1);
});

test("copyText writes to the clipboard and says whether it worked", async () => {
  const written: string[] = [];
  const ok = { writeText: async (t: string) => void written.push(t) };
  assert.equal(await copyText(ok, "ABCD-EFGH"), true);
  assert.deepEqual(written, ["ABCD-EFGH"]);
  const denied = { writeText: async () => Promise.reject(new Error("denied")) };
  assert.equal(await copyText(denied, "codex login"), false);
  assert.equal(await copyText(undefined, "codex login"), false);
});
