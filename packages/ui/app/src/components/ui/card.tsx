// A card after T3 Code's SettingsGroup and provider card
// (apps/web/src/components/settings/SettingsGroup.tsx, https://github.com/pingdotgg/t3code).
// Copyright (c) 2026 T3 Tools Inc. MIT License; see packages/ui/THIRD_PARTY_NOTICES.md.
import type * as React from "react";
import { cn } from "../../lib/cn.ts";

function Card({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "relative flex flex-col rounded-xl border bg-card text-card-foreground shadow-xs/5 not-dark:bg-clip-padding",
        className,
      )}
      data-slot="card"
      {...props}
    />
  );
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("flex items-start gap-3 px-4 pt-3.5 pb-3", className)}
      data-slot="card-header"
      {...props}
    />
  );
}

function CardTitle({ className, ...props }: React.ComponentProps<"h3">) {
  return (
    <h3
      className={cn("font-semibold text-sm leading-tight", className)}
      data-slot="card-title"
      {...props}
    />
  );
}

function CardDescription({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      className={cn("text-muted-foreground text-xs", className)}
      data-slot="card-description"
      {...props}
    />
  );
}

function CardPanel({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("px-4 pb-3.5", className)} data-slot="card-panel" {...props} />;
}

function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-b-[calc(var(--radius-xl)-1px)] border-t bg-muted/72 px-4 py-2.5",
        className,
      )}
      data-slot="card-footer"
      {...props}
    />
  );
}

export { Card, CardDescription, CardFooter, CardHeader, CardPanel, CardTitle };
