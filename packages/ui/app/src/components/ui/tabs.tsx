// From shadcn/ui, base-nova registry (MIT; see packages/ui/THIRD_PARTY_NOTICES.md).
// harnessd changes: horizontal only; the active tab is drawn by Base UI's sliding indicator
// (150 ms), not by each trigger; a 2 px focus ring.
import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
import { cn } from "../../lib/cn.ts";

function Tabs({ className, ...props }: TabsPrimitive.Root.Props) {
  return (
    <TabsPrimitive.Root
      className={cn("flex flex-col gap-2", className)}
      data-slot="tabs"
      {...props}
    />
  );
}

function TabsList({ className, children, ...props }: TabsPrimitive.List.Props) {
  return (
    <TabsPrimitive.List
      className={cn(
        "relative z-0 inline-flex h-8 w-fit items-center justify-center gap-0.5 rounded-lg bg-accent p-0.5 text-muted-foreground",
        className,
      )}
      data-slot="tabs-list"
      {...props}
    >
      {children}
      <TabsPrimitive.Indicator
        className="absolute top-0.5 left-0 -z-1 h-[calc(100%-4px)] w-(--active-tab-width) translate-x-(--active-tab-left) rounded-md bg-background shadow-sm/5 transition-[width,translate] duration-150 ease-out dark:bg-input"
        data-slot="tabs-indicator"
      />
    </TabsPrimitive.List>
  );
}

function TabsTrigger({ className, ...props }: TabsPrimitive.Tab.Props) {
  return (
    <TabsPrimitive.Tab
      className={cn(
        "inline-flex h-7 flex-1 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-2.5 font-medium text-sm outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-active:text-foreground data-disabled:pointer-events-none data-disabled:opacity-64 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
        className,
      )}
      data-slot="tabs-trigger"
      {...props}
    />
  );
}

function TabsContent({ className, ...props }: TabsPrimitive.Panel.Props) {
  return (
    <TabsPrimitive.Panel
      className={cn("flex-1 text-sm outline-none", className)}
      data-slot="tabs-content"
      {...props}
    />
  );
}

export { Tabs, TabsContent, TabsList, TabsTrigger };
