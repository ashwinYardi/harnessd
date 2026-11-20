// Ported from T3 Code, apps/web/src/components/ui/select.tsx (https://github.com/pingdotgg/t3code).
// Copyright (c) 2026 T3 Tools Inc. MIT License; see packages/ui/THIRD_PARTY_NOTICES.md.
// Changes: no glass popup (a solid popover with a soft shadow), no scroll arrows, no SelectButton.
import { Select as SelectPrimitive } from "@base-ui/react/select";
import { cva, type VariantProps } from "class-variance-authority";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { cn } from "../../lib/cn.ts";

const Select = SelectPrimitive.Root;

const selectTriggerVariants = cva(
  "relative inline-flex cursor-pointer select-none items-center justify-between gap-2 rounded-lg border text-left text-sm outline-none transition-[color,box-shadow,background-color] data-disabled:pointer-events-none data-disabled:opacity-64 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    defaultVariants: { size: "default" },
    variants: {
      size: {
        default: "min-h-8 px-[calc(--spacing(3)-1px)]",
        sm: "min-h-7 gap-1.5 px-[calc(--spacing(2.5)-1px)]",
      },
    },
  },
);

const TRIGGER_DEFAULT =
  "w-full min-w-36 border-input bg-background not-dark:bg-clip-padding text-foreground shadow-xs/5 ring-ring/24 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-inset aria-invalid:border-destructive/36 dark:bg-input/32 [&_svg:not([class*='text-'])]:text-muted-foreground";

function SelectTrigger({
  className,
  size = "default",
  children,
  ...props
}: SelectPrimitive.Trigger.Props & VariantProps<typeof selectTriggerVariants>) {
  return (
    <SelectPrimitive.Trigger
      className={cn(selectTriggerVariants({ size }), TRIGGER_DEFAULT, className)}
      data-slot="select-trigger"
      {...props}
    >
      {children}
      <SelectPrimitive.Icon data-slot="select-icon">
        <ChevronDownIcon className="-me-1 size-3.5 opacity-70" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

function SelectValue({ className, ...props }: SelectPrimitive.Value.Props) {
  return (
    <SelectPrimitive.Value
      className={cn("flex-1 truncate data-placeholder:text-placeholder", className)}
      data-slot="select-value"
      {...props}
    />
  );
}

function SelectPopup({ className, children, ...props }: SelectPrimitive.Popup.Props) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Positioner
        alignItemWithTrigger={false}
        className="z-[130] select-none"
        sideOffset={4}
      >
        <SelectPrimitive.Popup
          className="origin-(--transform-origin) rounded-lg text-foreground outline-none transition-[scale,opacity] duration-100 data-ending-style:scale-98 data-starting-style:scale-98 data-ending-style:opacity-0 data-starting-style:opacity-0"
          data-slot="select-popup"
          {...props}
        >
          <div className="relative min-w-(--anchor-width) rounded-lg border bg-popover not-dark:bg-clip-padding shadow-[0_16px_40px_-18px_rgb(0_0_0/35%)] dark:shadow-[0_18px_44px_-18px_rgb(0_0_0/80%)]">
            <SelectPrimitive.List
              className={cn("max-h-(--available-height) overflow-y-auto p-1", className)}
              data-slot="select-list"
            >
              {children}
            </SelectPrimitive.List>
          </div>
        </SelectPrimitive.Popup>
      </SelectPrimitive.Positioner>
    </SelectPrimitive.Portal>
  );
}

function SelectItem({ className, children, ...props }: SelectPrimitive.Item.Props) {
  return (
    <SelectPrimitive.Item
      className={cn(
        "flex min-h-7 cursor-pointer items-center gap-2 rounded-sm px-2 py-1 text-sm outline-none data-disabled:pointer-events-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:opacity-64 [&_svg]:pointer-events-none [&_svg]:size-3.5 [&_svg]:shrink-0",
        className,
      )}
      data-slot="select-item"
      {...props}
    >
      <SelectPrimitive.ItemText className="min-w-0 flex-1" data-slot="select-item-text">
        {children}
      </SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator>
        <CheckIcon className="text-primary" />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  );
}

export { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue, selectTriggerVariants };
