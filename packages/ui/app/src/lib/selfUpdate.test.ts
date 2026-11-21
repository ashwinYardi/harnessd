import assert from "node:assert/strict";
import { test } from "node:test";
import { type SelfUpdate, selfUpdateLine } from "./selfUpdate.ts";

const FROM = "1a2b3c4d5e6f7a8b9c0d";
const TO = "5d6e7f8a9b0c1d2e3f4a";
// A local time, so the clock reads 14:02 in any time zone.
const AT = new Date(2026, 10, 21, 14, 2, 30).toISOString();
const at = (state: SelfUpdate["state"]): SelfUpdate => ({ from: FROM, to: TO, at: AT, state });

test("selfUpdateLine is undefined when the loop has no self-update", () => {
  assert.equal(selfUpdateLine(undefined), undefined);
});

test("selfUpdateLine names a done update with both commits and the local time", () => {
  assert.deepEqual(selfUpdateLine(at("done")), {
    label: "Updated",
    from: "1a2b3c4",
    to: "5d6e7f8",
    time: "14:02",
  });
});

test("selfUpdateLine names a pending or applying update without a time", () => {
  for (const state of ["pending", "applying"] as const) {
    assert.deepEqual(selfUpdateLine(at(state)), {
      label: "Update pending",
      from: "1a2b3c4",
      to: "5d6e7f8",
      time: undefined,
    });
  }
});

test("selfUpdateLine shows only the commits for a failed or blocked update", () => {
  for (const state of ["failed", "blocked"] as const) {
    assert.deepEqual(selfUpdateLine({ ...at(state), error: "build failed" }), {
      label: undefined,
      from: "1a2b3c4",
      to: "5d6e7f8",
      time: undefined,
    });
  }
});

test("selfUpdateLine cuts each commit id to 7 characters and keeps short ids", () => {
  const line = selfUpdateLine({ ...at("done"), from: "abc", to: "0123456789" });
  assert.equal(line?.from, "abc");
  assert.equal(line?.to, "0123456");
});

test("selfUpdateLine drops the time when the daemon sends a bad date", () => {
  assert.equal(selfUpdateLine({ ...at("done"), at: "not a date" })?.time, undefined);
});
