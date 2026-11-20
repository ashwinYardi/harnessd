import assert from "node:assert/strict";
import { request } from "node:http";
import { test } from "node:test";
import type { PauseControl, PauseState } from "../control/pause.ts";
import { DAEMON_HOST, parsePauseBody, startDaemon } from "./daemon.ts";
import { HttpError } from "./router.ts";

function fakeControl() {
  let state: PauseState = { paused: false };
  const reasons: Array<string | undefined> = [];
  const control: PauseControl = {
    async status() {
      return state;
    },
    async pause(reason) {
      reasons.push(reason);
      state = { paused: true, since: "2026-11-19T10:00:00.000Z" };
      if (reason !== undefined) state.reason = reason;
      return { ...state, cancelled: 2 };
    },
    async resume() {
      state = { paused: false };
      return state;
    },
  };
  return { control, reasons };
}

const json = { "content-type": "application/json" };

test("startDaemon binds to 127.0.0.1 only", async () => {
  const daemon = await startDaemon();
  try {
    assert.equal(DAEMON_HOST, "127.0.0.1");
    assert.match(daemon.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    const res = await fetch(`${daemon.url}/health`);
    assert.equal(res.status, 200);
  } finally {
    await daemon.close();
  }
});

test("the pause API reads, pauses and resumes", async () => {
  const { control, reasons } = fakeControl();
  const daemon = await startDaemon({ pause: control });
  try {
    const get = await fetch(`${daemon.url}/api/pause`);
    assert.equal(get.status, 200);
    assert.deepEqual(await get.json(), { paused: false });

    const pause = await fetch(`${daemon.url}/api/pause`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ reason: "deploy" }),
    });
    assert.deepEqual(await pause.json(), {
      paused: true,
      since: "2026-11-19T10:00:00.000Z",
      reason: "deploy",
      cancelled: 2,
    });
    const bare = await fetch(`${daemon.url}/api/pause`, { method: "POST", headers: json });
    assert.equal(bare.status, 200, "the body is optional");
    assert.deepEqual(reasons, ["deploy", undefined]);
    assert.deepEqual(await (await fetch(`${daemon.url}/api/pause?x=1`)).json(), {
      paused: true,
      since: "2026-11-19T10:00:00.000Z",
    });

    const resume = await fetch(`${daemon.url}/api/resume`, { method: "POST", headers: json });
    assert.deepEqual(await resume.json(), { paused: false });
  } finally {
    await daemon.close();
  }
});

test("unknown routes are 404, wrong methods 405, and bad requests are refused", async () => {
  const daemon = await startDaemon({ pause: fakeControl().control });
  const post = (path: string, init: RequestInit = {}) =>
    fetch(`${daemon.url}${path}`, { method: "POST", headers: json, ...init });
  try {
    const missing = await fetch(`${daemon.url}/api/nope`);
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), {
      error: "not_found",
      message: "no route for /api/nope",
    });

    const wrong = await fetch(`${daemon.url}/api/resume`);
    assert.equal(wrong.status, 405);
    assert.equal(wrong.headers.get("allow"), "POST");
    const del = await fetch(`${daemon.url}/api/pause`, { method: "DELETE" });
    assert.equal(del.status, 405);
    assert.equal(del.headers.get("allow"), "GET, POST");

    const plain = await post("/api/pause", { headers: { "content-type": "text/plain" } });
    assert.equal(plain.status, 415, "a cross-origin form post is refused");
    assert.equal((await post("/api/pause", { body: "{oops" })).status, 400);
    const bad = await post("/api/pause", { body: JSON.stringify({ reason: 5 }) });
    assert.equal(bad.status, 400);
    assert.equal(((await bad.json()) as { error: string }).error, "invalid_body");
    const big = await post("/api/pause", { body: JSON.stringify({ reason: "x".repeat(70_000) }) });
    assert.equal(big.status, 413);

    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(`${daemon.url}/health`, { headers: { host: "evil.test" } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on("error", reject);
      req.end();
    });
    assert.equal(status, 403, "DNS rebinding is refused");
  } finally {
    await daemon.close();
  }
});

test("without a pause control the pause routes are 404", async () => {
  const daemon = await startDaemon();
  try {
    assert.equal((await fetch(`${daemon.url}/api/pause`)).status, 404);
  } finally {
    await daemon.close();
  }
});

test("parsePauseBody takes an optional reason and nothing else", () => {
  assert.equal(parsePauseBody(undefined), undefined);
  assert.equal(parsePauseBody({}), undefined);
  assert.equal(parsePauseBody({ reason: " a " }), "a");
  assert.throws(() => parsePauseBody([]), HttpError);
  assert.throws(() => parsePauseBody({ why: "x" }), /unknown key why/);
});

test("a busy port is an error", async () => {
  const first = await startDaemon();
  try {
    const port = Number(new URL(first.url).port);
    await assert.rejects(startDaemon({ port }), /EADDRINUSE/);
  } finally {
    await first.close();
  }
});
