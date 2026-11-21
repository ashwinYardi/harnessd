// Self-update (MET-63): when harnessd merges into its own repo, it rebuilds and restarts
// itself at a safe point. See docs/LOOP.md "Self-update".
//
// This file is the contract the loop uses. The loop takes a SelfUpdater as a dependency,
// so its tests use a fake. The real one finds the install clone, compares it with the
// default branch, then pulls, runs `pnpm install --frozen-lockfile` and `pnpm build`
// with the service's Node, and restarts through launchd.

/** A newer commit on the default branch than the one the install clone runs. */
export interface SelfUpdateTarget {
  /** The commit the running build came from. */
  from: string;
  /** The default branch head to update to. */
  to: string;
}

/** The step of an update that failed. */
export type SelfUpdateStep = "pull" | "install" | "build" | "restart";

export type SelfUpdateResult =
  /** The new build is in place and the restart is under way. */
  | { status: "applied" }
  /** Nothing was changed, e.g. the install clone has local changes. */
  | { status: "blocked"; reason: string }
  /** A step failed; the old build is kept and still runs. */
  | { status: "failed"; step: SelfUpdateStep; error: string };

export interface SelfUpdater {
  /**
   * The target, or undefined when the repo the loop works on is not this install, or the
   * install already runs the default branch head. Throws on an error.
   */
  checkForUpdate(): Promise<SelfUpdateTarget | undefined>;
  /**
   * Fast-forwards the install clone to `target.to`, installs, builds and restarts. It
   * never discards local changes and never restarts into a failed build.
   */
  applyUpdate(target: SelfUpdateTarget): Promise<SelfUpdateResult>;
}

/** Lines of an error kept in the pause reason and the notice. */
export const SELF_UPDATE_ERROR_LINES = 5;

/** The last non-blank lines of a step's output. */
export function lastLines(text: string, n = SELF_UPDATE_ERROR_LINES): string {
  return text
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== "")
    .slice(-n)
    .join("\n");
}

/** The first 7 characters of a commit, as git shows it. */
export function short(sha: string): string {
  return sha.slice(0, 7);
}
