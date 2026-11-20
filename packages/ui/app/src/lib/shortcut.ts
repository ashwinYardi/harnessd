// Keyboard shortcuts, as plain checks on a key event, so they test without a DOM.

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
