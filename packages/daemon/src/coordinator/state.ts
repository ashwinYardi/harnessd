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
import type { ReviewEvent } from "../github/client.ts";
import type { WorktreeKeepReason } from "../worktrees/index.ts";
import type { ReviewEscalation, ReviewFinding, ReviewNotJudged } from "./review.ts";

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

/** One failing item of a QA verdict, with how to reproduce it (D-054). */
export interface QaCase {
  /** C1, C2, … in reply order, or T1 for a case the daemon built itself. */
  id: string;
  /** The exact text of a failing verdict item, or `Tests` / `Verify`. */
  item: string;
  /** The exact command or numbered steps that reproduce the failure. */
  repro: string;
  /** What should happen. */
  expected: string;
  /** What happened. */
  actual: string;
}

/** What QA or the reviewer asked a part to fix; its next run's prompt carries it. */
export interface QaFeedback {
  /** Who sent the part back: QA by default, `review` for a reviewer send-back (MET-225). */
  source?: "qa" | "review";
  /** The part's PR, when one was found. */
  prUrl?: string;
  /** The request-changes review, when it was posted. */
  reviewUrl?: string;
  /** One line per failing item: the item and its evidence. */
  failing: string[];
  /** The last lines of the tests when they failed, for the resume prompt (MET-156). */
  testTail?: string;
  /** Each failing case with its repro, for the numbered send-back list (D-054). */
  cases?: QaCase[];
}

/** A part run's session, so a QA send-back can resume it (MET-156). */
export interface PartSession {
  harness: HarnessId;
  sessionId: string;
  /** The worktree and branch the session ran in; a different one starts cold. */
  worktree: string;
  branch: string;
  at: string;
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
  /** The failing cases QA recorded, kept for a re-QA after the send-back (D-054). */
  cases?: QaCase[];
}

/** What the reviewer decided about one part at one PR head (MET-224, D-060). */
export interface ReviewerHead {
  /** The PR head sha the reviewer read. */
  sha: string;
  verdict: "approved" | "changes_requested";
  /** Every finding, blocking and nit, with its file and line. */
  findings: ReviewFinding[];
  at: string;
}

/**
 * A review the daemon could not post (MET-224, D-058). The verdict is already in
 * `reviewerHeads`; the loop retries only the PR comment on each tick.
 */
export interface PendingReview {
  partId: string;
  partKey: string;
  parentId: string;
  prNumber: number;
  prUrl: string;
  head: string;
  body: string;
  /** The judged verdict, so the settle runs after a failed post is retried (MET-225). */
  verdict?: "approved" | "changes_requested";
  /** The verdict's findings, kept with the verdict for that settle. */
  findings?: ReviewFinding[];
  /** True once the PR comment is posted; the settle then runs and drops the record. */
  posted?: boolean;
  /** The posted review, once a retry succeeds. */
  reviewUrl?: string;
  /** The settle steps already done, by the name the log gives them (D-058). */
  done?: string[];
}

/**
 * A review settlement a network error left unfinished, per part id (MET-230, D-058). It
 * holds the settle inputs and the done steps, so the loop can retry an escalation that has
 * no PR comment record to replay.
 */
export interface PendingReviewSettle {
  partId: string;
  partKey: string;
  parentId: string;
  prNumber: number;
  prUrl: string;
  head: string;
  /** The judged verdict, when the settlement applies one. */
  verdict?: "approved" | "changes_requested";
  findings?: ReviewFinding[];
  /** Why the review could not judge the head. */
  notJudged?: ReviewNotJudged;
  /**
   * The not-judged escalation this settle already decided, with its reasons in order
   * (MET-232, D-052). A replay applies it instead of counting the run again.
   */
  escalation?: ReviewEscalation;
  /** The run's error, for a failed review. */
  error?: string;
  /** The posted review, when there is one. */
  reviewUrl?: string;
  /** The settle steps already done, by the name the log gives them. */
  done: string[];
}

/**
 * The usage sum before a budget escalation. When a human moves the parent back to Ready,
 * the budget counts from this point (D-040).
 */
