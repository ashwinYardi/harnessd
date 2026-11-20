import assert from "node:assert/strict";
import { test } from "node:test";
import { HARNESSES } from "@harnessd/shared";
import { connectionService, harnessService, SERVICE_IDS, SERVICES } from "./services.ts";

test("every service has a name, a 24-unit path and a license", () => {
  assert.deepEqual([...SERVICE_IDS].sort(), [
    "claude",
    "git",
    "github",
    "linear",
    "openai",
    "slack",
  ]);
  for (const id of SERVICE_IDS) {
    const s = SERVICES[id];
    assert.ok(s.name.length > 0, id);
    assert.match(s.path, /^[Mm][\d.\s,a-zA-Z-]+$/, `${id} has an SVG path`);
    assert.ok(["CC0-1.0", "CC-BY-3.0"].includes(s.license), `${id} license`);
  }
});

test("the git logo carries its CC BY 3.0 credit", () => {
  assert.equal(SERVICES.git.license, "CC-BY-3.0");
  assert.match(SERVICES.git.credit ?? "", /Jason Long/);
});

test("each harness shows its maker's logo: Claude for Claude Code, OpenAI for Codex", () => {
  assert.equal(harnessService("claude-code"), "claude");
  assert.equal(harnessService("codex"), "openai");
  for (const h of HARNESSES) {
    if (h !== "claude-code" && h !== "codex") assert.equal(harnessService(h), undefined, h);
  }
  assert.equal(harnessService("nope"), undefined);
});

test("each service connection shows its logo; port and skills show none", () => {
  assert.equal(connectionService("github"), "github");
  assert.equal(connectionService("linear"), "linear");
  assert.equal(connectionService("slack"), "slack");
  assert.equal(connectionService("git"), "git");
  assert.equal(connectionService("port"), undefined);
  assert.equal(connectionService("skills"), undefined);
});
