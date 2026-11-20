import assert from "node:assert/strict";
import { test } from "node:test";
import { held, release, start } from "./hold.ts";

test("while held, new values wait and are counted; release shows the latest", () => {
  let s = start("a");
  s = held(s, "b", false);
  assert.deepEqual(s, { shown: "b", latest: "b", pending: 0 });
  s = held(s, "c", true);
  s = held(s, "d", true);
  assert.deepEqual(s, { shown: "b", latest: "d", pending: 2 });
  s = release(s);
  assert.deepEqual(s, { shown: "d", latest: "d", pending: 0 });
});

test("a value equal to the one shown is not counted as pending", () => {
  let s = start({ n: 1 });
  s = held(s, { n: 1 }, true);
  assert.equal(s.pending, 0);
  s = held(s, { n: 2 }, true);
  s = held(s, { n: 1 }, true);
  assert.equal(s.pending, 0, "back to what is shown");
});

test("the first value is shown at once, even while held", () => {
  const s = held(start<string | undefined>(undefined), "board", true);
  assert.deepEqual(s, { shown: "board", latest: "board", pending: 0 });
});
