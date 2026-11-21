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

/**
 * The log tail: it follows the end, or it keeps the lines it had when the reader scrolled up.
 * Only a scroll freezes it; the pointer and focus do not.
 */
export type Tail = { frozen: null } | { frozen: readonly LogLine[] };

/** The tail follows the end. Jump to latest returns to this state. */
export const FOLLOW: Tail = { frozen: null };

/** The tail after a scroll: at the end it follows; above the end it keeps its lines. */
export function scrollTail(tail: Tail, atBottom: boolean, lines: readonly LogLine[]): Tail {
  if (atBottom) return tail.frozen ? FOLLOW : tail;
  return tail.frozen ? tail : { frozen: lines };
}

/** What the pane renders, and whether it follows the end. */
export function tailView(
  tail: Tail,
  lines: readonly LogLine[],
): { follow: boolean; lines: readonly LogLine[] } {
  return tail.frozen ? { follow: false, lines: tail.frozen } : { follow: true, lines };
}
