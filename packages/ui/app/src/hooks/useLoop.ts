// The loop state (GET /api/loop) and the Start action (POST /api/start, D-026).
import { useCallback, useEffect, useState } from "react";
import { toast } from "../components/ui/toast.tsx";
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
  return { loop, starting, start, refresh };
}

export type Loop = ReturnType<typeof useLoop>;
