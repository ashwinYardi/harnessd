// From shadcn/ui, base-nova registry (MIT; see packages/ui/THIRD_PARTY_NOTICES.md).
// harnessd changes: the static parts only. A fixed 224 px rail with no provider, collapse
// state, resize or mobile sheet; below the md breakpoint it shows icons only (48 px). The
// active row is aria-current="page". Rows have a 44 px hit area on touch.
import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva } from "class-variance-authority";
import type * as React from "react";
import { cn } from "../../lib/cn.ts";

function Sidebar({ className, ...props }: React.ComponentProps<"aside">) {
  return (
    <aside
      className={cn(
        "flex h-full w-12 shrink-0 flex-col border-sidebar-border border-r bg-sidebar text-sidebar-foreground md:w-56",
        className,
      )}
      data-slot="sidebar"
      {...props}
    />
  );
}

function SidebarHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("flex flex-col gap-2 p-2", className)}
      data-slot="sidebar-header"
      {...props}
    />
  );
}

function SidebarContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("flex min-h-0 flex-1 flex-col overflow-y-auto", className)}
      data-slot="sidebar-content"
      {...props}
    />
  );
}

function SidebarFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("flex flex-col gap-1 p-2", className)}
      data-slot="sidebar-footer"
      {...props}
    />
  );
}

function SidebarGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("relative flex w-full min-w-0 flex-col p-2", className)}
      data-slot="sidebar-group"
      {...props}
    />
  );
}

function SidebarGroupLabel({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "hidden h-6 shrink-0 items-center px-2.5 font-medium text-sidebar-muted-foreground text-xs md:flex",
        className,
      )}
      data-slot="sidebar-group-label"
      {...props}
    />
  );
}

function SidebarMenu({ className, ...props }: React.ComponentProps<"ul">) {
  return (
    <ul
      className={cn("flex w-full min-w-0 flex-col gap-0.5", className)}
      data-slot="sidebar-menu"
      {...props}
    />
  );
}

function SidebarMenuItem({ className, ...props }: React.ComponentProps<"li">) {
  return (
    <li
      className={cn("group/menu-item relative", className)}
      data-slot="sidebar-menu-item"
      {...props}
    />
  );
}

const sidebarMenuButtonVariants = cva(
  "relative flex h-8 w-full cursor-pointer items-center justify-center gap-2 overflow-hidden rounded-lg px-2 text-left font-medium text-sidebar-muted-foreground text-sm outline-hidden transition-colors duration-100 hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset active:bg-sidebar-row-active aria-[current=page]:bg-sidebar-row-active aria-[current=page]:text-sidebar-foreground aria-[current=page]:shadow-xs/5 md:justify-start md:px-2.5 dark:aria-[current=page]:shadow-none pointer-coarse:after:absolute pointer-coarse:after:inset-x-0 pointer-coarse:after:top-1/2 pointer-coarse:after:h-11 pointer-coarse:after:-translate-y-1/2 [&>svg]:size-4 [&>svg]:shrink-0",
);

function SidebarMenuButton({
  className,
  isActive = false,
  render,
  ...props
}: useRender.ComponentProps<"a"> & { isActive?: boolean }) {
  const defaultProps = {
    className: cn(sidebarMenuButtonVariants(), className),
    "data-slot": "sidebar-menu-button",
    "aria-current": isActive ? ("page" as const) : undefined,
  };
  return useRender({ defaultTagName: "a", props: mergeProps<"a">(defaultProps, props), render });
}

/** A count at the end of a menu row. Hidden on the icon rail, where the icon carries a dot. */
function SidebarMenuBadge({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      className={cn("ms-auto hidden tabular-nums md:inline-flex", className)}
      data-slot="sidebar-menu-badge"
      {...props}
    />
  );
}

function SidebarInset({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("relative flex min-w-0 flex-1 flex-col bg-background", className)}
      data-slot="sidebar-inset"
      {...props}
    />
  );
}

export {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
};
