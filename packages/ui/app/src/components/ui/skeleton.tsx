// From shadcn/ui, base-nova registry (MIT; see packages/ui/THIRD_PARTY_NOTICES.md).
// harnessd changes: three shapes, aria-hidden, and a stepped pulse (index.css) that stops
// under prefers-reduced-motion.
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
