import assert from "node:assert/strict";
import { test } from "node:test";
import { formatNotice, type Notice, slackNoticeText } from "./notifier.ts";

const parent = { key: "MET-1", url: "https://linear.test/MET-1" };
const pr7 = { number: 7, url: "https://github.test/pull/7" };

const merged: Notice = { kind: "merged", issue: parent, part: "MET-2", prs: [pr7] };
const humanPr: Notice = {
  kind: "needs_human",
  issue: parent,
  part: "MET-2",
  prs: [pr7],
  reason: "touches a protected path",
};
const grill: Notice = {
  kind: "needs_input",
  issue: parent,
  prs: [],
  reason: "secret_or_account",
  detail: "Which workspace?",
};

test("a merge notice links the PR and the issue", () => {
  assert.equal(
    formatNotice(merged),
    "MET-2 merged: PR #7 https://github.test/pull/7 (MET-1 https://linear.test/MET-1)",
  );
});

test("a block notice names the reason, the detail, each PR and the issue", () => {
  assert.equal(
    formatNotice(grill),
    "MET-1 needs input (secret_or_account): Which workspace? https://linear.test/MET-1",
  );
  assert.equal(
    formatNotice(humanPr),
    "MET-2 needs a human (touches a protected path): PR #7 https://github.test/pull/7 (MET-1 https://linear.test/MET-1)",
  );
  assert.equal(
    formatNotice({
      kind: "needs_input",
      issue: parent,
      reason: "secret_or_account",
      prs: [pr7, { number: 8, url: "u8" }],
    }),
    "MET-1 needs input (secret_or_account): PR #7 https://github.test/pull/7 PR #8 u8 https://linear.test/MET-1",
  );
});

test("a notice without an issue url still names the issue", () => {
  assert.equal(
    formatNotice({ ...grill, issue: { key: "MET-9" } }),
    "MET-9 needs input (secret_or_account): Which workspace?",
  );
});

test("the Slack text links the issue and the PR, and escapes the free text", () => {
  assert.equal(
    slackNoticeText(merged),
    "MET-2 merged: <https://github.test/pull/7|PR #7> (<https://linear.test/MET-1|MET-1>)",
  );
  assert.equal(
    slackNoticeText({ ...grill, detail: "Use <b> & <i>?" }),
    "<https://linear.test/MET-1|MET-1> needs input (secret_or_account): Use &lt;b&gt; &amp; &lt;i&gt;?",
  );
  assert.equal(
    slackNoticeText(humanPr),
    "MET-2 needs a human (touches a protected path): <https://github.test/pull/7|PR #7> (<https://linear.test/MET-1|MET-1>)",
  );
});
