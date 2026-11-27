// Pure helpers for the Team view (MET-227), kept out of Team.tsx so node:test can run
// them without a DOM.
import { AGENT_ROLES } from "@harnessd/shared";

/** The role select's options, in role order: coordinator, builders, QA, reviewer (D-010). */
export const ROLE_OPTIONS = AGENT_ROLES;

function roleRank(role: string): number {
  const i = (ROLE_OPTIONS as readonly string[]).indexOf(role);
  return i === -1 ? ROLE_OPTIONS.length : i;
}

/**
 * Rows in role order, so the reviewer lists after QA whatever order the config layers
 * merged in (MET-227). Stable: rows with the same role keep the order they arrived in.
 */
export function byRoleOrder<T extends { role: string }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => roleRank(a.role) - roleRank(b.role));
}
