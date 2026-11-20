// Ported from T3 Code, apps/web/src/components/ui/badge.tsx (https://github.com/pingdotgg/t3code).
// Copyright (c) 2026 T3 Tools Inc. MIT License; see packages/ui/THIRD_PARTY_NOTICES.md.
// Changes: the label variant and control size are left out.
import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/cn.ts";

const badgeVariants = cva(
  "relative inline-flex shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-sm border border-transparent font-medium tabular-nums outline-none [&_svg:not([class*='size-'])]:size-3 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    defaultVariants: { size: "default", variant: "secondary" },
    variants: {
      size: {
        default: "h-4.5 min-w-4.5 px-[calc(--spacing(1)-1px)] text-xs",
        sm: "h-4 min-w-4 rounded-[.25rem] px-[calc(--spacing(1)-1px)] text-2xs leading-none",
        lg: "h-5.5 min-w-5.5 px-[calc(--spacing(1.5)-1px)] text-sm",
      },
      variant: {
        default: "bg-primary text-primary-foreground",
        destructive: "bg-destructive text-white",
        error: "bg-destructive/8 text-destructive-foreground dark:bg-destructive/16",
        info: "bg-info/8 text-info-foreground dark:bg-info/16",
        outline: "border-input bg-background text-foreground dark:bg-input/32",
        secondary: "bg-accent text-secondary-foreground",
        success: "bg-success/8 text-success-foreground dark:bg-success/16",
        warning: "bg-warning/8 text-warning-foreground dark:bg-warning/16",
      },
    },
  },
);

interface BadgeProps extends useRender.ComponentProps<"span"> {
  variant?: VariantProps<typeof badgeVariants>["variant"];
  size?: VariantProps<typeof badgeVariants>["size"];
}

function Badge({ className, variant, size, render, ...props }: BadgeProps) {
  const defaultProps = {
    className: cn(badgeVariants({ className, size, variant })),
    "data-slot": "badge",
  };
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(defaultProps, props),
    render,
  });
}

export { Badge, badgeVariants };
