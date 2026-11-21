// The app's views live in the hash, so the daemon serves one page and Back works.
import type { SelfUpdateView } from "@harnessd/shared";
import type { HarnessLimit } from "./limits.ts";

export type View = "board" | "agents" | "logs" | "settings";
export type SettingsPage = "harnesses" | "connections" | "team";
export type Route = { view: Exclude<View, "settings"> } | { view: "settings"; page: SettingsPage };

export const VIEWS: readonly View[] = ["board", "agents", "logs", "settings"];
export const SETTINGS_PAGES: readonly SettingsPage[] = ["harnesses", "connections", "team"];

export function parseRoute(hash: string): Route {
  const [name, sub] = hash.startsWith("#/")
    ? (hash.slice(2).split(/[?]/)[0]?.split("/") ?? [])
    : [];
  if (name === "settings") {
    return { view: "settings", page: SETTINGS_PAGES.find((p) => p === sub) ?? "harnesses" };
  }
  if (name === "agents" || name === "logs") return { view: name };
  return { view: "board" };
}

export function hrefFor(route: Route | { view: View }): string {
  if (route.view === "settings") {
    return `#/settings/${"page" in route ? route.page : "harnesses"}`;
  }
  return `#/${route.view}`;
}

/** The daemon's loop state (GET /api/loop). */
export interface LoopState {
  state: "setup" | "running";
  blocking: string[];
  /** The last self-update, once there was one (MET-63). */
  selfUpdate?: SelfUpdateView;
  /** Harnesses held by a usage limit (MET-70). Absent from a daemon before MET-70 part 4. */
  limits?: HarnessLimit[];
}

/**
 * On first launch, a blocking check opens Settings → Harnesses (MET-28). A view the owner
 * chose in the URL stays.
 */
export function firstRoute(hash: string, loop: LoopState): Route | undefined {
  if (hash !== "" && hash !== "#" && hash !== "#/") return undefined;
  if (loop.state !== "setup" || loop.blocking.length === 0) return undefined;
  return { view: "settings", page: "harnesses" };
}
