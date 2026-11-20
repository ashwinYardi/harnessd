// GET /api/status (docs/API.md): the status engine's checks for the app (MET-27).
import type { Route } from "../server/router.ts";
import type { Check } from "./status.ts";

/** One route. Concurrent requests share one run of the checks. */
export function statusRoutes(checks: () => Promise<Check[]>): Route[] {
  let inFlight: Promise<Check[]> | undefined;
  return [
    {
      method: "GET",
      path: "/api/status",
      handler: async () => {
        inFlight ??= checks().finally(() => {
          inFlight = undefined;
        });
        return { checks: await inFlight };
      },
    },
  ];
}