export interface UsageBaseline extends TokenSum {
  at: string;
}

/**
 * A Ready parent the loop split, by parent id (MET-154). Linear reads can lag a few seconds
 * behind writes, so this guards against a second grill and split from a stale read. Dropped
 * when Linear shows the parent Done or Canceled, or when the owner canceled every part.
 */
export interface SplitRecord {
  key: string;
  /** The work-part ids this split created or reused. */
  parts: string[];
  /** The QA sub-issue id. */
  qa: string;
  at: string;
}

/**
 * A run that must move to the next harness in the role order (D-048). The next dispatch of
 * that issue picks the first usable harness after `from`.
 */
export interface HarnessSwitch {
  from: HarnessId;
  /** Why it moved, as the log says it: "timed out", "stalled", "hit its usage limit", … */
  reason: string;
  at: string;
}

/** One review of a QA round that a network error left to post (MET-213, D-058). */
export interface PendingQaReview {
  partId: string;
  partKey: string;
  decision: "approve" | "request_changes" | "error";
  failing: string[];
  cases?: QaCase[];
  /** The PR and the head the review names. Unset when the review had no PR. */
  prNumber?: number;
  prUrl?: string;
  head?: string;
  /** The review event and body to post on the retry. */
  event?: ReviewEvent;
  body?: string;
  /** True once the review is posted, or it had no post to make. */
  done: boolean;
  /** Kept for the settle: a setup error, a not-judged reason, its evidence. */
  setup?: boolean;
  /** True when the PR head moved while QA ran; such a verdict is never settled (MET-226). */
  stale?: boolean;
  notJudged?: "turn_cap" | "timeout" | "stalled" | "not_json" | "no_cases";
  error?: string;
  testTail?: string;
  reviewUrl?: string;
  postedAs?: ReviewEvent;
}

/**
 * A QA verdict a network error left unfinished, per QA sub-issue id (MET-213, D-058).
 * The loop posts each review not done, then runs the settle with its done steps skipped,
 * early in every tick until nothing is left.
 */
export interface PendingQa {
  parentId: string;
  qaKey?: string;
  reviews: PendingQaReview[];
  /** The settle steps already done, by the name the log gives them. */
  done: string[];
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
  /** Failed review rounds per part id (MET-225, D-014: the second one escalates). */
  reviewFailures: Record<string, number>;
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
  /** The PR head the reviewer last judged, per part id (MET-224, D-060). */
  reviewerHeads?: Record<string, ReviewerHead>;
  /** Review comments a failed post left to send, per part id (MET-224, D-058). */
  pendingReview?: Record<string, PendingReview>;
  /** Review settlements a network error left unfinished, per part id (MET-230, D-058). */
  pendingReviewSettle?: Record<string, PendingReviewSettle>;
  /** Parts the ship step moved to In Review, per part id (MET-128). Optional for old files. */
  shipped?: Record<string, ShippedPart>;
  /** Tokens used per parent issue id, across grill, plan, part and QA runs (D-040). */
  usage?: Record<string, TokenSum>;
  /** Usage at the last budget escalation, per parent issue id (D-040). */
  usageBaseline?: Record<string, UsageBaseline>;
  /** Parents the loop split, per parent issue id (MET-154). Optional for old files. */
  splits?: Record<string, SplitRecord>;
  /** The last session of each part run, per part id (MET-156). Optional for old files. */
  sessions?: Record<string, PartSession>;
  /** The next harness to try, per issue id (D-048). Optional for old files. */
  harnessSwitch?: Record<string, HarnessSwitch>;
  /** QA verdicts a network error left to post and settle, per QA sub-issue id (MET-213). */
  pendingQa?: Record<string, PendingQa>;
  /**
   * When a split note first warned that the repo runs no live app (MET-180). Optional, so a
   * file from before it loads; the warning comes again only when the key is removed.
   */
  qaLiveWarned?: string;
}

