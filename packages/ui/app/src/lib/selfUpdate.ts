// The last self-update (MET-63): the daemon rebuilt and restarted itself from its own repo.
// GET /api/loop carries it as `selfUpdate`; the Settings loop banner shows one line for it.

import type { SelfUpdateView } from "@harnessd/shared";

/** The shared read model (packages/shared/src/ui.ts). */
export type SelfUpdate = SelfUpdateView;

export interface SelfUpdateLine {
  /** Undefined when the paused loop already names the reason (failed or blocked). */
  label: string | undefined;
  /** Commit ids, 7 characters. */
  from: string;
  to: string;
  /** Local "14:02", only for a done update. */
  time: string | undefined;
}

const short = (sha: string) => sha.slice(0, 7);
const pad = (n: number) => String(n).padStart(2, "0");

function hm(iso: string): string | undefined {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The banner line for the last self-update, or undefined when there is none. */
export function selfUpdateLine(update: SelfUpdate | undefined): SelfUpdateLine | undefined {
  if (!update) return undefined;
  const from = short(update.from);
  const to = short(update.to);
  if (update.state === "done") return { label: "Updated", from, to, time: hm(update.at) };
  if (update.state === "pending" || update.state === "applying")
    return { label: "Update pending", from, to, time: undefined };
  return { label: undefined, from, to, time: undefined };
}
