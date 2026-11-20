import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SETTINGS } from "@harnessd/shared";
import type { SlackFetch } from "./slack.ts";
import type { SummaryState, SummaryStore } from "./summary.ts";
import { createVisibility } from "./visibility.ts";

const URL = "https://hooks.slack.test/services/T000/B000/fake-token";

function memoryStore(state: SummaryState): SummaryStore {
  return {
    async load() {
      return structuredClone(state);
    },
    async save() {},
  };
}

function setup(initial: string | undefined) {
  const logs: string[] = [];
  const texts: string[] = [];
  const urls: string[] = [];
  let webhook = initial;
  const fetch: SlackFetch = async (url, init) => {
    urls.push(url);
    texts.push((JSON.parse(init.body) as { text: string }).text);
    return { ok: true, status: 200 };
  };
  const v = createVisibility({
    webhookUrl: async () => webhook,
    slack: DEFAULT_SETTINGS.slack,
    repoDir: "/nonexistent",
    store: memoryStore({ version: 1, lastSentAt: "2026-11-18T15:30:00.000Z", notices: [] }),
    now: () => new Date("2026-11-20T16:00:00Z"),
    inProgress: () => [{ key: "MET-8" }],
    log: (line) => logs.push(line),
    fetch,
  });
  return {
    v,
    logs,
    texts,
    urls,
    set(url: string | undefined) {
      webhook = url;
    },
  };
}

test("without a webhook url nothing is posted, and the start line warns once", async () => {
  for (const url of [undefined, "  "]) {
    const s = setup(url);
    await s.v.notifier.notify({ kind: "merged", issue: { key: "MET-1" }, part: "MET-2", prs: [] });
    await s.v.checkSummary();
    await s.v.checkSummary();
    await s.v.flush(100);
    assert.equal(
      await s.v.status(),
      "slack: no webhook is saved and HARNESSD_SLACK_WEBHOOK_URL is not set, so harnessd posts no Slack notices or daily summary (docs/INSTALL.md)",
    );
    assert.deepEqual(s.logs, []);
    assert.deepEqual(s.texts, []);
  }
});

test("a webhook url that is not https is refused without echoing it", async () => {
  const s = setup("http://hooks.slack.test/secret-part");
  await s.v.notifier.notify({ kind: "merged", issue: { key: "MET-1" }, part: "MET-2", prs: [] });
  await s.v.flush(100);
  assert.match(await s.v.status(), /is not an https url/);
  assert.doesNotMatch(await s.v.status(), /secret-part/);
  assert.deepEqual(s.texts, []);
});

test("a webhook saved while the daemon runs is used on the next post, with no restart", async () => {
  const s = setup(undefined);
  await s.v.notifier.notify({ kind: "merged", issue: { key: "MET-1" }, part: "MET-2", prs: [] });
  await s.v.flush(100);
  assert.deepEqual(s.texts, []);
  s.set(URL);
  await s.v.notifier.notify({ kind: "merged", issue: { key: "MET-3" }, part: "MET-4", prs: [] });
  await s.v.flush(1000);
  assert.deepEqual(s.texts, ["MET-4 merged: (MET-3)"]);
  s.set(`${URL}-replaced`);
  await s.v.notifier.notify({ kind: "merged", issue: { key: "MET-5" }, part: "MET-6", prs: [] });
  await s.v.flush(1000);
  assert.deepEqual(s.urls, [URL, `${URL}-replaced`]);
  assert.doesNotMatch(s.logs.join("\n"), /fake-token/);
});

test("with a webhook url, notices go to Slack and a due summary goes out", async () => {
  const s = setup(URL);
  assert.equal(
    await s.v.status(),
    "slack: posting notices to #harnessd, daily summary at 21:00 Asia/Kolkata",
  );
  await s.v.notifier.notify({ kind: "merged", issue: { key: "MET-1" }, part: "MET-2", prs: [] });
  await s.v.checkSummary();
  await s.v.flush(1000);
  assert.equal(s.texts.length, 2);
  assert.equal(s.texts[0], "MET-2 merged: (MET-1)");
  assert.match(s.texts[1] ?? "", /^\*harnessd daily summary\* since 18 Nov 21:00/);
  assert.match(s.texts[1] ?? "", /\*Merged \(1\)\*/);
  assert.doesNotMatch([await s.v.status(), ...s.logs].join("\n"), /fake-token/);
});