export function emptyLoopState(): LoopState {
  return {
    version: 1,
    lastPollAt: null,
    inFlight: [],
    interrupted: [],
    attempts: {},
    qaFailures: {},
    reviewFailures: {},
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

function isQaCase(value: unknown): value is QaCase {
  const c = value as Partial<QaCase> | null;
  const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
  return (
    typeof c === "object" &&
    c !== null &&
    nonEmpty(c.id) &&
    nonEmpty(c.item) &&
    nonEmpty(c.repro) &&
    nonEmpty(c.expected) &&
    nonEmpty(c.actual)
  );
}

/** The cases array, or undefined when absent or any entry is malformed (D-054). */
function qaCases(value: unknown): QaCase[] | undefined {
  if (!Array.isArray(value) || !value.every(isQaCase)) return undefined;
  return value;
}

function feedback(value: unknown): Record<string, QaFeedback> {
  const out: Record<string, QaFeedback> = {};
  if (typeof value !== "object" || value === null) return out;
  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    const f = raw as Partial<QaFeedback> | null;
    if (typeof f !== "object" || f === null || !Array.isArray(f.failing)) continue;
    const entry: QaFeedback = { failing: f.failing.filter((l) => typeof l === "string") };
    if (f.source === "qa" || f.source === "review") entry.source = f.source;
    if (typeof f.prUrl === "string") entry.prUrl = f.prUrl;
    if (typeof f.reviewUrl === "string") entry.reviewUrl = f.reviewUrl;
    if (typeof f.testTail === "string") entry.testTail = f.testTail;
    const cases = qaCases(f.cases);
    if (cases !== undefined) entry.cases = cases;
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
    const entry: ReviewedHead = { sha: h.sha, verdict: h.verdict };
    const cases = qaCases(h.cases);
    if (cases !== undefined) entry.cases = cases;
    out[id] = entry;
  }
  return out;
}

function reviewFinding(value: unknown): ReviewFinding | undefined {
  const f = value as Partial<ReviewFinding> | null;
  if (typeof f !== "object" || f === null) return undefined;
  if (typeof f.file !== "string" || f.file.trim() === "") return undefined;
  if (typeof f.line !== "number" || !Number.isInteger(f.line) || f.line < 1) return undefined;
  if (f.severity !== "blocking" && f.severity !== "nit") return undefined;
  if (f.kind !== "code" && f.kind !== "design") return undefined;
  if (typeof f.text !== "string" || f.text.trim() === "") return undefined;
  return {
    file: f.file,
    line: f.line,
    severity: f.severity,
    kind: f.kind,
    text: f.text,
  };
}

function reviewFindings(value: unknown): ReviewFinding[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: ReviewFinding[] = [];
  for (const raw of value) {
    const finding = reviewFinding(raw);
    if (finding === undefined) return undefined;
    out.push(finding);
  }
  return out;
}

function reviewerHeads(value: unknown): Record<string, ReviewerHead> {
  const out: Record<string, ReviewerHead> = {};
  if (typeof value !== "object" || value === null) return out;
  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    const h = raw as Partial<ReviewerHead> | null;
    if (typeof h !== "object" || h === null) continue;
    if (typeof h.sha !== "string" || h.sha === "") continue;
    if (h.verdict !== "approved" && h.verdict !== "changes_requested") continue;
    const findings = reviewFindings(h.findings);
    if (findings === undefined) continue;
    if (typeof h.at !== "string" || h.at === "") continue;
    out[id] = { sha: h.sha, verdict: h.verdict, findings, at: h.at };
  }
  return out;
}

