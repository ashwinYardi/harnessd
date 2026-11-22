// Loop state at `<repo>/.harnessd/state/loop.json`. Linear stays the source of truth;
// this only remembers what a crash would otherwise lose. See docs/LOOP.md.
import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  type AgentRole,
  type HarnessId,
  isHarnessId,
  type SelfUpdateState,
  type SelfUpdateView,
  type TokenSum,
} from "@harnessd/shared";
import type { WorktreeKeepReason } from "../worktrees/index.ts";

/** A sub-issue an agent is working on. */
export interface InFlightRun {
  issueId: string;
  issueKey: string;
  /** The Linear url, for notices. Older state files lack it. */
  issueUrl?: string;
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
  /** Why the run was cancelled with its worktree kept. Unset means `harnessd pause`. */
  stopReason?: "self-update";
  /** The run's excludes file, so synced files do not count as uncommitted changes. */
  excludesFile?: string;
}

/** Why a worktree is kept for the next run. */
export type InterruptedReason = "paused" | "self-update" | WorktreeKeepReason;

/** A run `harnessd pause` cancelled, or whose worktree holds unshipped work. */
export interface InterruptedRun {
  issueId: string;
  issueKey: string;
  role: AgentRole;
  agent: string;
  worktree: string;
  branch: string;
  interruptedAt: string;
  /** `paused`: `harnessd pause`. `self-update`: over budget while an update waited. */
  reason: InterruptedReason;
  /** The run's excludes file, so synced files do not count as uncommitted changes. */
  excludesFile?: string;
}

const INTERRUPTED_REASONS: Record<InterruptedReason, true> = {
  paused: true,
  "self-update": true,
  "uncommitted changes": true,
  "commits not on the remote": true,
};

/** The issue whose merge started a self-update, for the comment and the notice. */
export interface SelfUpdateTrigger {
  id: string;
  key: string;
  url?: string;
}

/** The last self-update (docs/LOOP.md "Self-update"). */
export interface SelfUpdateRecord extends SelfUpdateView {
  /** Not set for the check at daemon start. */
  trigger?: SelfUpdateTrigger;
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

/**
 * A harness that hit a usage limit (MET-70). No run starts on it while `until` is in
 * the future. An ended hold with a backoff is kept, so the next limit waits longer.
 */
export interface HarnessHold {
  /** ISO time the hold ends: the harness's reset time, or now plus the backoff. */
  until: string;
  /** ISO time the hold started. */
  since: string;
  /** The last backoff wait, when the harness gave no reset time. An ok run clears it. */
  backoffMs?: number;
  /** ISO time the hold ended; set only on a hold kept for its backoff. */
  endedAt?: string;
}

/**
 * A part whose ship step opened or found its PR. The loop reads it again on each tick, so a
 * Linear automation that moves it to In Progress does not hide it from QA (MET-128).
 */
export interface ShippedPart {
  key: string;
  /** The PR's head branch, so the state check can see whether the PR is still open. */
  branch: string;
  prUrl: string;
  at: string;
}

/** What QA decided about one part at one PR head (D-040). */
export interface ReviewedHead {
  /** The PR head sha QA read. */
  sha: string;
  verdict: "approved" | "changes_requested";
}

/**
 * The usage sum before a budget escalation. When a human moves the parent back to Ready,
 * the budget counts from this point (D-040).
 */
export interface UsageBaseline extends TokenSum {
  at: string;
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
  /** Target commit to the time its blocked or failed notice went out, so it goes out once. */
  selfUpdateNotices: Record<string, string>;
  /** The last self-update, if any. */
  selfUpdate?: SelfUpdateRecord;
  /** Harnesses held by a usage limit (MET-70). */
  limits: Partial<Record<HarnessId, HarnessHold>>;
  /** The PR head QA last judged, per part id (D-040). Optional for old files. */
  reviewedHeads?: Record<string, ReviewedHead>;
  /** Parts the ship step moved to In Review, per part id (MET-128). Optional for old files. */
  shipped?: Record<string, ShippedPart>;
  /** Tokens used per parent issue id, across grill, plan, part and QA runs (D-040). */
  usage?: Record<string, TokenSum>;
  /** Usage at the last budget escalation, per parent issue id (D-040). */
  usageBaseline?: Record<string, UsageBaseline>;
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
    selfUpdateNotices: {},
    limits: {},
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
    (r.pausedAt === undefined || typeof r.pausedAt === "string") &&
    (r.stopReason === undefined || r.stopReason === "self-update") &&
    (r.excludesFile === undefined || typeof r.excludesFile === "string")
  );
}

