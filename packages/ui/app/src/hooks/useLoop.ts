// The loop state (GET /api/loop, then live `loop` events) and the Start action
// (POST /api/start, D-026).
import { useCallback, useEffect, useState } from "react";
import { toast } from "../components/ui/toast.tsx";
import { mergeLoop } from "../lib/limits.ts";
import type { LoopState } from "../lib/route.ts";
import { readLoop, startLoop } from "../setupApi.ts";

export function useLoop() {
  const [loop, setLoop] = useState<LoopState | undefined>();
  const [starting, setStarting] = useState(false);
  const refresh = useCallback(async () => {
    try {
      setLoop(await readLoop());
    } catch {
      // An older daemon has no /api/loop; it runs the loop already.
      setLoop({ state: "running", blocking: [] });
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  /** A live update from the event stream, such as a new set of harness holds (MET-70). */
  const receive = useCallback((next: Partial<LoopState>) => {
    setLoop((prev) => mergeLoop(prev, next));
  }, []);
  const start = useCallback(async () => {
    setStarting(true);
    try {
      setLoop(await startLoop());
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
  }, [refresh]);
  return { loop, starting, start, refresh, receive };
}

export type Loop = ReturnType<typeof useLoop>;
