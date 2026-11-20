// The sidebar's views, in order, with their icons and titles.
import { BotIcon, KanbanIcon, ScrollTextIcon, SettingsIcon } from "lucide-react";
import type { View } from "../lib/route.ts";

export const NAV: ReadonlyArray<{ view: View; title: string; icon: typeof KanbanIcon }> = [
  { view: "board", title: "Board", icon: KanbanIcon },
  { view: "agents", title: "Agents", icon: BotIcon },
  { view: "logs", title: "Logs", icon: ScrollTextIcon },
  { view: "settings", title: "Settings", icon: SettingsIcon },
];
