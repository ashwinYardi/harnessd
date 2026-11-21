// Pinned rows: live updates apply in place, but the row under the pointer or focus keeps its
// group and its index, so it never moves while the user reads it (PRODUCT.md UX rules).

/** A list of rows, such as a Board column or an agent's runs. */
export interface Group<T> {
  id: string;
  rows: readonly T[];
}

export interface PinOptions {
  /**
   * The groups stack in one list, such as the parts of one table. Then the rows of the groups
   * above a pinned row also hold, because a change there moves the pinned row too. Without it,
   * the groups sit side by side, such as Board columns, and only the pinned row's own group
   * holds.
   */
  stacked?: boolean;
}

/**
 * The groups to render. With no pinned keys, the new groups show at once. Each pinned row
 * (the one under the pointer, the one with focus) stays in the group and at the index it has
 * in `shown`, with its contents from `next`. To keep that index, the rows above it in its
 * group hold too (and, when `stacked`, all rows of the groups above). Held rows show their
 * contents from `next`, or their last contents if they left it. The other rows take their new
 * places below the held rows. A held group that left `next` stays at its index. Release (no
 * pinned keys) restores the true order.
 */
export function pin<T, G extends Group<T>>(
  shown: readonly G[],
  next: readonly G[],
  key: (row: T) => string,
  pinned: readonly string[],
  options: PinOptions = {},
): G[] {
  const spots = pinned.map((k) => find(shown, key, k)).filter((at) => at !== undefined);
  if (spots.length === 0) return [...next];

  // For each shown group: how many of its first rows hold, and if new rows may join it.
  const lowest = Math.max(...spots.map((at) => at.groupIndex));
  const holds = shown.map((g, groupIndex) => {
    const cuts = spots.filter((at) => at.groupIndex === groupIndex).map((at) => at.rowIndex + 1);
    const frozen = options.stacked === true && groupIndex < lowest;
    return { group: g, groupIndex, count: frozen ? g.rows.length : Math.max(0, ...cuts), frozen };
  });

  const held = new Set(holds.flatMap((h) => h.group.rows.slice(0, h.count).map(key)));
  const groups = next.map((g) => ({ ...g, rows: g.rows.filter((r) => !held.has(key(r))) }));
  for (const h of holds) {
    if (h.count === 0 && !h.frozen) continue;
    const rows = h.group.rows.slice(0, h.count).map((r) => find(next, key, key(r))?.row ?? r);
    let index = groups.findIndex((g) => g.id === h.group.id);
    if (index < 0) {
      index = Math.min(h.groupIndex, groups.length);
      groups.splice(index, 0, { ...h.group, rows: [] });
    }
    const target = groups[index] as G;
    groups[index] = { ...target, rows: h.frozen ? rows : [...rows, ...target.rows] };
  }
  return groups;
}

function find<T, G extends Group<T>>(groups: readonly G[], key: (row: T) => string, k: string) {
  for (const [groupIndex, group] of groups.entries()) {
    const rowIndex = group.rows.findIndex((r) => key(r) === k);
    const row = group.rows[rowIndex];
    if (row !== undefined) return { groupIndex, rowIndex, row };
  }
  return undefined;
}