/** A half-readable pending review is dropped: its comment cannot be replayed safely. */
function pendingReviews(value: unknown): Record<string, PendingReview> {
  const out: Record<string, PendingReview> = {};
  if (typeof value !== "object" || value === null) return out;
  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    const r = raw as Partial<PendingReview> | null;
    if (typeof r !== "object" || r === null) continue;
    if (typeof r.partId !== "string" || r.partId === "") continue;
    if (typeof r.partKey !== "string" || r.partKey === "") continue;
    if (typeof r.parentId !== "string" || r.parentId === "") continue;
    if (typeof r.prNumber !== "number" || !Number.isInteger(r.prNumber) || r.prNumber <= 0) {
      continue;
    }
    if (typeof r.prUrl !== "string") continue;
    if (typeof r.head !== "string" || r.head === "") continue;
    if (typeof r.body !== "string") continue;
    if (r.reviewUrl !== undefined && typeof r.reviewUrl !== "string") continue;
    if (r.verdict !== undefined && r.verdict !== "approved" && r.verdict !== "changes_requested") {
      continue;
    }
    if (r.posted !== undefined && typeof r.posted !== "boolean") continue;
    if (
      r.done !== undefined &&
      (!Array.isArray(r.done) || !r.done.every((s) => typeof s === "string"))
    ) {
      continue;
    }
    const findings = r.findings === undefined ? undefined : reviewFindings(r.findings);
    if (r.findings !== undefined && findings === undefined) continue;
    out[id] = {
      partId: r.partId,
      partKey: r.partKey,
      parentId: r.parentId,
      prNumber: r.prNumber,
      prUrl: r.prUrl,
      head: r.head,
      body: r.body,
      ...(r.verdict === undefined ? {} : { verdict: r.verdict }),
      ...(findings === undefined ? {} : { findings }),
      ...(r.posted === undefined ? {} : { posted: r.posted }),
      ...(r.reviewUrl === undefined ? {} : { reviewUrl: r.reviewUrl }),
      ...(r.done === undefined ? {} : { done: r.done }),
    };
  }
  return out;
}

/** A half-readable pending settlement is dropped: its writes cannot be replayed safely. */
function pendingReviewSettles(value: unknown): Record<string, PendingReviewSettle> {
  const out: Record<string, PendingReviewSettle> = {};
  if (typeof value !== "object" || value === null) return out;
  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    const r = raw as Partial<PendingReviewSettle> | null;
    if (typeof r !== "object" || r === null) continue;
    if (typeof r.partId !== "string" || r.partId === "") continue;
    if (typeof r.partKey !== "string" || r.partKey === "") continue;
    if (typeof r.parentId !== "string" || r.parentId === "") continue;
    if (typeof r.prNumber !== "number" || !Number.isInteger(r.prNumber) || r.prNumber <= 0) {
      continue;
    }
    if (typeof r.prUrl !== "string") continue;
    if (typeof r.head !== "string" || r.head === "") continue;
    if (r.verdict !== undefined && r.verdict !== "approved" && r.verdict !== "changes_requested") {
      continue;
    }
    if (r.notJudged !== undefined && !isReviewNotJudged(r.notJudged)) continue;
    if (!optionalString(r.error) || !optionalString(r.reviewUrl)) continue;
    const findings = r.findings === undefined ? undefined : reviewFindings(r.findings);
    if (r.findings !== undefined && findings === undefined) continue;
    const escalation = r.escalation === undefined ? undefined : reviewEscalation(r.escalation);
    if (r.escalation !== undefined && escalation === undefined) continue;
    if (!Array.isArray(r.done) || !r.done.every((step) => typeof step === "string")) continue;
    out[id] = {
      partId: r.partId,
      partKey: r.partKey,
      parentId: r.parentId,
      prNumber: r.prNumber,
      prUrl: r.prUrl,
      head: r.head,
      ...(r.verdict === undefined ? {} : { verdict: r.verdict }),
      ...(findings === undefined ? {} : { findings }),
      ...(r.notJudged === undefined ? {} : { notJudged: r.notJudged }),
      ...(escalation === undefined ? {} : { escalation }),
      ...(r.error === undefined ? {} : { error: r.error }),
      ...(r.reviewUrl === undefined ? {} : { reviewUrl: r.reviewUrl }),
      done: r.done,
    };
  }
  return out;
}

function reviewEscalation(value: unknown): ReviewEscalation | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const e = value as Partial<ReviewEscalation>;
  if (!Array.isArray(e.reasons) || e.reasons.length === 0) return undefined;
  if (!e.reasons.every((reason) => typeof reason === "string" && reason !== "")) return undefined;
  return { reasons: e.reasons };
}

