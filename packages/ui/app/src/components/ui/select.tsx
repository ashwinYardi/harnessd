// From shadcn/ui, base-nova registry (MIT; see packages/ui/THIRD_PARTY_NOTICES.md).
// harnessd changes: the popup opens below the trigger, not over it; no scroll arrows; a soft
// drop shadow; 100 ms enter and exit through Base UI's starting and ending styles; the
// placeholder token; and a 2 px focus ring.
import { Select as SelectPrimitive } from "@base-ui/react/select";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { cn } from "../../lib/cn.ts";

const Select = SelectPrimitive.Root;

function SelectValue({ className, ...props }: SelectPrimitive.Value.Props) {
  return (
    <SelectPrimitive.Value
      className={cn(
        "flex min-w-0 flex-1 items-center gap-1.5 truncate text-left data-placeholder:text-placeholder",
        className,
      )}
      data-slot="select-value"
      {...props}
    />
  );
}

function SelectTrigger({
  className,
  size = "default",
  children,
  ...props
}: SelectPrimitive.Trigger.Props & { size?: "sm" | "default" }) {
  return (
    <SelectPrimitive.Trigger
      className={cn(
        "flex w-full min-w-36 cursor-pointer select-none items-center justify-between gap-1.5 whitespace-nowrap rounded-lg border border-input bg-background pr-2 pl-2.5 text-sm text-foreground shadow-xs/5 outline-none transition-[border-color,box-shadow] duration-150 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/24 data-disabled:cursor-not-allowed data-disabled:opacity-64 aria-invalid:border-destructive/64 data-[size=default]:h-8 data-[size=sm]:h-7 dark:bg-input/32 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      data-size={size}
      data-slot="select-trigger"
      {...props}
    >
      {children}
      <SelectPrimitive.Icon
        render={<ChevronDownIcon className="pointer-events-none size-3.5 text-muted-foreground" />}
      />
    </SelectPrimitive.Trigger>
  );
}

function SelectContent({
  className,
  children,
  sideOffset = 4,
  ...props
}: SelectPrimitive.Popup.Props & Pick<SelectPrimitive.Positioner.Props, "sideOffset">) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Positioner
        alignItemWithTrigger={false}
        className="isolate z-50"
        sideOffset={sideOffset}
      >
        <SelectPrimitive.Popup
          className={cn(
            "relative max-h-(--available-height) w-(--anchor-width) min-w-36 origin-(--transform-origin) overflow-y-auto rounded-lg border bg-popover p-1 text-popover-foreground shadow-[0_16px_40px_-18px_rgb(0_0_0/35%)] outline-none not-dark:bg-clip-padding transition-[scale,opacity] duration-100 ease-out data-ending-style:scale-98 data-ending-style:opacity-0 data-starting-style:scale-98 data-starting-style:opacity-0 dark:shadow-[0_18px_44px_-18px_rgb(0_0_0/80%)]",
            className,
          )}
          data-slot="select-content"
          {...props}
        >
          <SelectPrimitive.List>{children}</SelectPrimitive.List>
        </SelectPrimitive.Popup>
      </SelectPrimitive.Positioner>
    </SelectPrimitive.Portal>
  );
}

function SelectItem({ className, children, ...props }: SelectPrimitive.Item.Props) {
  return (
    <SelectPrimitive.Item
      className={cn(
        "relative flex min-h-7 w-full cursor-pointer select-none items-center gap-1.5 rounded-md py-1 pr-8 pl-2 text-sm outline-hidden data-disabled:pointer-events-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:opacity-64 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
        className,
      )}
      data-slot="select-item"
      {...props}
    >
      <SelectPrimitive.ItemText className="flex min-w-0 flex-1 items-center gap-1.5">
        {children}
      </SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator
        render={<span className="absolute right-2 flex size-4 items-center justify-center" />}
      >
        <CheckIcon className="text-primary" />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  );
}

export { Select, SelectContent, SelectItem, SelectTrigger, SelectValue };
