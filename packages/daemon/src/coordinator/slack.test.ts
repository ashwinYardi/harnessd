import assert from "node:assert/strict";
import { test } from "node:test";
import type { Notice } from "./notifier.ts";
import { createSlackNotifier, type SlackFetch } from "./slack.ts";

// Not a real webhook: tests never touch the network.
const URL = "https://hooks.slack.test/services/T000/B000/fake-token";

const notice: Notice = {
  kind: "merged",
  issue: { key: "MET-1", url: "https://linear.test/MET-1" },
  part: "MET-2",
  prs: [{ number: 7, url: "https://github.test/pull/7" }],
};

interface Call {
  url: string;
  body: unknown;
}

/** A fake fetch that answers with the given statuses in order, then 200. */
function fakeFetch(answers: (number | Error)[] = []) {
  const calls: Call[] = [];
  const fetch: SlackFetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    const answer = answers.shift() ?? 200;
    if (answer instanceof Error) throw answer;
    return { ok: answer >= 200 && answer < 300, status: answer };
  };
  return { fetch, calls };
}

function harness(answers: (number | Error)[] = []) {
  const f = fakeFetch(answers);
  const sleeps: number[] = [];
  const logs: string[] = [];
  const slack = createSlackNotifier({
    webhookUrl: URL,
    fetch: f.fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    log: (line) => logs.push(line),
  });
  return { slack, calls: f.calls, sleeps, logs };
}

test("a notice is posted as one Slack line with links", async () => {
  const h = harness();
  await h.slack.notify(notice);
  await h.slack.flush();
  assert.deepEqual(h.calls, [
    {
      url: URL,
      body: {
        text: "MET-2 merged: <https://github.test/pull/7|PR #7> (<https://linear.test/MET-1|MET-1>)",
        unfurl_links: false,
      },
    },
  ]);
  assert.deepEqual(h.logs, []);
});

test("notify returns before Slack answers, so the loop never waits", async () => {
  let answer: (() => void) | undefined;
  const slack = createSlackNotifier({
    webhookUrl: URL,
    fetch: () =>
      new Promise((resolve) => {
        answer = () => resolve({ ok: true, status: 200 });
      }),
    sleep: async () => {},
  });
  await slack.notify(notice);
  assert.ok(answer, "the post started");
  let flushed = false;
  const flushing = slack.flush().then(() => {
    flushed = true;
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(flushed, false);
  answer?.();
  await flushing;
  assert.equal(flushed, true);
});

test("a 5xx, a 429 or a network error is retried with backoff", async () => {
  const h = harness([500, 429, new Error("socket hang up")]);
  await h.slack.notify(notice);
  await h.slack.flush();
  assert.equal(h.calls.length, 4);
  assert.deepEqual(h.sleeps, [1000, 2000, 4000]);
  assert.equal(h.logs.length, 3);
  assert.match(h.logs[0] ?? "", /^slack: could not post \(HTTP 500\), retry 1 of 3 in 1s$/);
});

test("after 3 retries the message is dropped and logged, and the next one still goes", async () => {
  const h = harness([503, 503, 503, 503]);
  await h.slack.notify(notice);
  h.slack.post("second");
  await h.slack.flush();
  assert.equal(h.calls.length, 5);
  assert.match(h.logs.at(-1) ?? "", /^slack: dropped a message after 4 tries \(HTTP 503\)$/);
  assert.deepEqual(h.calls.at(-1)?.body, { text: "second", unfurl_links: false });
});

test("a 4xx other than 429 is dropped at once: retrying cannot fix it", async () => {
  const h = harness([404]);
  await h.slack.notify(notice);
  await h.slack.flush();
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.sleeps, []);
  assert.deepEqual(h.logs, ["slack: dropped a message after 1 try (HTTP 404)"]);
});

test("the webhook url never reaches a log line", async () => {
  const h = harness([new Error(`request to ${URL} failed`), 400]);
  await h.slack.notify(notice);
  await h.slack.flush();
  assert.equal(h.logs.length, 2);
  for (const line of h.logs) {
    assert.doesNotMatch(line, /fake-token|hooks\.slack/);
  }
  assert.match(h.logs[0] ?? "", /request to <webhook> failed/);
});

test("the queue is bounded: the oldest message is dropped when Slack is down", async () => {
  let release: (() => void) | undefined;
  const bodies: string[] = [];
  const slack = createSlackNotifier({
    webhookUrl: URL,
    maxQueue: 2,
    fetch: async (_url, init) => {
      bodies.push(String(init.body));
      if (release === undefined) await new Promise<void>((r) => (release = r));
      return { ok: true, status: 200 };
    },
    sleep: async () => {},
    log: () => {},
  });
  slack.post("a");
  slack.post("b");
  slack.post("c");
  slack.post("d");
  await new Promise((r) => setImmediate(r));
  release?.();
  await slack.flush();
  assert.deepEqual(
    bodies.map((b) => (JSON.parse(b) as { text: string }).text),
    ["a", "c", "d"],
  );
});
