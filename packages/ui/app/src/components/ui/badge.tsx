// From shadcn/ui, base-nova registry (MIT; see packages/ui/THIRD_PARTY_NOTICES.md).
// harnessd changes: a 4 px radius, three sizes for dense rows, and the state tints
// (error, warning, success, info) that each carry one meaning (DESIGN.md).
import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/cn.ts";

const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden whitespace-nowrap rounded-sm border border-transparent font-medium tabular-nums [&>svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-3",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground",
        secondary: "bg-accent text-secondary-foreground",
        destructive: "bg-destructive text-white",
        outline: "border-input bg-background text-foreground dark:bg-input/32",
        error: "bg-destructive/8 text-destructive-foreground dark:bg-destructive/16",
        warning: "bg-warning/8 text-warning-foreground dark:bg-warning/16",
        success: "bg-success/8 text-success-foreground dark:bg-success/16",
        info: "bg-info/8 text-info-foreground dark:bg-info/16",
      },
      size: {
        default: "h-4.5 min-w-4.5 px-1 text-xs",
        sm: "h-4 min-w-4 px-1 text-2xs leading-none",
        lg: "h-5.5 min-w-5.5 px-1.5 text-sm",
      },
    },
    defaultVariants: { variant: "secondary", size: "default" },
  },
);

function Badge({
  className,
  variant = "secondary",
  size = "default",
  render,
  ...props
}: useRender.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  const defaultProps = {
    className: cn(badgeVariants({ variant, size }), className),
    "data-slot": "badge",
  };
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(defaultProps, props),
    render,
  });
}

export { Badge, badgeVariants };
