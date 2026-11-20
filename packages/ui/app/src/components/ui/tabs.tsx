// Tabs on Base UI, styled with T3 Code's toggle-group and segmented-control classes
// (apps/web/src/components/ui/toggle-group.tsx, https://github.com/pingdotgg/t3code).
// Copyright (c) 2026 T3 Tools Inc. MIT License; see packages/ui/THIRD_PARTY_NOTICES.md.
import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
import { cn } from "../../lib/cn.ts";

const Tabs = TabsPrimitive.Root;

function TabsList({ className, children, ...props }: TabsPrimitive.List.Props) {
  return (
    <TabsPrimitive.List
      className={cn(
        "relative z-0 inline-flex h-8 items-center gap-0.5 rounded-lg bg-accent p-0.5 text-muted-foreground",
        className,
      )}
      data-slot="tabs-list"
      {...props}
    >
      {children}
      <TabsPrimitive.Indicator
        className="-z-1 absolute top-0.5 left-0 h-[calc(100%-4px)] w-(--active-tab-width) translate-x-(--active-tab-left) rounded-md bg-background shadow-sm/5 transition-[width,translate] duration-150 ease-out dark:bg-input"
        data-slot="tab-indicator"
      />
    </TabsPrimitive.List>
  );
}

function TabsTab({ className, ...props }: TabsPrimitive.Tab.Props) {
  return (
    <TabsPrimitive.Tab
      className={cn(
        "inline-flex h-7 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-2.5 font-medium text-sm outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-active:text-foreground data-disabled:pointer-events-none data-disabled:opacity-64 [&_svg]:size-3.5",
        className,
      )}
      data-slot="tabs-tab"
      {...props}
    />
  );
}

function TabsPanel({ className, ...props }: TabsPrimitive.Panel.Props) {
  return (
    <TabsPrimitive.Panel
      className={cn("outline-none", className)}
      data-slot="tabs-panel"
      {...props}
    />
  );
}

export { Tabs, TabsList, TabsPanel, TabsTab };
