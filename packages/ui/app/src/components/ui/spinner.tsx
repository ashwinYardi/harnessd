// Ported from T3 Code, apps/web/src/components/ui/spinner.tsx (https://github.com/pingdotgg/t3code).
// Copyright (c) 2026 T3 Tools Inc. MIT License; see packages/ui/THIRD_PARTY_NOTICES.md.
// Changes: no i18n hook and no visibility observer; the label is plain text.
import { LoaderCircleIcon } from "lucide-react";
import type * as React from "react";
import { cn } from "../../lib/cn.ts";

function Spinner({ className, ...props }: React.ComponentProps<typeof LoaderCircleIcon>) {
  return (
    <LoaderCircleIcon
      aria-hidden="true"
      className={cn("motion-safe:animate-spin", className)}
      data-slot="spinner"
      {...props}
    />
  );
}

export { Spinner };
