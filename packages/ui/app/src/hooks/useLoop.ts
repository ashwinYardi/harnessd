// The loop state (GET /api/loop, then live `loop` events) and the Start action
// (POST /api/start, D-026).
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "../components/ui/toast.tsx";
import { applyLiveLoop, applyLoopRead, emptyLoop } from "../lib/limits.ts";
import type { LoopState } from "../lib/route.ts";
import { readLoop, startLoop } from "../setupApi.ts";

export function useLoop() {
  const [store, setStore] = useState(emptyLoop);
  const [starting, setStarting] = useState(false);
  // Counts live updates, so a read that lands late does not undo a newer one (MET-70).
  const seq = useRef(0);
  const land = useCallback((read: LoopState, sentAt: number) => {
    setStore((s) => applyLoopRead(s, read, sentAt));
  }, []);
  const refresh = useCallback(async () => {
    const sentAt = seq.current;
    try {
      land(await readLoop(), sentAt);
    } catch {
      // An older daemon has no /api/loop; it runs the loop already.
      land({ state: "running", blocking: [] }, sentAt);
    }
  }, [land]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  /** A live update from the event stream, such as a new set of harness holds (MET-70). */
  const applyLive = useCallback((next: Partial<LoopState>) => {
    seq.current += 1;
    const at = seq.current;
    setStore((s) => applyLiveLoop(s, next, at));
  }, []);
  const start = useCallback(async () => {
    setStarting(true);
    const sentAt = seq.current;
    try {
      land(await startLoop(), sentAt);
      toast.add({
        type: "success",
        title: "Loop started",
        description: "Ready issues are picked up now.",
      });
    } catch (e) {
      toast.add({
        type: "error",
        title: "Not started",
        description: e instanceof Error ? e.message : String(e),
        priority: "high",
      });
      await refresh();
    } finally {
      setStarting(false);
    }
  }, [refresh, land]);
  return { loop: store.loop, starting, start, refresh, applyLive };
}

export type Loop = ReturnType<typeof useLoop>;
