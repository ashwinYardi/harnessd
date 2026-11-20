// The left rail: the views, with the counts that need attention, and the palette hint.
import { SearchIcon } from "lucide-react";
import { BrandLockup, BrandMark } from "../components/brand-mark.tsx";
import { Badge } from "../components/ui/badge.tsx";
import { Kbd, KbdGroup } from "../components/ui/kbd.tsx";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from "../components/ui/sidebar.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip.tsx";
import { hrefFor, type View } from "../lib/route.ts";
import { NAV } from "./nav.ts";

interface AppSidebarProps {
  view: View;
  needsYou: number;
  running: number | undefined;
  failingChecks: number;
  onOpenPalette: () => void;
  modKey: string;
  paused: boolean;
}

export function AppSidebar({
  view,
  needsYou,
  running,
  failingChecks,
  onOpenPalette,
  modKey,
  paused,
}: AppSidebarProps) {
  const badge: Partial<Record<View, React.ReactNode>> = {
    board: needsYou > 0 && (
      <Badge variant="destructive">
        {needsYou}
        <span className="sr-only"> need you</span>
      </Badge>
    ),
    agents: running !== undefined && running > 0 && (
      <span className="text-muted-foreground text-xs">
        {running}
        <span className="sr-only"> running</span>
      </span>
    ),
    settings: failingChecks > 0 && (
      <Badge variant="error">
        {failingChecks}
        <span className="sr-only"> to fix</span>
      </Badge>
    ),
  };
  const dot: Partial<Record<View, string>> = {
    board: needsYou > 0 ? "bg-destructive" : "",
    settings: failingChecks > 0 ? "bg-destructive" : "",
  };
  return (
    <Sidebar aria-label="Views">
      <SidebarHeader className="h-13 justify-center border-sidebar-border border-b px-2 md:px-4">
        <span className="hidden items-center justify-between md:flex">
          <BrandLockup />
          {paused && <Badge variant="warning">Paused</Badge>}
        </span>
        <BrandMark className="mx-auto size-5 md:hidden" />
        <span className="sr-only md:hidden">harnessd</span>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <nav aria-label="Main">
            <SidebarMenu>
              {NAV.map(({ view: v, title, icon: Icon }) => (
                <SidebarMenuItem key={v}>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <SidebarMenuButton href={hrefFor({ view: v })} isActive={view === v} />
                      }
                    >
                      <span className="relative inline-flex">
                        <Icon aria-hidden="true" className="size-4" />
                        {dot[v] && (
                          <span
                            aria-hidden="true"
                            className={`absolute -top-0.5 -right-0.5 size-1.5 rounded-full md:hidden ${dot[v]}`}
                          />
                        )}
                      </span>
                      <span className="hidden md:inline">{title}</span>
                      <span className="sr-only md:hidden">{title}</span>
                      {badge[v] && <SidebarMenuBadge>{badge[v]}</SidebarMenuBadge>}
                    </TooltipTrigger>
                    <TooltipContent side="right" className="md:hidden">
                      {title}
                    </TooltipContent>
                  </Tooltip>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </nav>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <Tooltip>
          <TooltipTrigger
            render={
              <SidebarMenuButton
                render={<button type="button" />}
                onClick={onOpenPalette}
                aria-label="Open the command palette"
              />
            }
          >
            <SearchIcon aria-hidden="true" />
            <span className="hidden md:inline">Commands</span>
            <SidebarMenuBadge>
              <KbdGroup>
                <Kbd>{modKey}</Kbd>
                <Kbd>K</Kbd>
              </KbdGroup>
            </SidebarMenuBadge>
          </TooltipTrigger>
          <TooltipContent side="right">Commands ({modKey}+K)</TooltipContent>
        </Tooltip>
      </SidebarFooter>
    </Sidebar>
  );
}
