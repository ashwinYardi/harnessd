// Loop state at `<repo>/.harnessd/state/loop.json`. Linear stays the source of truth;
// this only remembers what a crash would otherwise lose. See docs/LOOP.md.
import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AgentRole } from "@harnessd/shared";

/** A sub-issue an agent is working on. */
export interface InFlightRun {
  issueId: string;
  issueKey: string;
  role: AgentRole;
  /** Agent name from the config. */
  agent: string;
  /** Worktree path; empty until the worktree exists. */
  worktree: string;
  branch: string;
  startedAt: string;
  /** The daemon process that started the run. */
  pid: number;
}

/** What QA asked a part to fix; its next run's prompt carries it. */
export interface QaFeedback {
  /** The part's PR, when one was found. */
  prUrl?: string;
  /** The request-changes review, when it was posted. */
  reviewUrl?: string;
  /** One line per failing item: the item and its evidence. */
  failing: string[];
}

export interface LoopState {
  version: 1;
  /** ISO time of the last poll, null before the first. */
  lastPollAt: string | null;
  inFlight: InFlightRun[];
  /** Failed runs per sub-issue id (D-014: one retry, then Needs input). */
  attempts: Record<string, number>;
  /** Failed QA rounds per parent issue id (D-014: the second one escalates). */
  qaFailures: Record<string, number>;
  /** Open QA requests per part sub-issue id, cleared when the part's next run succeeds. */
  qaFeedback: Record<string, QaFeedback>;
}

export function emptyLoopState(): LoopState {
  return {
    version: 1,
    lastPollAt: null,
    inFlight: [],
    attempts: {},
    qaFailures: {},
    qaFeedback: {},
  };
}

/** Where the loop keeps its state. */
export interface LoopStore {
  load(): Promise<LoopState>;
  save(state: LoopState): Promise<void>;
}

export function loopStatePath(repoDir: string): string {
  return join(repoDir, ".harnessd", "state", "loop.json");
}

function isRun(value: unknown): value is InFlightRun {
  const r = value as Partial<InFlightRun> | null;
  return (
    typeof r === "object" &&
    r !== null &&
    typeof r.issueId === "string" &&
    typeof r.issueKey === "string" &&
    typeof r.role === "string" &&
    typeof r.agent === "string" &&
    typeof r.worktree === "string" &&
    typeof r.branch === "string" &&
    typeof r.startedAt === "string" &&
    typeof r.pid === "number"
  );
}

function counts(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (typeof value !== "object" || value === null) return out;
  for (const [id, n] of Object.entries(value)) {
    if (typeof n === "number" && Number.isInteger(n) && n > 0) out[id] = n;
  }
  return out;
}

function feedback(value: unknown): Record<string, QaFeedback> {
  const out: Record<string, QaFeedback> = {};
  if (typeof value !== "object" || value === null) return out;
  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    const f = raw as Partial<QaFeedback> | null;
    if (typeof f !== "object" || f === null || !Array.isArray(f.failing)) continue;
    const entry: QaFeedback = { failing: f.failing.filter((l) => typeof l === "string") };
    if (typeof f.prUrl === "string") entry.prUrl = f.prUrl;
    if (typeof f.reviewUrl === "string") entry.reviewUrl = f.reviewUrl;
    out[id] = entry;
  }
  return out;
}

/** Reads a state file's JSON, keeping only well-formed parts. Throws on anything unreadable. */
export function parseLoopState(text: string): LoopState {
  const raw = JSON.parse(text) as Partial<LoopState> | null;
  if (typeof raw !== "object" || raw === null || !Array.isArray(raw.inFlight)) {
    throw new Error("no inFlight array");
  }
  return {
    version: 1,
    lastPollAt: typeof raw.lastPollAt === "string" ? raw.lastPollAt : null,
    inFlight: raw.inFlight.filter(isRun),
    attempts: counts(raw.attempts),
    qaFailures: counts(raw.qaFailures),
    qaFeedback: feedback(raw.qaFeedback),
  };
}

/**
 * The file store. Writes are atomic (tmp, fsync, rename). A missing file is an empty
 * state; an unreadable one is moved aside to `loop.json.corrupt-<ts>` and the loop
 * starts empty, since Linear holds the real state. The folder gets a `.gitignore`.
 */
export function createFileLoopStore(repoDir: string): LoopStore {
  const file = loopStatePath(repoDir);
  return {
    async load() {
      let text: string;
      try {
        text = await readFile(file, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyLoopState();
        throw error;
      }
      try {
        return parseLoopState(text);
      } catch {
        await rename(file, `${file}.corrupt-${Date.now()}`);
        return emptyLoopState();
      }
    },
    async save(state) {
      const dir = dirname(file);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, ".gitignore"), "*\n", { flag: "wx" }).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      });
      const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
      const handle = await open(tmp, "w");
      try {
        await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await rename(tmp, file);
      } catch (error) {
        await rm(tmp, { force: true });
        throw error;
      }
    },
  };
}
