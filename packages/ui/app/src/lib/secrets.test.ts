import assert from "node:assert/strict";
import { test } from "node:test";
import type { Check } from "./checks.ts";
import { isReference, mergeChecks, secretFor, sourceText } from "./secrets.ts";

test("secretFor maps the Linear and Slack cards to their fixed secret ids", () => {
  assert.equal(secretFor("linear")?.id, "linear.api_key");
  assert.equal(secretFor("slack")?.id, "slack.webhook_url");
  assert.equal(secretFor("github"), undefined);
});

test("sourceText names where a set secret comes from, never a value", () => {
  assert.equal(sourceText({ id: "linear.api_key", set: false, source: null }), "Not set");
  assert.equal(sourceText({ id: "linear.api_key", set: true, source: "saved" }), "Set, saved here");
  assert.equal(
    sourceText({ id: "linear.api_key", set: true, source: "1Password" }),
    "Set, from 1Password",
  );
  assert.equal(
    sourceText({ id: "slack.webhook_url", set: true, source: "env" }),
    "Set, from the environment",
  );
});

test("isReference tells a reference from a pasted value", () => {
  assert.equal(isReference("op://Private/Linear/credential"), true);
  assert.equal(isReference(" env:MY_KEY "), true);
  assert.equal(isReference("lin_api_abc"), false);
  assert.equal(isReference("env:"), false);
});

test("mergeChecks replaces one connection's checks in place and keeps the rest", () => {
  const c = (id: string, state: Check["state"]): Check => ({ id, state, detail: "", fix: "" });
  const all = [c("node", "ok"), c("linear.key", "missing"), c("linear.team", "missing")];
  assert.deepEqual(mergeChecks(all, "linear.", [c("linear.key", "ok"), c("linear.team", "ok")]), [
    c("node", "ok"),
    c("linear.key", "ok"),
    c("linear.team", "ok"),
  ]);
  assert.deepEqual(mergeChecks([c("node", "ok")], "slack.", [c("slack.webhook", "ok")]), [
    c("node", "ok"),
    c("slack.webhook", "ok"),
  ]);
});
