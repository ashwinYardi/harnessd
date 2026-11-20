import assert from "node:assert/strict";
import { test } from "node:test";
import { isPaletteShortcut } from "./shortcut.ts";

const key = (
  k: string,
  mods: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>> = {},
) => ({
  key: k,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

test("Cmd+K and Ctrl+K open the command palette", () => {
  assert.equal(isPaletteShortcut(key("k", { metaKey: true })), true);
  assert.equal(isPaletteShortcut(key("K", { ctrlKey: true })), true);
});

test("K alone, or with Shift or Alt, does not", () => {
  assert.equal(isPaletteShortcut(key("k")), false);
  assert.equal(isPaletteShortcut(key("k", { metaKey: true, shiftKey: true })), false);
  assert.equal(isPaletteShortcut(key("k", { ctrlKey: true, altKey: true })), false);
  assert.equal(isPaletteShortcut(key("j", { metaKey: true })), false);
});
