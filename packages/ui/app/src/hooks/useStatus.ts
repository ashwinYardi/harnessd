// The status engine's checks (GET /api/status), shared by the sidebar count and Settings.
import { useCallback, useEffect, useState } from "react";
import { type Load, readStatus } from "../api.ts";
import { toast } from "../components/ui/toast.tsx";
import { type Check, isBlocking } from "../lib/checks.ts";

export function useStatus() {
  const [status, setStatus] = useState<Load<Check[]>>({ status: "loading" });
  const [checking, setChecking] = useState(false);
  const load = useCallback(async (announce = false) => {
    setChecking(true);
    try {
      const { checks } = await readStatus();
      setStatus({ status: "ready", data: checks });
      if (announce) {
        const bad = checks.filter(isBlocking).length;
        toast.add(
          bad === 0
            ? { type: "success", title: "All required checks pass" }
            : {
                type: "warning",
                title: `${bad} ${bad === 1 ? "check fails" : "checks fail"}`,
                description: "Each card says how to fix it.",
              },
        );
      }
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e);
      setStatus((s) => (s.status === "ready" ? s : { status: "error", error: text }));
      if (announce) toast.add({ type: "error", title: "Check failed", description: text });
    } finally {
      setChecking(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const recheck = useCallback(() => load(true), [load]);
  const retry = useCallback(() => load(), [load]);
  return { status, checking, recheck, retry };
}

export type Status = ReturnType<typeof useStatus>;
