// Shared pieces of a view: its toolbar row, and its error and empty states.
import { CircleAlertIcon, RotateCwIcon } from "lucide-react";
import type * as React from "react";
import { Button } from "../components/ui/button.tsx";
import { cn } from "../lib/cn.ts";

export function ViewToolbar({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex min-h-10 shrink-0 items-center gap-3 px-4 py-2 text-muted-foreground text-xs",
        className,
      )}
      {...props}
    />
  );
}

export function ErrorState({ text, onRetry }: { text: string; onRetry: () => void }) {
  return (
    <div
      className="m-4 flex items-start gap-3 rounded-xl border border-destructive/30 bg-error-surface p-4"
      role="alert"
    >
      <CircleAlertIcon
        aria-hidden="true"
        className="mt-0.5 size-4 shrink-0 text-destructive-foreground"
      />
      <p className="flex-1 text-sm">{text}</p>
      <Button size="sm" variant="outline" onClick={onRetry}>
        <RotateCwIcon aria-hidden="true" />
        Retry
      </Button>
    </div>
  );
}

export function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <p className="m-4 rounded-xl border border-dashed p-6 text-center text-muted-foreground text-sm">
      {children}
    </p>
  );
}

/** The "Show N updates" button of a region that holds live changes. */
export function HeldUpdates({ pending, onApply }: { pending: number; onApply: () => void }) {
  if (pending === 0) return null;
  return (
    <Button size="xs" variant="secondary" onClick={onApply} className="ms-auto">
      Show {pending} {pending === 1 ? "update" : "updates"}
    </Button>
  );
}
