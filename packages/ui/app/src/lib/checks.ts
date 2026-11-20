// The status engine's checks as the UI reads them (D-023, docs/API.md GET /api/status).

/** One line of `harnessd doctor`. */
export interface Check {
  id: string;
  state: "ok" | "warn" | "fail" | "missing";
  detail: string;
  fix: string;
}

/** fail and missing block the loop; warn never does (D-023). */
export function isBlocking(check: Check): boolean {
  return check.state === "fail" || check.state === "missing";
}

const ORDER: Record<Check["state"], number> = { fail: 0, missing: 1, warn: 2, ok: 3 };

/** Failures first, then warnings, then the rest, each in the engine's order. */
export function sortChecks(checks: readonly Check[]): Check[] {
  return checks
    .map((c, i) => [c, i] as const)
    .sort((a, b) => ORDER[a[0].state] - ORDER[b[0].state] || a[1] - b[1])
    .map(([c]) => c);
}