function isReviewNotJudged(value: unknown): value is ReviewNotJudged {
  return value === "turn_cap" || value === "timeout" || value === "stalled" || value === "not_json";
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

function splitRecords(value: unknown): Record<string, SplitRecord> {
  const out: Record<string, SplitRecord> = {};
  if (typeof value !== "object" || value === null) return out;
  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    const s = raw as Partial<SplitRecord> | null;
    if (typeof s !== "object" || s === null) continue;
    if (typeof s.key !== "string" || s.key === "") continue;
    if (!Array.isArray(s.parts) || s.parts.length === 0) continue;
    if (!s.parts.every((p) => typeof p === "string" && p !== "")) continue;
    if (typeof s.qa !== "string" || s.qa === "") continue;
    if (typeof s.at !== "string" || s.at === "") continue;
    out[id] = { key: s.key, parts: s.parts, qa: s.qa, at: s.at };
  }
  return out;
}

function harnessSwitches(value: unknown): Record<string, HarnessSwitch> {
  const out: Record<string, HarnessSwitch> = {};
  if (typeof value !== "object" || value === null) return out;
  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    const s = raw as Partial<HarnessSwitch> | null;
    if (typeof s !== "object" || s === null) continue;
    if (typeof s.from !== "string" || !isHarnessId(s.from)) continue;
    if (typeof s.reason !== "string" || s.reason === "") continue;
    if (typeof s.at !== "string" || s.at === "") continue;
    out[id] = { from: s.from, reason: s.reason, at: s.at };
  }
  return out;
}

function pendingQaReview(value: unknown): PendingQaReview | undefined {
  const r = value as Partial<PendingQaReview> | null;
  if (typeof r !== "object" || r === null) return undefined;
  if (typeof r.partId !== "string" || r.partId === "") return undefined;
  if (typeof r.partKey !== "string" || r.partKey === "") return undefined;
  if (r.decision !== "approve" && r.decision !== "request_changes" && r.decision !== "error") {
    return undefined;
  }
  if (!Array.isArray(r.failing) || !r.failing.every((line) => typeof line === "string")) {
    return undefined;
  }
  if (typeof r.done !== "boolean") return undefined;
  if (r.cases !== undefined && qaCases(r.cases) === undefined) return undefined;
  const optionalEvent = (v: unknown): v is ReviewEvent | undefined =>
    v === undefined || v === "APPROVE" || v === "REQUEST_CHANGES" || v === "COMMENT";
  if (
    !optionalString(r.prUrl) ||
    !optionalString(r.head) ||
    !optionalString(r.body) ||
    !optionalString(r.error) ||
    !optionalString(r.testTail) ||
    !optionalString(r.reviewUrl) ||
    !optionalEvent(r.event) ||
    !optionalEvent(r.postedAs) ||
    (r.setup !== undefined && typeof r.setup !== "boolean") ||
    (r.stale !== undefined && typeof r.stale !== "boolean") ||
    (r.notJudged !== undefined &&
      r.notJudged !== "turn_cap" &&
      r.notJudged !== "timeout" &&
      r.notJudged !== "stalled" &&
      r.notJudged !== "not_json" &&
      r.notJudged !== "no_cases") ||
    (r.prNumber !== undefined &&
      (typeof r.prNumber !== "number" || !Number.isInteger(r.prNumber) || r.prNumber <= 0))
  ) {
    return undefined;
  }
  if (!r.done && (r.prNumber === undefined || !r.head || !r.event || r.body === undefined)) {
    return undefined;
  }
  const out: PendingQaReview = {
    partId: r.partId,
    partKey: r.partKey,
    decision: r.decision,
    failing: r.failing,
    done: r.done,
  };
  const cases = qaCases(r.cases);
  if (cases !== undefined) out.cases = cases;
  if (r.prNumber !== undefined) out.prNumber = r.prNumber;
  if (r.prUrl !== undefined) out.prUrl = r.prUrl;
  if (r.head !== undefined) out.head = r.head;
  if (r.event !== undefined) out.event = r.event;
  if (r.body !== undefined) out.body = r.body;
  if (r.setup !== undefined) out.setup = r.setup;
  if (r.stale !== undefined) out.stale = r.stale;
  if (r.notJudged !== undefined) out.notJudged = r.notJudged;
  if (r.error !== undefined) out.error = r.error;
  if (r.testTail !== undefined) out.testTail = r.testTail;
  if (r.reviewUrl !== undefined) out.reviewUrl = r.reviewUrl;
  if (r.postedAs !== undefined) out.postedAs = r.postedAs;
  return out;
}

