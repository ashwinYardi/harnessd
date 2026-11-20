// The command palette's list: every action in the app, matched by the words typed.

export interface Command {
  id: string;
  title: string;
  /** The heading the command sits under in the palette. */
  group: string;
  /** Other words that find it, such as "stop" for Pause. */
  keywords?: readonly string[];
  /** The key hint shown at the right, for example "G B". */
  shortcut?: string;
  disabled?: boolean;
}

const words = (s: string) => s.toLowerCase().split(/\s+/).filter(Boolean);

/**
 * Every word of the query must start a word of the title or a keyword. A title that starts
 * with the query comes first; otherwise the given order holds.
 */
export function matchCommands<T extends Command>(commands: readonly T[], query: string): T[] {
  const q = words(query);
  if (q.length === 0) return [...commands];
  const scored: Array<[T, number, number]> = [];
  commands.forEach((c, i) => {
    const hay = [...words(c.title), ...(c.keywords ?? []).flatMap(words)];
    if (!q.every((w) => hay.some((h) => h.startsWith(w)))) return;
    const lead = c.title.toLowerCase().startsWith(q.join(" ")) ? 0 : 1;
    scored.push([c, lead, i]);
  });
  return scored.sort((a, b) => a[1] - b[1] || a[2] - b[2]).map(([c]) => c);
}

/** The index of the next command that is not disabled, in direction `step`; -1 if none. */
export function nextEnabled(commands: readonly Command[], from: number, step: 1 | -1): number {
  const n = commands.length;
  for (let i = 1; i <= n; i++) {
    const at = (((from + step * i) % n) + n) % n;
    if (!commands[at]?.disabled) return at;
  }
  return -1;
}