function interruptedRun(value: unknown): InterruptedRun | undefined {
  const r = value as Partial<InterruptedRun> | null;
  if (
    typeof r !== "object" ||
    r === null ||
    typeof r.issueId !== "string" ||
    typeof r.issueKey !== "string" ||
    typeof r.role !== "string" ||
    typeof r.agent !== "string" ||
    typeof r.worktree !== "string" ||
    typeof r.branch !== "string" ||
    typeof r.interruptedAt !== "string" ||
    // A file from before the unshipped-work reasons has no reason: it means paused.
    (r.reason !== undefined && INTERRUPTED_REASONS[r.reason] !== true) ||
    (r.excludesFile !== undefined && typeof r.excludesFile !== "string")
  ) {
    return undefined;
  }
  return {
    issueId: r.issueId,
    issueKey: r.issueKey,
    role: r.role as AgentRole,
    agent: r.agent,
    worktree: r.worktree,
    branch: r.branch,
    interruptedAt: r.interruptedAt,
    reason: r.reason ?? "paused",
    ...(r.excludesFile !== undefined ? { excludesFile: r.excludesFile } : {}),
  };
}

function interruptedRuns(value: unknown): InterruptedRun[] {
  if (!Array.isArray(value)) return [];
  return value.map(interruptedRun).filter((run): run is InterruptedRun => run !== undefined);
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

const SELF_UPDATE_STATES: readonly SelfUpdateState[] = [
  "pending",
  "applying",
  "done",
  "blocked",
  "failed",
];

function selfUpdate(value: unknown): SelfUpdateRecord | undefined {
  const u = value as Partial<SelfUpdateRecord> | null;
  if (
    typeof u !== "object" ||
    u === null ||
    typeof u.from !== "string" ||
    typeof u.to !== "string" ||
    typeof u.at !== "string" ||
    !SELF_UPDATE_STATES.includes(u.state as SelfUpdateState)
  ) {
    return undefined;
  }
  const out: SelfUpdateRecord = {
    from: u.from,
    to: u.to,
    at: u.at,
    state: u.state as SelfUpdateState,
  };
  if (typeof u.error === "string") out.error = u.error;
  const t = u.trigger as Partial<SelfUpdateTrigger> | undefined;
  if (
    typeof t === "object" &&
    t !== null &&
    typeof t.id === "string" &&
    typeof t.key === "string"
  ) {
    out.trigger = { id: t.id, key: t.key, ...(typeof t.url === "string" ? { url: t.url } : {}) };
  }
  return out;
}

function holds(value: unknown): Partial<Record<HarnessId, HarnessHold>> {
  const out: Partial<Record<HarnessId, HarnessHold>> = {};
  if (typeof value !== "object" || value === null) return out;
  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    const h = raw as Partial<HarnessHold> | null;
    if (!isHarnessId(id) || typeof h !== "object" || h === null) continue;
    if (typeof h.until !== "string" || typeof h.since !== "string") continue;
    const hold: HarnessHold = { until: h.until, since: h.since };
    if (typeof h.backoffMs === "number" && h.backoffMs > 0) hold.backoffMs = h.backoffMs;
    if (typeof h.endedAt === "string") hold.endedAt = h.endedAt;
    out[id] = hold;
  }
  return out;
}

