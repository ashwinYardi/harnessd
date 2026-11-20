// Ported from T3 Code, apps/web/src/components/ui/input.tsx (https://github.com/pingdotgg/t3code).
// Copyright (c) 2026 T3 Tools Inc. MIT License; see packages/ui/THIRD_PARTY_NOTICES.md.
// Changes: a native input only; sizes sm and default; mono font option kept.
import type * as React from "react";
import { cn } from "../../lib/cn.ts";

type InputProps = Omit<React.ComponentProps<"input">, "size"> & {
  size?: "sm" | "default";
  font?: "default" | "mono";
};

function Input({ className, size = "default", font = "default", ...props }: InputProps) {
  return (
    <span
      className={cn(
        "relative inline-flex w-full rounded-lg border border-input bg-background not-dark:bg-clip-padding text-sm text-foreground shadow-xs/5 ring-ring/24 transition-shadow before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] not-has-disabled:not-has-focus-visible:not-has-aria-invalid:before:shadow-[0_1px_--theme(--color-black/4%)] has-focus-visible:border-ring has-focus-visible:ring-[3px] has-focus-visible:ring-inset has-aria-invalid:border-destructive/36 has-focus-visible:has-aria-invalid:border-destructive/64 has-focus-visible:has-aria-invalid:ring-destructive/16 has-disabled:opacity-64 has-[:disabled,:focus-visible,[aria-invalid]]:shadow-none dark:bg-input/32",
        font === "mono" && "font-mono tabular-nums",
        className,
      )}
      data-size={size}
      data-slot="input-control"
    >
      <input
        className={cn(
          "h-7.5 w-full min-w-0 rounded-[inherit] bg-transparent px-[calc(--spacing(3)-1px)] leading-7.5 outline-none placeholder:text-placeholder",
          size === "sm" && "h-6.5 px-[calc(--spacing(2.5)-1px)] leading-6.5",
        )}
        data-slot="input"
        {...props}
      />
    </span>
  );
}

export { Input, type InputProps };
