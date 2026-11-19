import assert from "node:assert/strict";
import { test } from "node:test";
import { HARNESSES, isHarnessId, VERSION } from "./index.ts";

test("VERSION is semver", () => {
  assert.match(VERSION, /^\d+\.\d+\.\d+/);
});

test("isHarnessId accepts known harnesses only", () => {
  for (const id of HARNESSES) assert.equal(isHarnessId(id), true);
  assert.equal(isHarnessId("vim"), false);
});
