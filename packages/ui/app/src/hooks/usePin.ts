// Applies live updates in place, and pins the row under the pointer or focus (lib/pin.ts).
import { type FocusEvent, useCallback, useState } from "react";
import { type Group, pin } from "../lib/pin.ts";

interface Inside {
  pointer: string | null;
  focus: string | null;
}

/**
 * `key` must be stable (a module-level function). `rowProps(key)` goes on each row element.
 * A row pins when the pointer enters it or focus moves into it. It unpins only when both
 * the pointer and focus have left it.
 */
export function usePin<T, G extends Group<T>>(
  next: readonly G[] | undefined,
  key: (row: T) => string,
) {
  const [inside, setInside] = useState<Inside>({ pointer: null, focus: null });
  const pinned = inside.pointer ?? inside.focus;

  // Derived from the last render, so a pinned row keeps the slot it had on screen.
  const [state, setState] = useState(() => ({ next, pinned, shown: next && [...next] }));
  let shown = state.shown;
  if (state.next !== next || state.pinned !== pinned) {
    shown = next && pin(state.shown ?? next, next, key, pinned);
    setState({ next, pinned, shown });
  }

  const rowProps = useCallback(
    (k: string) => ({
      onPointerEnter: () => setInside((s) => ({ ...s, pointer: k })),
      onPointerLeave: () => setInside((s) => (s.pointer === k ? { ...s, pointer: null } : s)),
      onFocus: () => setInside((s) => (s.focus === k ? s : { ...s, focus: k })),
      onBlur: (e: FocusEvent<HTMLElement>) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setInside((s) => (s.focus === k ? { ...s, focus: null } : s));
      },
    }),
    [],
  );

  return { shown, rowProps };
}
