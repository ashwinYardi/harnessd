// The kill switch (D-014). The click changes the shown state at once; the daemon's answer
// confirms it, a failure rolls it back, and a toast reports each result.
import { useCallback, useEffect, useRef, useState } from "react";
import { type Load, pauseAll, resumeAll } from "../api.ts";
import { toast } from "../components/ui/toast.tsx";
import {
  type PauseState,
  pauseFailed,
  pauseSettled,
  pauseStarted,
  pauseView,
} from "../lib/pause.ts";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function usePause(load: Load<PauseState>, setLoad: (p: Load<PauseState>) => void) {
  const live = load.status === "ready" ? load.data : undefined;
  const [view, setView] = useState(() => pauseView(live));
  const viewRef = useRef(view);
  viewRef.current = view;

  useEffect(() => {
    setView((v) => pauseView(live, v));
  }, [live]);

  const toggle = useCallback(async () => {
    const current = viewRef.current;
    if (current.busy) return;
    if (current.shown.paused) {
      setView(pauseStarted(current, "resume"));
      try {
        const state = await resumeAll();
        setView((v) => pauseSettled(v, state));
        setLoad({ status: "ready", data: state });
        toast.add({ type: "success", title: "Resumed", description: "The loop dispatches again." });
      } catch (e) {
        setView(pauseFailed);
        toast.add({
          type: "error",
          title: "Resume failed",
          description: `${message(e)} Still paused.`,
        });
      }
    } else {
      setView(pauseStarted(current, "pause"));
      try {
        const { cancelled, ...state } = await pauseAll();
        setView((v) => pauseSettled(v, state));
        setLoad({ status: "ready", data: state });
        toast.add({
          type: "success",
          title: "Paused",
          description: `${cancelled} ${cancelled === 1 ? "run" : "runs"} stopped. Worktrees kept.`,
        });
      } catch (e) {
        setView(pauseFailed);
        toast.add({
          type: "error",
          title: "Pause failed",
          description: `${message(e)} The agents still run. Try again.`,
          priority: "high",
        });
      }
    }
  }, [setLoad]);

  return { view, toggle, unknown: load.status === "error" ? load.error : undefined };
}
