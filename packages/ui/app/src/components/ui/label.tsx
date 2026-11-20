// Ported from T3 Code, apps/web/src/components/ui/label.tsx (https://github.com/pingdotgg/t3code).
// Copyright (c) 2026 T3 Tools Inc. MIT License; see packages/ui/THIRD_PARTY_NOTICES.md.
import type * as React from "react";
import { cn } from "../../lib/cn.ts";

function Label({ className, ...props }: React.ComponentProps<"label">) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: callers pass htmlFor or nest the control
    <label
      className={cn(
        "inline-flex items-center gap-2 font-medium text-sm text-foreground",
        className,
      )}
      data-slot="label"
      {...props}
    />
  );
}

export { Label };
