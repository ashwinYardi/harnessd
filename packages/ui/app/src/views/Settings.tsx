// Settings, first step: the status engine's checks, read-only (D-023). MET-28 adds the
// Harnesses, Connections and Team pages with their actions.
import {
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  RotateCwIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { type Load, readStatus } from "../api.ts";
import { Badge } from "../components/ui/badge.tsx";
import { Button } from "../components/ui/button.tsx";
import { Card } from "../components/ui/card.tsx";
import { ScrollArea } from "../components/ui/scroll-area.tsx";
import { Skeleton } from "../components/ui/skeleton.tsx";
import { Spinner } from "../components/ui/spinner.tsx";
import { toast } from "../components/ui/toast.tsx";
import { type Check, isBlocking, sortChecks } from "../lib/checks.ts";
import { cn } from "../lib/cn.ts";
import { EmptyState, ErrorState, ViewToolbar } from "./common.tsx";

const STATE: Record<
  Check["state"],
  { label: string; icon: React.ReactNode; badge: "success" | "warning" | "error" }
> = {
  ok: {
    label: "OK",
    icon: <CircleCheckIcon className="text-success-foreground" />,
    badge: "success",
  },
  warn: {
    label: "Warn",
    icon: <TriangleAlertIcon className="text-warning-foreground" />,
    badge: "warning",
  },
  fail: {
    label: "Fail",
    icon: <CircleAlertIcon className="text-destructive-foreground" />,
    badge: "error",
  },
  missing: {
    label: "Missing",
    icon: <CircleDashedIcon className="text-destructive-foreground" />,
    badge: "error",
  },
};

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
            ? { type: "success", title: "All checks pass" }
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
  return { status, checking, recheck: () => load(true), retry: () => load() };
}

export function Settings({ status }: { status: ReturnType<typeof useStatus> }) {
  const { status: s, checking, recheck, retry } = status;
  return (
    <section
      aria-busy={s.status === "loading"}
      aria-label="Settings"
      className="flex min-h-0 flex-1 flex-col"
    >
      <ViewToolbar>
        <span>The same checks as harnessd doctor.</span>
        <Button
          className="ms-auto"
          disabled={checking}
          onClick={recheck}
          size="sm"
          variant="outline"
        >
          {checking ? <Spinner /> : <RotateCwIcon aria-hidden="true" />}
          Check again
        </Button>
      </ViewToolbar>
      {s.status === "loading" && (
        <div className="flex flex-col gap-2 px-4" aria-hidden="true">
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton className="h-14" shape="card" key={i} />
          ))}
        </div>
      )}
      {s.status === "error" && (
        <ErrorState onRetry={retry} text={`Could not run the checks. ${s.error}`} />
      )}
      {s.status === "ready" && s.data.length === 0 && <EmptyState>No checks ran.</EmptyState>}
      {s.status === "ready" && s.data.length > 0 && (
        <ScrollArea className="min-h-0 flex-1">
          <div className="mx-auto max-w-3xl px-4 pb-6">
            <Card className="divide-y overflow-hidden">
              {sortChecks(s.data).map((c) => {
                const st = STATE[c.state];
                return (
                  <div className="flex items-start gap-3 px-4 py-3" key={c.id}>
                    <span className="mt-0.5 [&_svg]:size-4" aria-hidden="true">
                      {st.icon}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-2">
                        <span className="font-medium font-mono text-sm">{c.id}</span>
                        {c.state === "ok" && <span className="sr-only">OK</span>}
                        {c.state !== "ok" && (
                          <Badge size="sm" variant={st.badge}>
                            {st.label}
                          </Badge>
                        )}
                      </p>
                      <p className="wrap-anywhere text-muted-foreground text-xs">{c.detail}</p>
                      {c.state !== "ok" && c.fix && (
                        <p
                          className={cn(
                            "wrap-anywhere mt-1 text-xs",
                            c.state === "warn"
                              ? "text-warning-foreground"
                              : "text-destructive-foreground",
                          )}
                        >
                          Fix: {c.fix}
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}
            </Card>
          </div>
        </ScrollArea>
      )}
    </section>
  );
}