function reviewedHeads(value: unknown): Record<string, ReviewedHead> {
  const out: Record<string, ReviewedHead> = {};
  if (typeof value !== "object" || value === null) return out;
  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    const h = raw as Partial<ReviewedHead> | null;
    if (typeof h !== "object" || h === null) continue;
    if (typeof h.sha !== "string" || h.sha === "") continue;
    if (h.verdict !== "approved" && h.verdict !== "changes_requested") continue;
    out[id] = { sha: h.sha, verdict: h.verdict };
  }
  return out;
}

function shippedParts(value: unknown): Record<string, ShippedPart> {
  const out: Record<string, ShippedPart> = {};
  if (typeof value !== "object" || value === null) return out;
  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    const p = raw as Partial<ShippedPart> | null;
    if (typeof p !== "object" || p === null) continue;
    if (typeof p.key !== "string" || p.key === "") continue;
    if (typeof p.branch !== "string" || p.branch === "") continue;
    out[id] = {
      key: p.key,
      branch: p.branch,
      prUrl: typeof p.prUrl === "string" ? p.prUrl : "",
      at: typeof p.at === "string" ? p.at : "",
    };
  }
  return out;
}

function tokenSum(value: unknown): TokenSum | undefined {
  const s = value as Partial<TokenSum> | null;
  if (typeof s !== "object" || s === null) return undefined;
  const part = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : 0);
  return { input: part(s.input), cached: part(s.cached), output: part(s.output) };
}

function usageSums(value: unknown): Record<string, TokenSum> {
  const out: Record<string, TokenSum> = {};
  if (typeof value !== "object" || value === null) return out;
  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    const sum = tokenSum(raw);
    if (sum !== undefined) out[id] = sum;
  }
  return out;
}

function usageBaselines(value: unknown): Record<string, UsageBaseline> {
  const out: Record<string, UsageBaseline> = {};
  if (typeof value !== "object" || value === null) return out;
  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    const b = raw as Partial<UsageBaseline> | null;
    const sum = tokenSum(raw);
    if (sum === undefined || typeof b !== "object" || b === null) continue;
    if (typeof b.at !== "string") continue;
    out[id] = { ...sum, at: b.at };
  }
  return out;
}

/** Reads a state file's JSON, keeping only well-formed parts. Throws on anything unreadable. */
export function parseLoopState(text: string): LoopState {
  const raw = JSON.parse(text) as Partial<LoopState> | null;
  if (typeof raw !== "object" || raw === null || !Array.isArray(raw.inFlight)) {
    throw new Error("no inFlight array");
  }
  const update = selfUpdate(raw.selfUpdate);
  return {
    version: 1,
    lastPollAt: typeof raw.lastPollAt === "string" ? raw.lastPollAt : null,
    inFlight: raw.inFlight.filter(isRun),
    interrupted: interruptedRuns(raw.interrupted),
    attempts: counts(raw.attempts),
    qaFailures: counts(raw.qaFailures),
    qaFeedback: feedback(raw.qaFeedback),
    merges: merges(raw.merges),
    gateFailures: counts(raw.gateFailures),
    humanPings: strings(raw.humanPings),
    selfUpdateNotices: strings(raw.selfUpdateNotices),
    ...(update ? { selfUpdate: update } : {}),
    limits: holds(raw.limits),
    ...(raw.reviewedHeads === undefined ? {} : { reviewedHeads: reviewedHeads(raw.reviewedHeads) }),
    ...(raw.shipped === undefined ? {} : { shipped: shippedParts(raw.shipped) }),
    ...(raw.usage === undefined ? {} : { usage: usageSums(raw.usage) }),
    ...(raw.usageBaseline === undefined
      ? {}
      : { usageBaseline: usageBaselines(raw.usageBaseline) }),
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