/** A half-readable pending QA record is dropped: its verdict cannot be replayed safely. */
function pendingQaRecords(value: unknown): Record<string, PendingQa> {
  const out: Record<string, PendingQa> = {};
  if (typeof value !== "object" || value === null) return out;
  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    const p = raw as Partial<PendingQa> | null;
    if (typeof p !== "object" || p === null) continue;
    if (typeof p.parentId !== "string" || p.parentId === "") continue;
    if (!Array.isArray(p.reviews)) continue;
    const reviews = p.reviews.map(pendingQaReview);
    if (reviews.some((review) => review === undefined)) continue;
    if (!Array.isArray(p.done) || !p.done.every((step) => typeof step === "string")) continue;
    const entry: PendingQa = {
      parentId: p.parentId,
      reviews: reviews as PendingQaReview[],
      done: p.done,
    };
    if (typeof p.qaKey === "string") entry.qaKey = p.qaKey;
    out[id] = entry;
  }
  return out;
}

function partSessions(value: unknown): Record<string, PartSession> {
  const out: Record<string, PartSession> = {};
  if (typeof value !== "object" || value === null) return out;
  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    const s = raw as Partial<PartSession> | null;
    if (typeof s !== "object" || s === null) continue;
    if (typeof s.harness !== "string" || !isHarnessId(s.harness)) continue;
    if (typeof s.sessionId !== "string" || s.sessionId === "") continue;
    if (typeof s.worktree !== "string" || s.worktree === "") continue;
    if (typeof s.branch !== "string" || s.branch === "") continue;
    if (typeof s.at !== "string" || s.at === "") continue;
    out[id] = {
      harness: s.harness,
      sessionId: s.sessionId,
      worktree: s.worktree,
      branch: s.branch,
      at: s.at,
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
    reviewFailures: counts(raw.reviewFailures),
    qaFeedback: feedback(raw.qaFeedback),
    merges: merges(raw.merges),
    gateFailures: counts(raw.gateFailures),
    humanPings: strings(raw.humanPings),
    selfUpdateNotices: strings(raw.selfUpdateNotices),
    ...(update ? { selfUpdate: update } : {}),
    limits: holds(raw.limits),
    ...(raw.reviewedHeads === undefined ? {} : { reviewedHeads: reviewedHeads(raw.reviewedHeads) }),
    ...(raw.reviewerHeads === undefined ? {} : { reviewerHeads: reviewerHeads(raw.reviewerHeads) }),
    ...(raw.pendingReview === undefined
      ? {}
      : { pendingReview: pendingReviews(raw.pendingReview) }),
    ...(raw.pendingReviewSettle === undefined
      ? {}
      : { pendingReviewSettle: pendingReviewSettles(raw.pendingReviewSettle) }),
    ...(raw.shipped === undefined ? {} : { shipped: shippedParts(raw.shipped) }),
    ...(raw.usage === undefined ? {} : { usage: usageSums(raw.usage) }),
    ...(raw.usageBaseline === undefined
      ? {}
      : { usageBaseline: usageBaselines(raw.usageBaseline) }),
    ...(raw.splits === undefined ? {} : { splits: splitRecords(raw.splits) }),
    ...(raw.sessions === undefined ? {} : { sessions: partSessions(raw.sessions) }),
    ...(raw.harnessSwitch === undefined
      ? {}
      : { harnessSwitch: harnessSwitches(raw.harnessSwitch) }),
    ...(raw.pendingQa === undefined ? {} : { pendingQa: pendingQaRecords(raw.pendingQa) }),
    ...(typeof raw.qaLiveWarned === "string" && raw.qaLiveWarned !== ""
      ? { qaLiveWarned: raw.qaLiveWarned }
      : {}),
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
