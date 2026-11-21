// Applies live updates in place, and pins the row under the pointer or focus (lib/pin.ts).
import { type FocusEvent, useCallback, useMemo, useState } from "react";
import { type Group, type PinOptions, pin } from "../lib/pin.ts";

interface Inside {
  pointer: string | null;
  focus: string | null;
}

const OUTSIDE: Inside = { pointer: null, focus: null };

/**
 * `rowProps(key)` goes on each row element. A row pins when the pointer enters it or focus
 * moves into it, so the row under the pointer and the focused row can both be pinned. A row
 * unpins only when both the pointer and focus have left it.
 */
export function usePin<T, G extends Group<T>>(
  next: readonly G[] | undefined,
  key: (row: T) => string,
  options: PinOptions<T> = {},
) {
  const [inside, setInside] = useState<Inside>(OUTSIDE);
  // With no rows on screen, no row can hold the pointer or focus (no leave or blur fires).
  if ((!next || next.length === 0) && (inside.pointer || inside.focus)) setInside(OUTSIDE);
  const pinned = useMemo(
    () => [inside.pointer, inside.focus].filter((k) => k !== null),
    [inside.pointer, inside.focus],
  );

  // Derived from the last render, so a pinned row keeps the slot it had on screen.
  const [state, setState] = useState(() => ({ next, pinned, shown: next && [...next] }));
  let shown = state.shown;
  if (state.next !== next || state.pinned !== pinned) {
    shown = next && pin(state.shown ?? next, next, key, pinned, options);
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

export type RowProps = ReturnType<typeof usePin>["rowProps"];
