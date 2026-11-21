import assert from "node:assert/strict";
import { test } from "node:test";
import type { Job, OpencodeProvider } from "../setupApi.ts";
import { jobKey, modelField, providerList, providerRow } from "./opencode.ts";

const provider = (over: Partial<OpencodeProvider> = {}): OpencodeProvider => ({
  id: "deepseek",
  signedIn: false,
  required: true,
  command: "opencode auth login -- deepseek",
  ...over,
});

const job = (over: Partial<Job> = {}): Job => ({
  id: "j1",
  harness: "opencode",
  action: "signin",
  command: "opencode auth login --standalone -- deepseek",
  state: "running",
  lines: [],
  startedAt: "2026-11-21T10:00:00.000Z",
  provider: "deepseek",
  ...over,
});

test("jobKey keeps a provider sign-in apart from the card's own job", () => {
  assert.equal(jobKey(job()), "opencode:deepseek");
  assert.equal(jobKey({ harness: "opencode" }), "opencode");
  assert.equal(jobKey({ harness: "codex" }), "codex");
});

test("providerRow: a signed-in provider is ok and offers no sign-in", () => {
  const r = providerRow(provider({ signedIn: true }), undefined);
  assert.equal(r.tone, "ok");
  assert.equal(r.status, "Signed in");
  assert.equal(r.canSignIn, false);
  assert.equal(r.manual, undefined);
});

test("providerRow: a required provider that is signed out is red; an extra one is amber", () => {
  assert.equal(providerRow(provider(), undefined).tone, "fail");
  assert.equal(providerRow(provider({ required: false }), undefined).tone, "warn");
  assert.equal(providerRow(provider(), undefined).status, "Not signed in");
  assert.equal(providerRow(provider(), undefined).canSignIn, true);
});

test("providerRow: while the sign-in runs, it shows the https link and the code", () => {
  const r = providerRow(provider(), job({ url: "https://auth.example.com/d", code: "ABCD-EFGH" }));
  assert.equal(r.busy, true);
  assert.equal(r.status, "Signing in");
  assert.equal(r.link?.href, "https://auth.example.com/d");
  assert.equal(r.code, "ABCD-EFGH");
  assert.equal(r.manual, undefined);
  assert.equal(providerRow(provider(), job({ url: "http://x.example.com" })).link, undefined);
});

test("providerRow: a sign-in that waits for a typed key ends with the job's command to copy", () => {
  const manual = "opencode auth login -- deepseek";
  const r = providerRow(provider(), job({ state: "failed", exitCode: 1, manual }));
  assert.equal(r.busy, false);
  assert.equal(r.manual, manual);
  assert.equal(r.link, undefined);
  assert.equal(r.canSignIn, true);
});

test("providerRow: a failed sign-in with no manual falls back to the provider's command", () => {
  const r = providerRow(provider(), job({ state: "failed", exitCode: 1 }));
  assert.equal(r.manual, "opencode auth login -- deepseek");
});

test("providerRow: once the recheck says signed in, the old job shows nothing", () => {
  const r = providerRow(provider({ signedIn: true }), job({ state: "failed", manual: "x" }));
  assert.equal(r.manual, undefined);
  assert.equal(r.tone, "ok");
});

test("providerRow ignores a job of another provider", () => {
  const r = providerRow(provider(), job({ provider: "openrouter", url: "https://a.example.com" }));
  assert.equal(r.busy, false);
  assert.equal(r.link, undefined);
});

test("providerList: loading, error, empty and ready", () => {
  assert.deepEqual(providerList({ status: "loading" }), { kind: "loading" });
  assert.deepEqual(providerList({ status: "error", error: "down" }), {
    kind: "error",
    text: "down",
  });
  assert.deepEqual(providerList({ status: "ready", data: { providers: [] } }), {
    kind: "empty",
    note: undefined,
  });
  const p = provider();
  assert.deepEqual(
    providerList({ status: "ready", data: { providers: [p], reason: "could not read" } }),
    { kind: "ready", providers: [p], note: "could not read" },
  );
});

test("providerList puts required providers first, then by id", () => {
  const out = providerList({
    status: "ready",
    data: {
      providers: [
        provider({ id: "zai", required: false }),
        provider({ id: "openrouter" }),
        provider({ id: "anthropic", required: false }),
        provider({ id: "deepseek" }),
      ],
    },
  });
  assert.equal(out.kind, "ready");
  if (out.kind === "ready") {
    assert.deepEqual(
      out.providers.map((p) => p.id),
      ["deepseek", "openrouter", "anthropic", "zai"],
    );
  }
});

test("modelField suggests nothing and says nothing for another harness", () => {
  assert.deepEqual(modelField("claude-code", { status: "ready", data: { models: ["a/b"] } }), {
    suggestions: [],
    help: undefined,
  });
});

test("modelField suggests the listed ids for an opencode row", () => {
  assert.deepEqual(
    modelField("opencode", { status: "ready", data: { models: ["deepseek/deepseek-chat"] } }),
    { suggestions: ["deepseek/deepseek-chat"], help: undefined },
  );
});

test("modelField stays free text with one help line when the list is empty or fails", () => {
  const empty = modelField("opencode", { status: "ready", data: { models: [], reason: "x" } });
  assert.deepEqual(empty.suggestions, []);
  assert.match(empty.help ?? "", /<provider>\/<model>/);
  const failed = modelField("opencode", { status: "error", error: "down" });
  assert.deepEqual(failed.suggestions, []);
  assert.equal(failed.help, empty.help);
});

test("modelField shows no help while the list loads", () => {
  assert.deepEqual(modelField("opencode", { status: "loading" }), {
    suggestions: [],
    help: undefined,
  });
});
