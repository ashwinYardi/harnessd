// The live log: lines arrive by stream and by refetch, so they are merged by sequence.
import type { LogLine } from "@harnessd/shared";

/** Lines kept in the pane. */
export const LOG_CAP = 1000;

export function appendLines(
  current: readonly LogLine[],
  incoming: readonly LogLine[],
  cap = LOG_CAP,
): LogLine[] {
  const last = current.at(-1)?.seq ?? 0;
  const seen = new Set(current.map((l) => l.seq));
  const fresh = incoming.filter((l) => !seen.has(l.seq));
  if (fresh.length === 0) return [...current];
  const merged = fresh.every((l) => l.seq > last)
    ? [...current, ...fresh.sort((a, b) => a.seq - b.seq)]
    : [...current, ...fresh].sort((a, b) => a.seq - b.seq);
  return merged.slice(-cap);
}

/** True when the pane is scrolled to its end, within a few pixels. */
export function isAtBottom(el: {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
}): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= 8;
}
