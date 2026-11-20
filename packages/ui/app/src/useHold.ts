// Holds live updates while the pointer or focus is inside a region (PRODUCT.md UX rules).
import { type FocusEvent, useCallback, useEffect, useRef, useState } from "react";
import { type Held, held, release, start } from "./lib/hold.ts";

export function useHold<T>(value: T) {
  const [state, setState] = useState<Held<T>>(() => start(value));
  const inside = useRef({ pointer: false, focus: false });

  useEffect(() => {
    const holding = inside.current.pointer || inside.current.focus;
    setState((s) => held(s, value, holding));
  }, [value]);

  const set = useCallback((key: "pointer" | "focus", on: boolean) => {
    inside.current[key] = on;
    if (!inside.current.pointer && !inside.current.focus) setState(release);
  }, []);

  const apply = useCallback(() => setState(release), []);

  const regionProps = {
    onPointerEnter: () => set("pointer", true),
    onPointerLeave: () => set("pointer", false),
    onFocus: () => set("focus", true),
    onBlur: (e: FocusEvent<HTMLElement>) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) set("focus", false);
    },
  };

  return { shown: state.shown, pending: state.pending, apply, regionProps };
}
