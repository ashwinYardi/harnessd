// The current view, read from the hash and kept in step with Back and Forward.
import { useCallback, useEffect, useState } from "react";
import { hrefFor, parseRoute, type Route, type View } from "../lib/route.ts";

export function useRoute() {
  const [route, setRoute] = useState<Route>(() => parseRoute(location.hash));
  useEffect(() => {
    const onHash = () => setRoute(parseRoute(location.hash));
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);
  const go = useCallback((next: Route | { view: View }) => {
    if (location.hash !== hrefFor(next)) location.hash = hrefFor(next);
  }, []);
  return { route, go };
}
