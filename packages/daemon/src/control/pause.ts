// The global kill switch (D-014, MET-15). See docs/LOOP.md "Pause".
//
// The flag lives at `~/.harnessd/state/paused.json` and applies to every workspace.
// A missing file means running. The file is the truth: the CLI writes it even when no
// daemon is up, and every loop re-reads it, so a pause also survives a restart.
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { globalStateDir, writeJsonAtomic } from "./files.ts";

export interface PauseState {
  paused: boolean;
  /** ISO time the pause started. Set when paused. */
  since?: string;
  reason?: string;
}

/** What a pause did: the new state and how many runs it cancelled. */
export interface PauseResult extends PauseState {
  cancelled: number;
}

/** Longest reason kept; longer ones are cut. */
export const MAX_PAUSE_REASON = 500;

export function pauseStatePath(globalDir: string): string {
  return join(globalStateDir(globalDir), "paused.json");
}

/** A flag file that is not `{ "paused": true, "since"?, "reason"? }`. */
export class PauseStateError extends Error {
  constructor(detail: string) {
    super(`invalid pause flag: ${detail}`);
    this.name = "PauseStateError";
  }
}

/** Trims a reason and cuts it to MAX_PAUSE_REASON; blank is no reason. */
export function cleanReason(reason: string | undefined): string | undefined {
  const text = reason?.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > MAX_PAUSE_REASON ? text.slice(0, MAX_PAUSE_REASON) : text;
}

/** Parses paused.json. Throws PauseStateError on anything else. */
export function parsePauseState(text: string): PauseState {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new PauseStateError("not JSON");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new PauseStateError("not an object");
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.paused !== "boolean") throw new PauseStateError("paused is not a boolean");
  if (!r.paused) return { paused: false };
  const state: PauseState = { paused: true };
  if (typeof r.since === "string") state.since = r.since;
  const reason = typeof r.reason === "string" ? cleanReason(r.reason) : undefined;
  if (reason !== undefined) state.reason = reason;
  return state;
}

/** Reads and writes the pause flag. */
export interface PauseStore {
  read(): Promise<PauseState>;
  /** Sets the flag. An existing pause keeps its `since`; a new reason replaces the old one. */
  pause(reason?: string): Promise<PauseState>;
  /** Clears the flag. */
  resume(): Promise<PauseState>;
}

export interface FilePauseStoreOptions {
  now?: () => Date;
}

/**
 * The file store. A missing file is running. An unreadable one counts as paused, so the
 * kill switch fails closed; `harnessd resume` replaces it. Writes are atomic.
 */
export function createFilePauseStore(
  globalDir: string,
  options: FilePauseStoreOptions = {},
): PauseStore {
  const file = pauseStatePath(globalDir);
  const now = options.now ?? (() => new Date());

  async function read(): Promise<PauseState> {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { paused: false };
      throw error;
    }
    try {
      return parsePauseState(text);
    } catch (error) {
      if (!(error instanceof PauseStateError)) throw error;
      return { paused: true, reason: `${file} is unreadable (${error.message})` };
    }
  }

  return {
    read,
    async pause(reason) {
      const previous = await read().catch((): PauseState => ({ paused: false }));
      const state: PauseState = {
        paused: true,
        since: previous.paused && previous.since ? previous.since : now().toISOString(),
      };
      const why = cleanReason(reason) ?? (previous.paused ? previous.reason : undefined);
      if (why !== undefined) state.reason = why;
      await writeJsonAtomic(file, state);
      return state;
    },
    async resume() {
      await rm(file, { force: true });
      return { paused: false };
    },
  };
}

/** The part of the coordinator loop a pause drives. */
export interface PausableLoop {
  /** Stops dispatch and cancels every run; resolves with the cancelled sub-issue keys. */
  pause(): Promise<string[]>;
  resume(): void;
}

/** What the HTTP API calls: the flag first, then the live loops. */
export interface PauseControl {
  status(): Promise<PauseState>;
  pause(reason?: string): Promise<PauseResult>;
  resume(): Promise<PauseState>;
}

export interface PauseControllerOptions {
  store: PauseStore;
  /** The loops in this process. None is fine: then only the flag changes. */
  loops?: PausableLoop[];
}

export function createPauseController(options: PauseControllerOptions): PauseControl {
  const { store } = options;
  const loops = options.loops ?? [];
  return {
    status: () => store.read(),
    async pause(reason) {
      const state = await store.pause(reason);
      const cancelled = await Promise.all(loops.map((loop) => loop.pause()));
      return { ...state, cancelled: cancelled.reduce((n, keys) => n + keys.length, 0) };
    },
    async resume() {
      const state = await store.resume();
      for (const loop of loops) loop.resume();
      return state;
    },
  };
}
