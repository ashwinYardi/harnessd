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
  /** Set when `harnessd pause` cancelled the run: its worktree is kept (MET-15). */
  pausedAt?: string;
}

/** A run `harnessd pause` cancelled. Its worktree is kept until the sub-issue runs again. */
export interface InterruptedRun {
  issueId: string;
  issueKey: string;
  role: AgentRole;
  agent: string;
  worktree: string;
  branch: string;
  interruptedAt: string;
  reason: "paused";
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

/** One PR QA approved, waiting for the merge gate (MET-14). */
export interface MergePr {
  partId: string;
  partKey: string;
  number: number;
  url: string;
  /** The head QA reviewed and approved. Only this commit is ever merged. */
  sha: string;
  /** Set once the PR is merged, by harnessd or by a human. */
  mergedAt?: string;
  /** Why it waits for a human (protected paths, a refused merge), once it does. */
  needsHuman?: string;
  /** True once the PR carries `merge.label`. */
  labeled?: boolean;
  /** Set when the PR was closed without being merged. */
  closedAt?: string;
}

/** A QA approval of a parent's parts, waiting to be merged (docs/LOOP.md "Merge"). */
export interface PendingMerge {
  qaId: string;
  qaKey: string;
  parentId: string;
  parentKey: string;
  parentUrl: string;
  approvedAt: string;
  prs: MergePr[];
}

export interface LoopState {
  version: 1;
  /** ISO time of the last poll, null before the first. */
  lastPollAt: string | null;
  inFlight: InFlightRun[];
  /** Runs cancelled by a pause, with the worktree kept for inspection. */
  interrupted: InterruptedRun[];
  /** Failed runs per sub-issue id (D-014: one retry, then Needs input). */
  attempts: Record<string, number>;
  /** Failed QA rounds per parent issue id (D-014: the second one escalates). */
  qaFailures: Record<string, number>;
  /** Open QA requests per part sub-issue id, cleared when the part's next run succeeds. */
  qaFeedback: Record<string, QaFeedback>;
  /** QA approvals the merge gate has not finished, one per QA sub-issue. */
  merges: PendingMerge[];
  /** Failed CI or merge conflicts per parent issue id (D-014: the second one escalates). */
  gateFailures: Record<string, number>;
  /** PR URL to the time its needs-human ping went out, so it goes out once. */
  humanPings: Record<string, string>;
}

export function emptyLoopState(): LoopState {
  return {
    version: 1,
    lastPollAt: null,
    inFlight: [],
    interrupted: [],
    attempts: {},
    qaFailures: {},
    qaFeedback: {},
    merges: [],
    gateFailures: {},
    humanPings: {},
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
    typeof r.pid === "number" &&
    (r.pausedAt === undefined || typeof r.pausedAt === "string")
  );
}

function isInterrupted(value: unknown): value is InterruptedRun {
  const r = value as Partial<InterruptedRun> | null;
  return (
    typeof r === "object" &&
    r !== null &&
    typeof r.issueId === "string" &&
    typeof r.issueKey === "string" &&
    typeof r.role === "string" &&
    typeof r.agent === "string" &&
    typeof r.worktree === "string" &&
    typeof r.branch === "string" &&
    typeof r.interruptedAt === "string" &&
    r.reason === "paused"
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

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isMergePr(value: unknown): value is MergePr {
  const p = value as Partial<MergePr> | null;
  return (
    typeof p === "object" &&
    p !== null &&
    typeof p.partId === "string" &&
    typeof p.partKey === "string" &&
    typeof p.number === "number" &&
    typeof p.url === "string" &&
    typeof p.sha === "string" &&
    p.sha !== "" &&
    optionalString(p.mergedAt) &&
    optionalString(p.needsHuman) &&
    optionalString(p.closedAt) &&
    (p.labeled === undefined || typeof p.labeled === "boolean")
  );
}

function merges(value: unknown): PendingMerge[] {
  if (!Array.isArray(value)) return [];
  const out: PendingMerge[] = [];
  for (const raw of value) {
    const m = raw as Partial<PendingMerge> | null;
    if (
      typeof m !== "object" ||
      m === null ||
      typeof m.qaId !== "string" ||
      typeof m.qaKey !== "string" ||
      typeof m.parentId !== "string" ||
      typeof m.parentKey !== "string" ||
      typeof m.parentUrl !== "string" ||
      typeof m.approvedAt !== "string" ||
      !Array.isArray(m.prs) ||
      !m.prs.every(isMergePr)
    ) {
      // A half-readable approval is dropped rather than merged on a guess.
      continue;
    }
    out.push(m as PendingMerge);
  }
  return out;
}

function strings(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof value !== "object" || value === null) return out;
  for (const [key, v] of Object.entries(value)) if (typeof v === "string") out[key] = v;
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
    interrupted: Array.isArray(raw.interrupted) ? raw.interrupted.filter(isInterrupted) : [],
    attempts: counts(raw.attempts),
    qaFailures: counts(raw.qaFailures),
    qaFeedback: feedback(raw.qaFeedback),
    merges: merges(raw.merges),
    gateFailures: counts(raw.gateFailures),
    humanPings: strings(raw.humanPings),
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
