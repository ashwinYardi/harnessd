// From shadcn/ui, base-nova registry (MIT; see packages/ui/THIRD_PARTY_NOTICES.md).
// harnessd changes: sm and default sizes, a mono font option for paths, a 2 px focus ring,
// and the placeholder token, which keeps 4.5:1 in both themes.
import { Input as InputPrimitive } from "@base-ui/react/input";
import type * as React from "react";
import { cn } from "../../lib/cn.ts";

type InputProps = Omit<React.ComponentProps<"input">, "size"> & {
  size?: "sm" | "default";
  font?: "default" | "mono";
};

function Input({ className, size = "default", font = "default", ...props }: InputProps) {
  return (
    <InputPrimitive
      className={cn(
        "h-8 w-full min-w-0 rounded-lg border border-input bg-background px-2.5 text-sm text-foreground shadow-xs/5 outline-none transition-[border-color,box-shadow] duration-150 placeholder:text-placeholder focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/24 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-64 aria-invalid:border-destructive/64 aria-invalid:focus-visible:ring-destructive/16 dark:bg-input/32",
        size === "sm" && "h-7 px-2",
        font === "mono" && "font-mono tabular-nums",
        className,
      )}
      data-size={size}
      data-slot="input"
      {...props}
    />
  );
}

export { Input, type InputProps };
