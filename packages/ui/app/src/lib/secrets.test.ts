import assert from "node:assert/strict";
import { test } from "node:test";
import type { Check } from "./checks.ts";
import { isReference, mergeChecks, savedToast, secretFor, sourceText } from "./secrets.ts";

test("secretFor maps the Linear and Slack cards to their fixed secret ids", () => {
  assert.equal(secretFor("linear")?.id, "linear.api_key");
  assert.equal(secretFor("slack")?.id, "slack.webhook_url");
  assert.equal(secretFor("github"), undefined);
});

test("sourceText names where a set secret comes from, never a value", () => {
  assert.equal(
    sourceText({ id: "linear.api_key", set: false, source: null, stored: false }),
    "Not set",
  );
  assert.equal(
    sourceText({ id: "linear.api_key", set: true, source: "saved", stored: true }),
    "Set, saved here",
  );
  assert.equal(
    sourceText({ id: "linear.api_key", set: true, source: "1Password", stored: true }),
    "Set, from 1Password",
  );
  assert.equal(
    sourceText({ id: "slack.webhook_url", set: true, source: "env", stored: false }),
    "Set, from the environment",
  );
});

test("isReference tells a reference from a pasted value", () => {
  assert.equal(isReference("op://Private/Linear/credential"), true);
  assert.equal(isReference(" env:MY_KEY "), true);
  assert.equal(isReference("lin_api_abc"), false);
  assert.equal(isReference("env:"), false);
  // Matches the daemon: op:// needs vault, item and field.
  assert.equal(isReference("op://only-vault"), false);
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

test("savedToast is an error when a re-run check blocks, and names its detail", () => {
  const c = (state: Check["state"], detail: string): Check => ({
    id: "linear.key",
    state,
    detail,
    fix: "",
  });
  assert.deepEqual(
    savedToast("Linear", "API key", "saved", [c("fail", "Linear rejected the key (saved)")]),
    {
      type: "error",
      title: "Linear API key saved",
      description: "Linear rejected the key (saved)",
    },
  );
  assert.deepEqual(savedToast("Slack", "Webhook URL", "removed", [c("warn", "no webhook")]), {
    type: "warning",
    title: "Slack Webhook URL removed",
    description: "no webhook",
  });
  assert.equal(
    savedToast("Linear", "API key", "saved", [c("ok", "accepted")]).description,
    "Linear checks pass.",
  );
});
