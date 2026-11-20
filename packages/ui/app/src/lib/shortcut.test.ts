import assert from "node:assert/strict";
import { test } from "node:test";
import { goToView, isPaletteShortcut, isTypingTarget } from "./shortcut.ts";

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

test("G then B, A, L or S goes to a view; other keys and stale sequences do not", () => {
  const plain = (k: string) => key(k);
  assert.equal(goToView(plain("b"), "g"), "board");
  assert.equal(goToView(plain("a"), "g"), "agents");
  assert.equal(goToView(plain("l"), "g"), "logs");
  assert.equal(goToView(plain("s"), "g"), "settings");
  assert.equal(goToView(plain("x"), "g"), undefined);
  assert.equal(goToView(plain("b"), undefined), undefined);
  assert.equal(goToView(key("b", { metaKey: true }), "g"), undefined);
});

test("typing in a field never starts a shortcut", () => {
  assert.equal(isTypingTarget({ tagName: "INPUT", isContentEditable: false }), true);
  assert.equal(isTypingTarget({ tagName: "TEXTAREA", isContentEditable: false }), true);
  assert.equal(isTypingTarget({ tagName: "DIV", isContentEditable: true }), true);
  assert.equal(isTypingTarget({ tagName: "BUTTON", isContentEditable: false }), false);
  assert.equal(isTypingTarget(null), false);
});
