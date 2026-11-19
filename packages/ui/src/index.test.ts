import assert from "node:assert/strict";
import { test } from "node:test";
import { UI_PACKAGE } from "./index.ts";

test("ui package is named", () => {
  assert.equal(UI_PACKAGE, "@harnessd/ui");
});
