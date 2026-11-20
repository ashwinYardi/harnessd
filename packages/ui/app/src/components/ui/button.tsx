// From shadcn/ui, base-nova registry (MIT; see packages/ui/THIRD_PARTY_NOTICES.md).
// harnessd changes: a solid destructive fill for Needs you, the warning-outline and ghost-muted
// variants, a 2 px focus ring, a 0.97 press, 150 ms motion and a 44 px hit area on touch.
import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/cn.ts";

const buttonVariants = cva(
  "relative inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-[var(--control-radius)] border border-transparent bg-clip-padding font-medium text-sm outline-none select-none transition-[background-color,border-color,color,box-shadow,scale] duration-150 ease-out focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background [&:active:not([aria-haspopup]):not(:disabled):not([aria-disabled=true])]:scale-[0.97] disabled:pointer-events-none disabled:opacity-64 aria-disabled:cursor-not-allowed aria-disabled:opacity-64 aria-invalid:border-destructive pointer-coarse:after:absolute pointer-coarse:after:top-1/2 pointer-coarse:after:left-1/2 pointer-coarse:after:size-full pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 pointer-coarse:after:-translate-1/2 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground shadow-xs hover:bg-primary/90",
        destructive: "bg-destructive text-white shadow-xs hover:bg-destructive/90",
        outline:
          "border-input bg-popover text-foreground shadow-xs/5 hover:bg-accent/50 dark:bg-input/32 dark:hover:bg-input/64",
        "warning-outline":
          "border-warning/32 bg-warning-surface text-warning-foreground hover:border-warning/40 hover:bg-warning/16",
        secondary: "bg-secondary text-secondary-foreground hover:bg-accent",
        ghost: "text-foreground hover:bg-accent [&_svg]:text-muted-foreground",
        "ghost-muted": "text-muted-foreground hover:bg-accent hover:text-foreground",
        link: "text-foreground underline-offset-4 hover:underline",
      },
      size: {
        default: "h-8 px-2.5",
        sm: "h-7 gap-1 px-2.5",
        xs: "h-6 gap-1 px-2 text-xs [&_svg:not([class*='size-'])]:size-3.5",
        icon: "size-8",
        "icon-sm": "size-7",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

type ButtonVariant = NonNullable<VariantProps<typeof buttonVariants>["variant"]>;
type ButtonSize = NonNullable<VariantProps<typeof buttonVariants>["size"]>;

function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      className={cn(buttonVariants({ variant, size, className }))}
      data-slot="button"
      {...props}
    />
  );
}

export { Button, type ButtonSize, type ButtonVariant, buttonVariants };
