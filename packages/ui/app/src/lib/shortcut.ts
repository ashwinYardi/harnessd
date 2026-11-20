// Keyboard shortcuts, as plain checks on a key event, so they test without a DOM.
import type { View } from "./route.ts";

interface KeyLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** Cmd+K on a Mac, Ctrl+K elsewhere. */
export function isPaletteShortcut(e: KeyLike): boolean {
  return e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey;
}

const GO_TO: Record<string, View> = { b: "board", a: "agents", l: "logs", s: "settings" };

/** The second key of a "G then X" sequence. `prev` is the key pressed just before. */
export function goToView(e: KeyLike, prev: string | undefined): View | undefined {
  if (prev !== "g" || e.metaKey || e.ctrlKey || e.altKey) return undefined;
  return GO_TO[e.key.toLowerCase()];
}

/** True when the key goes into a text field, so single-key shortcuts stay out of the way. */
export function isTypingTarget(
  el: { tagName: string; isContentEditable: boolean } | null,
): boolean {
  if (!el) return false;
  return el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName);
}
