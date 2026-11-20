// Small pieces the Settings pages share: a state badge and the check lines of a card.
import {
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { Badge } from "../../components/ui/badge.tsx";
import type { Check } from "../../lib/checks.ts";
import { cn } from "../../lib/cn.ts";
import { isWaiting, secretFix } from "../../lib/setup.ts";

const ICON: Record<Check["state"], React.ReactNode> = {
  ok: <CircleCheckIcon className="text-success-foreground" />,
  warn: <TriangleAlertIcon className="text-warning-foreground" />,
  fail: <CircleAlertIcon className="text-destructive-foreground" />,
  missing: <CircleDashedIcon className="text-destructive-foreground" />,
};

const BADGE: Record<Check["state"], "success" | "warning" | "error"> = {
  ok: "success",
  warn: "warning",
  fail: "error",
  missing: "error",
};

export function StateBadge({
  state,
  children,
}: {
  state: Check["state"];
  children: React.ReactNode;
}) {
  return <Badge variant={BADGE[state]}>{children}</Badge>;
}

export function StateIcon({ state }: { state: Check["state"] }) {
  return (
    <span aria-hidden="true" className="mt-0.5 inline-flex [&_svg]:size-4">
      {ICON[state]}
    </span>
  );
}

/** One check: its id, detail and, when it is not ok, the fix. A secret's fix points at its field. */
export function CheckLine({ check }: { check: Check }) {
  const inline = secretFix(check);
  return (
    <li className="flex items-start gap-2.5 py-2">
      <StateIcon state={check.state} />
      <div className="min-w-0 flex-1 text-sm">
        <p className="flex items-baseline gap-2">
          <span className="font-mono text-xs">{check.id}</span>
          <span className="sr-only">{check.state}</span>
        </p>
        {isWaiting(check) ? (
          <p className="text-pretty text-muted-foreground text-xs">
            Not checked yet. {check.fix.replace(/^Fix (\S+) first\.$/, "It waits on $1.")}
          </p>
        ) : (
          <p className="wrap-anywhere text-pretty text-muted-foreground text-xs">{check.detail}</p>
        )}
        {check.state !== "ok" && !isWaiting(check) && (
          <p
            className={cn(
              "wrap-anywhere mt-0.5 text-pretty text-xs",
              check.state === "warn" ? "text-warning-foreground" : "text-destructive-foreground",
            )}
          >
            Fix: {inline ?? check.fix}
          </p>
        )}
      </div>
    </li>
  );
}
