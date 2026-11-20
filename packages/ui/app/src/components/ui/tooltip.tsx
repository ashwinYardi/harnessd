// Ported from T3 Code, apps/web/src/components/ui/tooltip.tsx (https://github.com/pingdotgg/t3code).
// Copyright (c) 2026 T3 Tools Inc. MIT License; see packages/ui/THIRD_PARTY_NOTICES.md.
// Changes: no scroll-dismiss tracker, no titlebar inset, no glass or code variants.
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import { cn } from "../../lib/cn.ts";

const TooltipProvider = TooltipPrimitive.Provider;
const Tooltip = TooltipPrimitive.Root;

function TooltipTrigger(props: TooltipPrimitive.Trigger.Props) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
}

function TooltipPopup({
  className,
  side = "top",
  sideOffset = 4,
  align = "center",
  children,
  ...props
}: TooltipPrimitive.Popup.Props & {
  side?: TooltipPrimitive.Positioner.Props["side"];
  sideOffset?: number;
  align?: TooltipPrimitive.Positioner.Props["align"];
}) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner
        align={align}
        className="pointer-events-none z-[140]"
        side={side}
        sideOffset={sideOffset}
      >
        <TooltipPrimitive.Popup
          className={cn(
            "relative flex max-w-80 origin-(--transform-origin) rounded-md border bg-popover not-dark:bg-clip-padding px-2 py-1 text-popover-foreground text-xs leading-snug shadow-md/5 transition-[scale,opacity] duration-100 data-ending-style:scale-98 data-starting-style:scale-98 data-ending-style:opacity-0 data-starting-style:opacity-0 data-instant:duration-0",
            className,
          )}
          data-slot="tooltip-popup"
          {...props}
        >
          {children}
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  );
}

export { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger };
