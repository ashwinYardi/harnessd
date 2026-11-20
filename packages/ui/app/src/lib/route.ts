// The app's views live in the hash, so the daemon serves one page and Back works.

export type View = "board" | "agents" | "logs" | "settings";
export interface Route {
  view: View;
}

export const VIEWS: readonly View[] = ["board", "agents", "logs", "settings"];

export function parseRoute(hash: string): Route {
  const name = hash.startsWith("#/") ? hash.slice(2).split(/[/?]/)[0] : "";
  const view = VIEWS.find((v) => v === name);
  return { view: view ?? "board" };
}

export function hrefFor(route: Route): string {
  return `#/${route.view}`;
}
