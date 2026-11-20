// Ported from T3 Code, apps/web/src/components/ui/skeleton.tsx (https://github.com/pingdotgg/t3code).
// Copyright (c) 2026 T3 Tools Inc. MIT License; see packages/ui/THIRD_PARTY_NOTICES.md.
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "../../lib/cn.ts";

const skeletonVariants = cva("bg-muted-foreground/15 motion-safe:animate-skeleton", {
  variants: { shape: { block: "rounded-sm", card: "rounded-lg", pill: "rounded-full" } },
  defaultVariants: { shape: "block" },
});

function Skeleton({
  className,
  shape,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof skeletonVariants>) {
  return (
    <div
      aria-hidden="true"
      className={cn(skeletonVariants({ shape }), className)}
      data-slot="skeleton"
      {...props}
    />
  );
}

export { Skeleton };
