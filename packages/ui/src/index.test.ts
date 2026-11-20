import assert from "node:assert/strict";
import { test } from "node:test";
import { UI_DIR, UI_PACKAGE } from "./index.ts";

test("ui package is named", () => {
  assert.equal(UI_PACKAGE, "@harnessd/ui");
});

test("UI_DIR is the app folder next to the entry", () => {
  assert.match(UI_DIR, /[/\\]app[/\\]$/);
});
