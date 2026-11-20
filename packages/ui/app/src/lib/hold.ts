// Held updates: while the pointer or focus is in a region, live changes wait, so content
// never moves under the cursor (PRODUCT.md). They show on release.

export interface Held<T> {
  /** What the region renders. */
  shown: T;
  /** The newest value received. */
  latest: T;
  /** Updates received since the hold began that differ from what is shown. */
  pending: number;
}

const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

export function start<T>(value: T): Held<T> {
  return { shown: value, latest: value, pending: 0 };
}

export function held<T>(state: Held<T>, value: T, holding: boolean): Held<T> {
  if (!holding || state.shown === undefined || state.shown === null) return start(value);
  if (same(value, state.shown)) return { ...state, latest: value, pending: 0 };
  return { ...state, latest: value, pending: state.pending + 1 };
}

export function release<T>(state: Held<T>): Held<T> {
  return start(state.latest);
}
