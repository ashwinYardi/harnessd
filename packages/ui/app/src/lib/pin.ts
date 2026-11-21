// Pinned rows: live updates apply in place, but the row under the pointer or focus keeps its
// group and its index, so it never moves while the user reads it (PRODUCT.md UX rules).

/** A list of rows, such as a Board column or an agent's runs. */
export interface Group<T> {
  id: string;
  rows: readonly T[];
}

/**
 * The groups to render. With no pinned keys, the new groups show at once. Each pinned row
 * (the one under the pointer, the one with focus) stays in the group and at the index it has
 * in `shown`, with its contents from `next`; the other rows take their new places around it.
 * A pinned row that left `next` keeps its slot and its last contents. A pinned group that
 * left `next` stays at its index.
 */
export function pin<T, G extends Group<T>>(
  shown: readonly G[],
  next: readonly G[],
  key: (row: T) => string,
  pinned: readonly string[],
): G[] {
  // Top to bottom, so each insert lands at its shown index.
  const held = [...new Set(pinned)]
    .map((k) => find(shown, key, k))
    .filter((at) => at !== undefined)
    .sort((a, b) => a.groupIndex - b.groupIndex || a.rowIndex - b.rowIndex);
  if (held.length === 0) return [...next];
  const keys = new Set(held.map((at) => key(at.row)));
  const groups = next.map((g) => ({ ...g, rows: g.rows.filter((r) => !keys.has(key(r))) }));
  for (const at of held) {
    const row = find(next, key, key(at.row))?.row ?? at.row;
    let index = groups.findIndex((g) => g.id === at.group.id);
    if (index < 0) {
      index = Math.min(at.groupIndex, groups.length);
      groups.splice(index, 0, { ...at.group, rows: [] });
    }
    const target = groups[index] as G;
    const rows = [...target.rows];
    rows.splice(Math.min(at.rowIndex, rows.length), 0, row);
    groups[index] = { ...target, rows };
  }
  return groups;
}

function find<T, G extends Group<T>>(groups: readonly G[], key: (row: T) => string, k: string) {
  for (const [groupIndex, group] of groups.entries()) {
    const rowIndex = group.rows.findIndex((r) => key(r) === k);
    const row = group.rows[rowIndex];
    if (row !== undefined) return { group, groupIndex, rowIndex, row };
  }
  return undefined;
}
