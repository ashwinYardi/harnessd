import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SETTINGS } from "@harnessd/shared";
import { NullNotifier } from "./notifier.ts";
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

function setup(env: NodeJS.ProcessEnv) {
  const logs: string[] = [];
  const texts: string[] = [];
  const fetch: SlackFetch = async (_url, init) => {
    texts.push((JSON.parse(init.body) as { text: string }).text);
    return { ok: true, status: 200 };
  };
  const v = createVisibility({
    env,
    slack: DEFAULT_SETTINGS.slack,
    repoDir: "/nonexistent",
    store: memoryStore({ version: 1, lastSentAt: "2026-11-18T15:30:00.000Z", notices: [] }),
    now: () => new Date("2026-11-20T16:00:00Z"),
    inProgress: () => [{ key: "MET-8" }],
    log: (line) => logs.push(line),
    fetch,
  });
  return { v, logs, texts };
}

test("without a webhook url harnessd keeps NullNotifier and warns once", async () => {
  for (const env of [{}, { HARNESSD_SLACK_WEBHOOK_URL: "  " }]) {
    const s = setup(env);
    assert.equal(s.v.enabled, false);
    assert.ok(s.v.notifier instanceof NullNotifier);
    await s.v.checkSummary();
    await s.v.checkSummary();
    await s.v.flush(100);
    assert.equal(
      s.v.status,
      "slack: HARNESSD_SLACK_WEBHOOK_URL is not set, so harnessd posts no Slack notices or daily summary (docs/INSTALL.md)",
    );
    assert.deepEqual(s.logs, []);
    assert.deepEqual(s.texts, []);
  }
});

test("a webhook url that is not https is refused without echoing it", () => {
  const s = setup({ HARNESSD_SLACK_WEBHOOK_URL: "http://hooks.slack.test/secret-part" });
  assert.equal(s.v.enabled, false);
  assert.match(s.v.status, /is not an https url/);
  assert.doesNotMatch(s.v.status, /secret-part/);
});

test("with a webhook url, notices go to Slack and a due summary goes out", async () => {
  const s = setup({ HARNESSD_SLACK_WEBHOOK_URL: URL });
  assert.equal(s.v.enabled, true);
  assert.equal(
    s.v.status,
    "slack: posting notices to #harnessd, daily summary at 21:00 Asia/Kolkata",
  );
  await s.v.notifier.notify({ kind: "merged", issue: { key: "MET-1" }, part: "MET-2", prs: [] });
  await s.v.checkSummary();
  await s.v.flush(1000);
  assert.equal(s.texts.length, 2);
  assert.equal(s.texts[0], "MET-2 merged: (MET-1)");
  assert.match(s.texts[1] ?? "", /^\*harnessd daily summary\* since 18 Nov 21:00/);
  assert.match(s.texts[1] ?? "", /\*Merged \(1\)\*/);
  assert.doesNotMatch([s.v.status, ...s.logs].join("\n"), /fake-token/);
});
