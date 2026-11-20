// Number and time formats. Every figure renders with tabular numerals.

const pad = (n: number) => String(n).padStart(2, "0");

/** "4s", "1m 05s", "2h 03m". */
export function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${pad(s % 60)}s`;
  return `${Math.floor(m / 60)}h ${pad(m % 60)}m`;
}

/** Share of the time budget spent: 0 at the start, 1 at the budget, more when over. */
export function budgetUsed(startedAt: string, budgetMs: number, now: Date): number {
  if (budgetMs <= 0) return 0;
  return Math.max(0, (now.getTime() - Date.parse(startedAt)) / budgetMs);
}

/** "950", "1.5k", "48k", "1.3M". */
export function tokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** "just now", "30s ago", "12m ago", "3h ago", "3d ago". */
export function sinceText(iso: string, now: Date): string {
  const s = Math.floor((now.getTime() - Date.parse(iso)) / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

/** "10:04:05", local time. */
export function clockTime(iso: string): string {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** "30m", "2h", "1h 30m". */
export function budgetText(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  return m % 60 === 0 ? `${m / 60}h` : `${Math.floor(m / 60)}h ${m % 60}m`;
}
