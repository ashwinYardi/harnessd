// Ported from T3 Code, apps/web/src/components/ui/scroll-area.tsx (https://github.com/pingdotgg/t3code).
// Copyright (c) 2026 T3 Tools Inc. MIT License; see packages/ui/THIRD_PARTY_NOTICES.md.
// Changes: no scroll fade, gutter or chaining options; the viewport takes a ref and props.
import { ScrollArea as ScrollAreaPrimitive } from "@base-ui/react/scroll-area";
import type * as React from "react";
import { cn } from "../../lib/cn.ts";

function ScrollArea({
  className,
  children,
  viewportProps,
  ...props
}: ScrollAreaPrimitive.Root.Props & {
  viewportProps?: ScrollAreaPrimitive.Viewport.Props & React.RefAttributes<HTMLDivElement>;
}) {
  return (
    <ScrollAreaPrimitive.Root
      className={cn("relative size-full min-h-0 overflow-hidden rounded-[inherit]", className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        {...viewportProps}
        className={cn(
          "h-full max-h-[inherit] overscroll-contain rounded-[inherit] outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          viewportProps?.className,
        )}
        data-slot="scroll-area-viewport"
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar orientation="vertical" />
      <ScrollBar orientation="horizontal" />
      <ScrollAreaPrimitive.Corner data-slot="scroll-area-corner" />
    </ScrollAreaPrimitive.Root>
  );
}

function ScrollBar({
  className,
  orientation = "vertical",
  ...props
}: ScrollAreaPrimitive.Scrollbar.Props) {
  return (
    <ScrollAreaPrimitive.Scrollbar
      className={cn(
        "flex opacity-0 transition-opacity delay-300 data-[orientation=horizontal]:mx-1 data-[orientation=horizontal]:mb-px data-[orientation=horizontal]:h-1.5 data-[orientation=vertical]:my-1 data-[orientation=vertical]:mr-px data-[orientation=vertical]:w-1.5 data-[orientation=horizontal]:flex-col data-hovering:opacity-100 data-scrolling:opacity-100 data-hovering:delay-0 data-scrolling:delay-0 data-hovering:duration-100 data-scrolling:duration-100",
        className,
      )}
      data-slot="scroll-area-scrollbar"
      orientation={orientation}
      {...props}
    >
      <ScrollAreaPrimitive.Thumb
        className="relative flex-1 rounded-full bg-[var(--app-scrollbar-thumb)] transition-colors hover:bg-[var(--app-scrollbar-thumb-hover)]"
        data-slot="scroll-area-thumb"
      />
    </ScrollAreaPrimitive.Scrollbar>
  );
}

export { ScrollArea, ScrollBar };
