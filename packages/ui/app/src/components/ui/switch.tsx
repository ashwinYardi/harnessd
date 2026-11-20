// From shadcn/ui, base-nova registry (MIT; see packages/ui/THIRD_PARTY_NOTICES.md).
// harnessd changes: one size, a 2 px focus ring, and a 200 ms thumb that stops under
// prefers-reduced-motion.
import { Switch as SwitchPrimitive } from "@base-ui/react/switch";
import { cn } from "../../lib/cn.ts";

function Switch({ className, ...props }: SwitchPrimitive.Root.Props) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        "relative inline-flex h-[18px] w-8 shrink-0 cursor-pointer items-center rounded-full border border-transparent outline-none transition-[background-color] duration-200 after:absolute after:-inset-x-3 after:-inset-y-2 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background data-checked:bg-primary data-unchecked:bg-input data-disabled:cursor-not-allowed data-disabled:opacity-64",
        className,
      )}
      data-slot="switch"
      {...props}
    >
      <SwitchPrimitive.Thumb
        className="pointer-events-none block size-4 rounded-full bg-background shadow-sm/5 transition-transform duration-200 data-checked:translate-x-[calc(100%-2px)] data-unchecked:translate-x-0 dark:data-unchecked:bg-muted-foreground"
        data-slot="switch-thumb"
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
