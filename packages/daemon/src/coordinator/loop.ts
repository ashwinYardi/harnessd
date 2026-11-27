// The autonomy loop (SPEC "Autonomy loop" steps 1-7, D-010, D-012, D-013, D-014). See docs/LOOP.md.
//
// Each tick: re-queue runs a previous process left behind, check the pause flag, advance
// the merge gate, dispatch eligible sub-issues, grill and split Ready issues, then dispatch
// again. Linear is the source of truth; loop.json only remembers in-flight runs, paused
// runs, failure counts and QA approvals waiting to merge.

import { join } from "node:path";
import {
  type AdapterEvent,
  type AdapterRun,
  type Call,
  emptyTokenUsage,
  type HarnessAdapter,
  type HarnessId,
  type HarnessLimit,
  harnessName,
  type Issue,
  type LinkedIssue,
  limitAvailableLine,
  limitHoldLine,
  type MergedConfig,
  type ResolvedAgentConfig,
  type RunResult,
  type SelfUpdateView,
  type Task,
  type TokenSum,
  type TokenUsage,
  weightedTokens,
} from "@harnessd/shared";
import { resolveAgentConfig } from "../config/merge.ts";
import type { GitHub, PullRequest } from "../github/client.ts";
import type { LinearClient, ListReadyOptions } from "../linear/client.ts";
import { isNetworkError } from "../net-error.ts";
import {
  lastLines,
  type SelfUpdateResult,
  type SelfUpdater,
  shortSha,
} from "../selfupdate/index.ts";
import type { TaskWorktrees, WorktreeKeepReason } from "../worktrees/index.ts";
import { createFileDecisionSink, type DecisionSink, workspaceVaultDir } from "./decisions.ts";
import {
  agentForRole,
  budgetMs,
  buildPartPrompt,
  buildResumePrompt,
  maxTurns as maxTurnsFor,
} from "./dispatch.ts";
import { grillIssue } from "./grill.ts";
import {
  activeLimits,
  afterLimited,
  afterOk,
  type HarnessAvailability,
  type HarnessSkipReason,
  type HoldEvent,
  harnessCandidates,
  harnessForRun,
  harnessSkip,
  isHeld,
  pickHarness,
  releaseExpired,
  switchWhy,
} from "./limits.ts";
import { advanceMerges, pendingMerge } from "./merge.ts";
import { type Notifier, NullNotifier } from "./notifier.ts";
import { planIssue, type SplitPlan } from "./plan.ts";
import { type AgentMemory, type GrillContext, loadGrillContext } from "./prompt.ts";
import {
  type CommandRunner,
  type PrReview,
  postQaReview,
  type QaRunResult,
  runQa,
  settleQa,
} from "./qa.ts";
import type { ReviewFinding, ReviewRunResult, ReviewSettleInput } from "./review.ts";
import { runReview, settleReview } from "./review.ts";
import { type ShipResult, type ShipRun, shipPart } from "./ship.ts";
import {
  formatSplitComment,
  isCanceledState,
  isLiveChild,
  isWorkPart,
  noLiveQaWarning,
  PART_MARKER_PREFIX,
  partIds,
  readPartMarker,
  type SubIssueRole,
  splitIssue,
} from "./split.ts";
import type {
  HarnessHold,
  HarnessSwitch,
  InFlightRun,
  InterruptedReason,
  InterruptedRun,
  LoopState,
  LoopStore,
  PartSession,
  PendingQa,
  PendingQaReview,
  PendingReview,
  ReviewedHead,
  ReviewerHead,
  SelfUpdateRecord,
  SelfUpdateTrigger,
} from "./state.ts";
import { excludesFileFor, syncWorktree } from "./worktree-sync.ts";

/** The Linear calls the loop makes. A LinearClient satisfies it. */
export type LoopLinear = Pick<
  LinearClient,
  | "listReady"
  | "listReadyContaining"
  | "listChildren"
  | "createSubIssue"
  | "createBlocksRelation"
  | "moveTo"
  | "comment"
  | "getIssue"
> & {
  /** Drops the pooled connections after 3 failed ticks (MET-213); a fake may omit it. */
  resetConnections?(): void;
};

export interface LoopClock {
  now(): Date;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export const systemClock: LoopClock = {
  now: () => new Date(),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

export const DEFAULT_LOOP_INTERVAL_MS = 30_000;

/** How often the pause flag is re-read while runs are in flight (MET-15: stop within 10 s). */
export const DEFAULT_PAUSE_WATCH_MS = 1_000;

/** Appended to the prompt when a run picks up the worktree a pause kept. */
export const RESUMED_RUN_NOTE =
  "## Resumed\nA previous run of this task was stopped by `harnessd pause`. Its work, committed or not, is still in this worktree. Check `git status` and `git log`, then continue from it.";

/** Failed runs of one sub-issue before it goes to Needs input (D-014: back to Ready once). */
export const MAX_RUN_ATTEMPTS = 2;

/** What the loop needs for self-update (MET-63, docs/LOOP.md "Self-update"). */
export interface LoopSelfUpdate {
  updater: SelfUpdater;
  /** Writes paused.json with the reason, so the pause survives a restart. */
  pause(reason: string): Promise<unknown>;
}

/** The part of a status check the harness order needs (D-048). */
export interface HarnessCheck {
  id: string;
  state: "ok" | "warn" | "fail" | "missing";
}

export interface CoordinatorLoopOptions {
  config: MergedConfig;
  linear: LoopLinear;
  /** One adapter per harness the agents use. */
  adapters: Partial<Record<HarnessId, HarnessAdapter>>;
  worktrees: TaskWorktrees;
  /** QA reviews and the merge gate merges PRs through it (the `gh` CLI, D-002). */
  github: GitHub;
  store: LoopStore;
  clock?: LoopClock;
  /** The repo: grill and plan runs read it, and its docs are the spec context. */
  repoDir: string;
  /** Which Ready issues are ours. */
  team: ListReadyOptions;
  notifier?: Notifier;
  /** Default: the workspace vault. */
  decisions?: DecisionSink;
  /** Default: loadGrillContext(repoDir, { skillsDir }), read once per tick that has issues to split. */
  context?: () => Promise<GrillContext>;
  /** The installed skill pack (`~/.harnessd/skills`). The grill reads its method from it (D-022). */
  skillsDir?: string;
  /**
   * The global folder (`~/.harnessd` or `$HARNESSD_HOME`). When set, every part and QA
   * run first gets `harnessd sync` into its worktree, from this folder and the repo's
   * `.harnessd/`, and its prompt names the memory vaults (MET-55, docs/LOOP.md).
   */
  globalDir?: string;
  intervalMs?: number;
  /**
   * The pause flag (MET-15), read at the start of every tick and, while runs are in
   * flight, every `pauseWatchMs`. While it returns true the loop dispatches nothing and
   * cancels what is running.
   */
  paused?: () => boolean | Promise<boolean>;
  /** Default DEFAULT_PAUSE_WATCH_MS. Keep it at 2 s or less. */
  pauseWatchMs?: number;
  /** Runs `qa.setup_command` and `qa.test_command` in QA worktrees. Default `sh -c`. */
  runCommand?: CommandRunner;
  log?: (line: string) => void;
  /** Every event of every sub-issue run, for the UI's live log (MET-18). */
  onAgentEvent?: (run: { issueKey: string; agent: string }, event: AdapterEvent) => void;
  /** Each harness hold that starts or ends, for the daily summary (MET-82). */
  onHold?: (event: HoldEvent) => void;
  /** Recorded as the owner of runs. Default this process. */
  pid?: number;
  /** Not set when `[daemon] self_update = false`: then the loop never updates itself. */
  selfUpdate?: LoopSelfUpdate;
  /**
   * The status checks the loop holds from start or POST /api/start (D-048). A harness whose
   * `harness.<id>.cli` or `harness.<id>.auth` check is fail or missing is skipped. The loop
   * runs no new check per tick. Default: no checks, so no harness is skipped for that reason.
   */
  harnessChecks?: () => readonly HarnessCheck[] | undefined;
  /**
   * Commits, pushes and opens or updates the PR after an ok part run (MET-109).
   * Default `shipPart`; tests pass a fake or the real one over a temp repo.
   */
  ship?: ShipRun;
}

/** The run fields the worktree guard needs, from an in-flight or interrupted run. */
type KeptRun = Pick<
  InFlightRun,
  "issueId" | "issueKey" | "role" | "agent" | "branch" | "excludesFile"
>;

/** What a QA run checks: the parent's checklist and the parts that block QA. */
interface QaContext {
  parent: Issue;
  parts: LinkedIssue[];
  approvedHeads: Record<string, string>;
}

/** A run this process started. */
interface LiveRun {
  key: string;
  entry: InFlightRun;
  /** The agent run. A QA round has one only while its QA agent runs. */
  run?: AdapterRun;
  /** A QA round's stop switch: aborting it stops the tests, the agent and the reviews. */
  abort?: AbortController;
  /** Settles once the run has finished and been recorded. */
  done: Promise<void>;
  title: string;
  budgetMs: number;
  /** Input plus output tokens so far. */
  tokens: number;
  /** The harness this run really started on (D-048). */
  harness: HarnessId;
  /** Why it is not the agent's configured harness (D-048). */
  switchReason?: string;
  lastAction?: string;
}

/** A sub-issue run as the UI shows it (MET-18). */
export interface RunActivity {
  issueId: string;
  issueKey: string;
  title: string;
  agent: string;
  role: InFlightRun["role"];
  startedAt: string;
  budgetMs: number;
  tokens: number;
  /** The harness this run uses (D-048). */
  harness: HarnessId;
  /** Why it is on another harness (D-048). */
  switchReason?: string;
  lastAction?: string;
  /** True while a pause stops the run. */
  stopping: boolean;
}

/** A part whose PR waits for a human at the merge gate. */
export interface BlockedPart {
  issueKey: string;
  parentKey: string;
  prUrl: string;
  reason: string;
}

/** What the loop knows now, for the UI. Linear stays the source of truth for issues. */
export interface LoopSnapshot {
  lastPollAt: string | null;
  runs: RunActivity[];
  blocked: BlockedPart[];
  /** The last self-update, once there was one. */
  selfUpdate?: SelfUpdateView;
  /** Harness holds in force now (MET-82). An expired hold is left out before it is released. */
  limits: HarnessLimit[];
  /** Tokens used per parent issue id, for the board and the budget (D-040). */
  usage: Record<string, TokenSum>;
}

export interface TickReport {
  paused: boolean;
  /** Sub-issues a previous process left in flight, now back in Ready. */
  requeued: string[];
  /** Ready issues split into sub-issues this tick (or whose split was completed). */
  split: string[];
  /** Issues moved to Needs input this tick by the grill or the split. */
  escalated: string[];
  /** Sub-issues started this tick. */
  dispatched: string[];
  /** Parts whose PR the merge gate merged this tick. */
  merged: string[];
}

export interface CoordinatorLoop {
  /** One poll and dispatch pass. Concurrent calls share the running pass. */
  tick(): Promise<TickReport>;
  /** Records expired holds without dispatching, even before the first tick. */
  releaseExpiredHolds(): Promise<void>;
  /** Ticks now and then every interval. */
  start(): void;
  /** Cancels the timer. Runs in flight keep going; a restart re-queues them. */
  stop(): void;
  /** Resolves once the current tick and every run started by this process have finished. */
  idle(): Promise<void>;
  /** Keys of the sub-issues running in this process. */
  running(): string[];
  /**
   * Stops dispatching and cancels every run in flight, coordinator runs included. Their
   * worktrees are kept. Resolves with the cancelled sub-issue keys once they have exited.
   */
  pause(): Promise<string[]>;
  /** Allows dispatch again and, once started, ticks now. The `paused` hook still decides each tick. */
  resume(): void;
  /** The runs in flight in this process and the PRs that wait for a human. */
  snapshot(): LoopSnapshot;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Why a send-back cannot resume the part's session; undefined when it can (MET-156). */
function resumeColdReason(
  stored: PartSession | undefined,
  harness: HarnessId,
  worktree: { path: string; branch: string },
  adapter: HarnessAdapter,
): string | undefined {
  if (stored === undefined) return "no session";
  if (stored.harness !== harness) {
    return `session on ${harnessName(stored.harness)}, run on ${harnessName(harness)}`;
  }
  if (stored.worktree !== worktree.path || stored.branch !== worktree.branch)
    return "other worktree";
  if (adapter.canResume !== true) return `${harnessName(harness)} cannot resume`;
  return undefined;
}

/** Tokens of one run: cached is cache read plus cache write (D-040). */
export function tokenSumOf(tokens: TokenUsage): TokenSum {
  return {
    input: tokens.input,
    cached: tokens.cacheRead + tokens.cacheWrite,
    output: tokens.output,
  };
}

function addSums(a: TokenSum, b: TokenSum): TokenSum {
  return { input: a.input + b.input, cached: a.cached + b.cached, output: a.output + b.output };
}

function subtractSums(a: TokenSum, b: TokenSum): TokenSum {
  return {
    input: Math.max(0, a.input - b.input),
    cached: Math.max(0, a.cached - b.cached),
    output: Math.max(0, a.output - b.output),
  };
}

/** Input plus cached plus output, unweighted. The budget weighs the cached part (D-043). */
export function sumTokens(sum: TokenSum): number {
  return sum.input + sum.cached + sum.output;
}

/** The token budget of a parent by its size; an unknown size counts as M (D-040). */
export function tokenBudgetFor(
  size: Issue["size"] | undefined,
  limits: { token_budget: Record<"S" | "M", number> },
): number {
  return size === "S" ? limits.token_budget.S : limits.token_budget.M;
}

/** A pending review whose verdict is ready to settle (MET-230). */
interface PreparedReview {
  record: PendingReview;
  verdict: "approved" | "changes_requested";
  findings: ReviewFinding[];
}

/** A review as the pending record keeps it; the part and PR are ids (MET-213, D-058). */
function pendingQaReview(r: PrReview): PendingQaReview {
  const out: PendingQaReview = {
    partId: r.part.id,
    partKey: r.part.key,
    decision: r.decision,
    failing: r.failing,
    done: r.pendingPost === undefined,
  };
  if (r.cases !== undefined) out.cases = r.cases;
  if (r.pr !== undefined) {
    out.prNumber = r.pr.number;
    out.prUrl = r.pr.url;
    out.head = r.pr.headRefOid;
  }
  if (r.pendingPost !== undefined) {
    out.event = r.pendingPost.event;
    out.body = r.pendingPost.body;
  }
  if (r.setup !== undefined) out.setup = r.setup;
  if (r.stale !== undefined) out.stale = r.stale;
  if (r.notJudged !== undefined) out.notJudged = r.notJudged;
  if (r.error !== undefined) out.error = r.error;
  if (r.testTail !== undefined) out.testTail = r.testTail;
  if (r.reviewUrl !== undefined) out.reviewUrl = r.reviewUrl;
  if (r.postedAs !== undefined) out.postedAs = r.postedAs;
  return out;
}

/** The PR a pending review was judged at, or undefined when QA found none. */
function prFromPending(r: PendingQaReview): PullRequest | undefined {
  if (r.prNumber === undefined || r.head === undefined) return undefined;
  return {
    number: r.prNumber,
    title: `${r.partKey}: review`,
    url: r.prUrl ?? "",
    headRefName: "",
    headRefOid: r.head,
    baseRefName: "",
    isDraft: false,
  };
}

/** The review a pending record replays into `settleQa`, on the fetched part issue. */
function reviewFromPending(r: PendingQaReview, part: LinkedIssue): PrReview {
  const pr = prFromPending(r);
  return {
    part,
    ...(pr === undefined ? {} : { pr }),
    decision: r.decision,
    failing: r.failing,
    ...(r.cases === undefined ? {} : { cases: r.cases }),
    ...(r.setup === undefined ? {} : { setup: r.setup }),
    ...(r.stale === undefined ? {} : { stale: r.stale }),
    ...(r.notJudged === undefined ? {} : { notJudged: r.notJudged }),
    ...(r.error === undefined ? {} : { error: r.error }),
    ...(r.testTail === undefined ? {} : { testTail: r.testTail }),
    ...(r.reviewUrl === undefined ? {} : { reviewUrl: r.reviewUrl }),
    ...(r.postedAs === undefined ? {} : { postedAs: r.postedAs }),
  };
}

/** The round's outcome, from the decisions a pending record kept. */
function outcomeFor(reviews: readonly PrReview[]): QaRunResult["outcome"] {
  if (reviews.some((r) => r.decision === "request_changes")) return "changes_requested";
  if (reviews.some((r) => r.decision === "error")) return "error";
  return "approved";
}

/**
 * Wraps the Linear calls so the loop can count a tick whose transport failed (MET-213, D-058).
 * The error still reaches the caller; `safely` swallows it as before.
 */
function trackLinearErrors(target: LoopLinear, onError: () => void): LoopLinear {
  return new Proxy(target, {
    get(object, prop) {
      const value = Reflect.get(object, prop);
      if (typeof value !== "function" || prop === "resetConnections") return value;
      const call = value as (...args: unknown[]) => unknown;
      return (...args: unknown[]) => {
        let result: unknown;
        try {
          result = call.apply(object, args);
        } catch (error) {
          if (isNetworkError(error)) onError();
          throw error;
        }
        if (result instanceof Promise) {
          return result.catch((error: unknown) => {
            if (isNetworkError(error)) onError();
            throw error;
          });
        }
        return result;
      };
    },
  }) as LoopLinear;
}

export function createCoordinatorLoop(options: CoordinatorLoopOptions): CoordinatorLoop {
  const { config, adapters, worktrees, github, store, repoDir, team } = options;
  const linearClient = options.linear;
  /** Linear runs can settle between ticks, so consume transport failures at the end of a tick. */
  let linearNetworkThisTick = false;
  /** Ticks in a row with a Linear network error; the pool resets at 3 (MET-213). */
  let linearFailedTicks = 0;
  const linear = trackLinearErrors(linearClient, () => {
    linearNetworkThisTick = true;
  });
  const clock = options.clock ?? systemClock;
  const notifier = options.notifier ?? new NullNotifier();
  const decisions = options.decisions ?? createFileDecisionSink(workspaceVaultDir(repoDir));
  const loadContext =
    options.context ?? (() => loadGrillContext(repoDir, { skillsDir: options.skillsDir }));
  const log = options.log ?? (() => {});
  const pid = options.pid ?? process.pid;
  const intervalMs = options.intervalMs ?? DEFAULT_LOOP_INTERVAL_MS;
  const watchMs = options.pauseWatchMs ?? DEFAULT_PAUSE_WATCH_MS;
  const { globalDir } = options;
  const ship = options.ship ?? shipPart;
  /** The run env that carries the run's excludes file, by sub-issue id (MET-109). */
  const runEnvs = new Map<string, Record<string, string>>();
  /** The sub-issue title, by id, for the commit and PR titles. */
  const runTitles = new Map<string, string>();
  /** The parent issue id per sub-issue id, for the token sum (D-040). */
  const runParents = new Map<string, string>();
  /** The harness a part run started on, so its session is stored with the right one (MET-156). */
  const runHarnesses = new Map<string, HarnessId>();
  const memory: AgentMemory | undefined =
    globalDir === undefined
      ? undefined
      : { workspaceVault: workspaceVaultDir(repoDir), globalVault: join(globalDir, "vault") };

  /** Adds one run's tokens to its parent's sum and logs the one-line usage report (D-040). */
  function recordUsage(
    s: LoopState,
    parentId: string | undefined,
    key: string,
    agent: string,
    tokens: TokenUsage,
    turns?: number,
    usageUnknown?: boolean,
  ): void {
    if (usageUnknown === true) {
      // A killed Codex run sends no usage event: count nothing and say so (MET-188, D-043).
      const unknown = `${key}: ${agent} usage unknown`;
      log(turns === undefined ? unknown : `${unknown} in ${turns} turns`);
      return;
    }
    const sum = tokenSumOf(tokens);
    if (parentId !== undefined) {
      const previous = s.usage?.[parentId] ?? { input: 0, cached: 0, output: 0 };
      s.usage ??= {};
      s.usage[parentId] = addSums(previous, sum);
    }
    const line = `${key}: ${agent} used ${sum.input} input, ${sum.cached} cached, ${sum.output} output tokens`;
    log(turns === undefined ? line : `${line} in ${turns} turns`);
  }

  /** Tokens of a parent since its last budget escalation. */
  function usageSince(s: LoopState, parentId: string): TokenSum {
    const total = s.usage?.[parentId] ?? { input: 0, cached: 0, output: 0 };
    const base = s.usageBaseline?.[parentId];
    if (base === undefined) return total;
    return subtractSums(total, { input: base.input, cached: base.cached, output: base.output });
  }

  /** Syncs the harness files into a run's worktree; returns the run's env. Throws on failure. */
  async function prepareWorktree(
    worktree: string,
    runId: string,
    agent: ResolvedAgentConfig,
  ): Promise<Record<string, string> | undefined> {
    if (globalDir === undefined) return undefined;
    try {
      return (await syncWorktree({ repoDir, globalDir, worktree, runId, agent })).env;
    } catch (error) {
      throw new Error(`harnessd sync into the worktree failed: ${message(error)}`);
    }
  }

  let state: LoopState | undefined;
  let ready: Promise<LoopState> | undefined;
  let ticking: Promise<TickReport> | undefined;
  let timer: unknown;
  let saving: Promise<void> = Promise.resolve();
  /** Runs started by this process, by sub-issue id. */
  const live = new Map<string, LiveRun>();
  /** Grill and plan runs in flight; a pause cancels them too. */
  const coordinatorRuns = new Set<AdapterRun>();
  /** The last known pause flag. */
  let pausedNow = false;
  /** A failed self-update pause write needs an explicit resume. */
  let pauseInMemory = false;
  let watch: unknown;
  let checking = false;
  /** A self-update check to run on the next unpaused tick. The first one is the start check. */
  let checkWanted: { trigger?: SelfUpdateTrigger } | undefined = {};
  /** True once a tick saw the pause flag; the first tick after it checks again. */
  let pausedSeen = false;
  /** applyUpdate built the new version and the restart is under way: dispatch nothing. */
  let restarting = false;
  /** True after the one first-tick orphan sweep (MET-214). */
  let orphanSwept = false;
  /** Orphans whose move failed, retried on later ticks until it succeeds (MET-214). */
  let orphanRetry: Array<{ id: string; key: string }> = [];

  /** Follows a run's events: its latest action and token use, and the UI's log. */
  function follow(l: LiveRun, run: AdapterRun): void {
    void (async () => {
      for await (const event of run.events) {
        if (event.type === "tool") l.lastAction = oneLine(`${event.name} ${event.summary}`);
        else if (event.type === "text") l.lastAction = oneLine(event.text).slice(0, 200);
        else if (event.type === "usage") l.tokens = event.tokens.input + event.tokens.output;
        options.onAgentEvent?.({ issueKey: l.key, agent: l.entry.agent }, event);
      }
    })().catch((error) => log(`${l.key}: could not read run events: ${message(error)}`));
  }

  function init(): Promise<LoopState> {
    ready ??= (async () => {
      try {
        await worktrees.recover();
      } catch (error) {
        log(`worktree recovery failed: ${message(error)}`);
      }
      state = await store.load();
      const u = state.selfUpdate;
      if (u?.state === "applying") {
        if (options.selfUpdate?.updater.runningCommit === u.to) {
          u.state = "done";
          log(`self-update: ${shortSha(u.from)} -> ${shortSha(u.to)}`);
        } else {
          // The previous process may have stopped before it installed the target build.
          u.state = "pending";
        }
        u.at = clock.now().toISOString();
        await save();
      }
      return state;
    })();
    return ready;
  }

  /** Saves are chained so a slow write never lands after a newer one. */
  function save(): Promise<void> {
    return saveOrFail().catch((error) => log(`could not save loop state: ${message(error)}`));
  }

  /** A save a caller must know succeeded, such as before a Linear write (MET-232). */
  function saveRequired(): Promise<void> {
    return saveOrFail();
  }

  function saveOrFail(): Promise<void> {
    const snapshot = structuredClone(state);
    if (snapshot === undefined) return saving;
    saving = saving.catch(() => undefined).then(() => store.save(snapshot));
    return saving;
  }

  async function safely(what: string, fn: () => Promise<unknown>): Promise<boolean> {
    try {
      await fn();
      return true;
    } catch (error) {
      log(`could not ${what}: ${message(error)}`);
      return false;
    }
  }

  // --- usage limits (MET-70) ---------------------------------------------

  /** Records what a run's end says about its harness: a limit starts a hold, ok clears the backoff. */
  function noteRun(harness: HarnessId, result: RunResult): void {
    const s = state;
    if (s === undefined) return;
    const prev = s.limits[harness];
    if (result.status === "limited") {
      const now = clock.now();
      const next = afterLimited(prev, result.resetAt, now);
      s.limits[harness] = next;
      if (!isHeld(prev, now)) {
        // A hold that expired but was not released yet ends here, at its own end.
        if (prev !== undefined && prev.endedAt === undefined) {
          options.onHold?.({ harness, kind: "end", at: prev.until, since: prev.since });
        }
        options.onHold?.({ harness, kind: "start", at: next.since });
      }
      // Once per hold; again only when a new reset time moves its end.
      if (!isHeld(prev, now) || prev?.until !== next.until) {
        const fromReset =
          result.resetAt !== undefined && Date.parse(result.resetAt) === Date.parse(next.until);
        log(limitHoldLine(harness, next.until, !fromReset));
      }
    } else if (result.status === "ok" && prev !== undefined) {
      const next = afterOk(prev, clock.now());
      if (next === undefined) delete s.limits[harness];
      else s.limits[harness] = next;
    }
  }

  /** True while a limit holds the harness: nothing starts on it. */
  function held(harness: HarnessId): boolean {
    return isHeld(state?.limits[harness], clock.now());
  }

  /** The hold can start while a task is being prepared. Check at the adapter boundary. */
  function deferWhileHeld(harness: HarnessId): AdapterRun | undefined {
    if (!held(harness)) return undefined;
    const result: RunResult = {
      status: "limited",
      exitCode: null,
      durationMs: 0,
      tokens: emptyTokenUsage(),
      error: "harness is on hold",
    };
    return {
      result: Promise.resolve(result),
      events: (async function* () {
        yield { type: "end" as const, result };
      })(),
      async cancel() {},
    };
  }

  /** The status-engine answer for one harness, from the checks the loop holds (D-048). */
  function harnessCheckOk(harness: HarnessId, suffix: "cli" | "auth"): boolean {
    const checks = options.harnessChecks?.() ?? [];
    const check = checks.find((c) => c.id === `harness.${harness}.${suffix}`);
    return check === undefined || (check.state !== "fail" && check.state !== "missing");
  }

  /** Harnesses that failed sign-in at run time, per issue id (D-048). In memory only. */
  const authFailed = new Map<string, Set<HarnessId>>();

  /** True when an earlier run of this issue ended with reason `auth` on the harness. */
  function failedAuth(issueId: string, harness: HarnessId): boolean {
    return authFailed.get(issueId)?.has(harness) === true;
  }

  /** What the loop knows about each harness now. It runs no check per tick. */
  function availability(issueId: string): HarnessAvailability {
    return {
      held,
      hasAdapter: (h) => adapters[h] !== undefined,
      installed: (h) => harnessCheckOk(h, "cli"),
      signedIn: (h) => harnessCheckOk(h, "auth") && !failedAuth(issueId, h),
    };
  }

  /** The harnesses a run of this issue may use now, in order (D-048). */
  function orderFor(issueId: string, main: ResolvedAgentConfig): ResolvedAgentConfig[] {
    return harnessForRun(main, availability(issueId));
  }

  /** The one log line a first run on another harness writes (D-048). */
  function switchLine(
    key: string,
    main: ResolvedAgentConfig,
    chosen: ResolvedAgentConfig,
    record: HarnessSwitch | undefined,
    why: string | undefined,
  ): string | undefined {
    if (chosen.harness === main.harness) return undefined;
    if (record !== undefined) {
      if (record.from === chosen.harness) return undefined;
      return `${key}: ${harnessName(record.from)} ${record.reason}, retrying on ${harnessName(chosen.harness)}`;
    }
    return `${key}: ${harnessName(main.harness)} ${why ?? "is not available"}, running on ${harnessName(chosen.harness)}`;
  }

  /**
   * Where this issue's next run goes (D-048). It picks the first usable harness after the
   * harness of the last failed run, wrapping around. Undefined means no harness is left.
   */
  function chooseForRun(
    s: LoopState,
    issueId: string,
    main: ResolvedAgentConfig,
  ): {
    agent: ResolvedAgentConfig | undefined;
    skipped: Array<{ harness: HarnessId; why: HarnessSkipReason }>;
    record: HarnessSwitch | undefined;
    why: string | undefined;
  } {
    const availabilityNow = availability(issueId);
    const skipped = harnessCandidates(main)
      .map((harness) => ({ harness, why: harnessSkip(harness, availabilityNow) }))
      .filter(
        (item): item is { harness: HarnessId; why: HarnessSkipReason } => item.why !== undefined,
      );
    const order = orderFor(issueId, main);
    const record = s.harnessSwitch?.[issueId];
    const agent = pickHarness(order, record?.from);
    return { agent, skipped, record, why: harnessSkip(main.harness, availabilityNow) };
  }

  /** Logs the no-harness line once per set of reasons for an issue (D-048). */
  const noHarness = new Map<string, string>();
  function logNoHarness(
    key: string,
    issueId: string,
    skipped: Array<{ harness: HarnessId; why: HarnessSkipReason }>,
  ): void {
    const text =
      skipped.map((s) => `${harnessName(s.harness)} ${s.why}`).join(", ") || "no harness";
    if (noHarness.get(issueId) === text) return;
    noHarness.set(issueId, text);
    log(`${key}: no harness left (${text})`);
  }

  /** Remembers why this issue's next run must use the next harness (D-048). */
  function recordSwitch(s: LoopState, issueId: string, from: HarnessId, reason: string): void {
    s.harnessSwitch ??= {};
    s.harnessSwitch[issueId] = { from, reason, at: clock.now().toISOString() };
    if (reason === "is not signed in") {
      const failed = authFailed.get(issueId) ?? new Set<HarnessId>();
      failed.add(from);
      authFailed.set(issueId, failed);
    }
  }

  /** Forgets the switch on an ok run, at Needs input and at Done (D-048). */
  function clearSwitch(issueId: string): void {
    if (state?.harnessSwitch !== undefined) delete state.harnessSwitch[issueId];
    authFailed.delete(issueId);
    noHarness.delete(issueId);
  }

  /** Ends the holds whose time has come, with one log line each. */
  async function releaseHolds(s: LoopState): Promise<void> {
    let changed = false;
    for (const [harness, hold] of Object.entries(s.limits) as Array<[HarnessId, HarnessHold]>) {
      const now = clock.now();
      const released = releaseExpired(hold, now);
      if (!released.ended) continue;
      const end = Math.min(Date.parse(hold.until), now.getTime());
      options.onHold?.({
        harness,
        kind: "end",
        at: new Date(end).toISOString(),
        since: hold.since,
      });
      changed = true;
      if (released.hold === undefined) delete s.limits[harness];
      else s.limits[harness] = released.hold;
      log(limitAvailableLine(harness));
    }
    if (changed) await save();
  }

  // --- re-queue -----------------------------------------------------------

  /** Re-queues entries with no live run, including stopped runs whose Ready move failed. */
  async function requeue(s: LoopState, report: TickReport): Promise<void> {
    let changed = false;
    for (const entry of [...s.inFlight]) {
      if (live.has(entry.issueId)) continue;
      if (entry.pausedAt !== undefined && entry.role !== "reviewer") {
        if (await requeueStopped(s, entry)) report.requeued.push(entry.issueKey);
        continue;
      }
      if (entry.worktree !== "") {
        // A QA or review checkout is never kept: a crash re-queue removes it without the guard.
        await removeWithGuard(s, entry, entry.worktree, {
          force: entry.role === "qa" || entry.role === "reviewer",
        });
      }
      if (entry.role === "reviewer") {
        // The part stays In Review: the next tick starts the review again (MET-224).
        s.inFlight = s.inFlight.filter((e) => e !== entry);
        changed = true;
        log(`${entry.issueKey}: interrupted review dropped`);
        continue;
      }
      const moved = await safely(`re-queue ${entry.issueKey}`, () =>
        linear.moveTo(entry.issueId, "Ready"),
      );
      if (!moved) continue;
      s.inFlight = s.inFlight.filter((e) => e !== entry);
      report.requeued.push(entry.issueKey);
      changed = true;
      log(`${entry.issueKey}: interrupted run re-queued`);
    }
    if (changed || report.requeued.length > 0) await save();
  }

  // --- state repair -------------------------------------------------------

  /**
   * Drops a split record once Linear shows the parent Done or Canceled (MET-154). The record
   * only guards splitReady against a stale read, so it must not outlive the parent. A read
   * error keeps it, and a later tick sweeps it again.
   */
  async function repairSplits(s: LoopState): Promise<void> {
    if (s.splits === undefined) return;
    let changed = false;
    for (const [id, record] of Object.entries(s.splits)) {
      let issue: Issue;
      try {
        issue = await linear.getIssue(id);
      } catch (error) {
        log(`${record.key}: could not read it for the split record check: ${message(error)}`);
        continue;
      }
      if (issue.state.toLowerCase() === "done" || isCanceledState(issue.state)) {
        delete s.splits[id];
        // Done ends any harness switch for the parent (D-048).
        clearSwitch(id);
        changed = true;
      }
    }
    if (changed) await save();
  }

  /**
   * A Linear GitHub automation can move a part to In Progress when its PR opens, after the
   * ship step moved it to In Review (MET-128). QA then has nothing to review, so on each
   * tick the loop reads every shipped part again: one in In Progress, with an open PR and
   * no run in flight, goes back to In Review, with one line in the log. A part in another
   * state drops its record, and so does an In Progress part with no open PR. So a human
   * move to Ready or Needs input is never fought, and a part that runs again is not moved.
   */
  async function repairShipped(s: LoopState): Promise<void> {
    if (s.shipped === undefined) return;
    let changed = false;
    for (const [id, record] of Object.entries(s.shipped)) {
      if (s.inFlight.some((e) => e.issueId === id)) continue;
      let issue: Issue;
      try {
        issue = await linear.getIssue(id);
      } catch (error) {
        log(`${record.key}: could not read it for the state check: ${message(error)}`);
        continue;
      }
      const current = issue.state.toLowerCase();
      if (current === "in review") continue;
      if (current !== "in progress") {
        delete s.shipped[id];
        // A part at Done has no review failures left to cap (MET-225).
        if (current === "done" && s.reviewFailures !== undefined) delete s.reviewFailures[id];
        changed = true;
        continue;
      }
      let open: boolean;
      try {
        open = (await github.findPrByHead(record.branch)) !== undefined;
      } catch (error) {
        log(`${record.key}: could not read its PR for the state check: ${message(error)}`);
        continue;
      }
      if (!open) {
        delete s.shipped[id];
        changed = true;
        continue;
      }
      const moved = await safely(`move ${record.key} to In Review`, () =>
        linear.moveTo(id, "In Review"),
      );
      if (moved) {
        log(`${record.key}: Linear moved it to In Progress after its PR opened; back to In Review`);
      }
    }
    if (changed) await save();
  }

  /**
   * The first tick after the daemon starts moves a part or QA sub-issue a previous process
   * left In Progress back to Ready (MET-214). Only tickets listed in a split record count:
   * a split parent is In Progress by design and holds its slot (D-057). A ticket with a run
   * in flight, a `pendingQa` verdict or a `shipped` record is not orphaned, because that
   * work finishes on a later tick (D-039, D-058). A failed move is logged and retried on
   * later ticks; the list lives in memory, so a restart seeds it from `splits` again. A read
   * only a network error blocked waits too; any other read error drops the ticket.
   */
  async function sweepOrphans(s: LoopState): Promise<void> {
    if (!orphanSwept) {
      orphanSwept = true;
      const seen = new Set(orphanRetry.map((candidate) => candidate.id));
      for (const record of Object.values(s.splits ?? {})) {
        for (const id of [...record.parts, record.qa]) {
          if (seen.has(id)) continue;
          seen.add(id);
          orphanRetry.push({ id, key: id });
        }
      }
    }
    if (orphanRetry.length === 0) return;
    const retry: Array<{ id: string; key: string }> = [];
    for (const candidate of orphanRetry) {
      if (s.inFlight.some((entry) => entry.issueId === candidate.id)) continue;
      if (s.shipped?.[candidate.id] !== undefined) continue;
      if (s.pendingQa?.[candidate.id] !== undefined) continue;
      let issue: Issue;
      try {
        issue = await linear.getIssue(candidate.id);
      } catch (error) {
        log(`${candidate.key}: could not read it for the restart sweep: ${message(error)}`);
        if (isNetworkError(error)) retry.push(candidate);
        continue;
      }
      if (issue.state.toLowerCase() !== "in progress") continue;
      const moved = await safely(`move ${issue.key} to Ready`, () =>
        linear.moveTo(issue.id, "Ready"),
      );
      if (!moved) {
        retry.push({ id: issue.id, key: issue.key });
        continue;
      }
      log(`${issue.key}: In Progress with no run after restart, back to Ready`);
    }
    orphanRetry = retry;
  }

  /**
   * Retries the QA verdicts a network error left unfinished (MET-213, D-058). Each review
   * not posted goes out, then the settle runs with the steps already done skipped. A
   * network error stops the round and keeps the record for the next tick; nothing is
   * counted, no Needs-input comment or notice goes out.
   */
  async function retryPendingQa(s: LoopState): Promise<void> {
    const records = s.pendingQa;
    if (records === undefined) return;
    for (const [qaId, record] of Object.entries(records)) {
      if (live.has(qaId)) continue;
      let pending = false;
      for (const review of record.reviews) {
        if (review.done) continue;
        if (
          review.prNumber === undefined ||
          review.event === undefined ||
          review.body === undefined ||
          review.head === undefined
        ) {
          review.done = true;
          continue;
        }
        try {
          const posted = await postQaReview(
            github,
            record.qaKey ?? qaId,
            { number: review.prNumber, head: review.head },
            { event: review.event, body: review.body },
            log,
          );
          review.done = true;
          review.reviewUrl = posted.url;
          review.postedAs = posted.postedAs;
        } catch (error) {
          log(`could not post the review on PR #${review.prNumber}: ${message(error)}`);
          if (isNetworkError(error)) {
            pending = true;
            break;
          }
          // Preserve runQa's rule: an approval that could not be posted cannot merge.
          review.done = true;
          if (review.decision === "approve") {
            review.decision = "error";
            review.error = `could not post the approval: ${message(error)}`;
            if (s.reviewedHeads !== undefined) delete s.reviewedHeads[review.partId];
          }
        }
        await save();
      }
      if (pending) continue;

      let parent: Issue;
      let qa: LinkedIssue;
      const parts = new Map<string, LinkedIssue>();
      try {
        parent = await linear.getIssue(record.parentId);
        const qaIssue = await linear.getIssue(qaId);
        qa = { ...qaIssue, parentId: record.parentId, blockers: [] };
        for (const review of record.reviews) {
          if (parts.has(review.partId)) continue;
          const part = await linear.getIssue(review.partId);
          parts.set(review.partId, { ...part, parentId: record.parentId, blockers: [] });
        }
      } catch (error) {
        log(
          `${record.qaKey ?? qaId}: could not read it for the pending QA retry: ${message(error)}`,
        );
        continue;
      }

      const reviews = record.reviews.map((review) => {
        const part = parts.get(review.partId);
        if (part === undefined) throw new Error(`no part ${review.partId}`);
        return reviewFromPending(review, part);
      });
      const result: QaRunResult = { outcome: outcomeFor(reviews), reviews };
      const settled = await settleQa(s, { qa, parent }, result, {
        linear,
        notifier,
        maxFailures: config.limits.qa_max_failures,
        log,
        steps: {
          done: record.done,
          async mark(step: string) {
            record.done.push(step);
            await save();
          },
        },
      });
      if (settled === "pending") {
        await save();
        continue;
      }
      delete records[qaId];
      if (Object.keys(records).length === 0) delete s.pendingQa;
      // Each approved part is its own merge entry, pinned to the head QA reviewed (D-040).
      for (const r of reviews) {
        if (r.decision !== "approve" || r.pr === undefined) continue;
        s.merges = s.merges.filter((m) => !m.prs.some((p) => p.partId === r.part.id));
        s.merges.push(pendingMerge(qa, parent, [r], clock.now()));
      }
      log(`${qa.key}: QA verdict posted after retry`);
      await save();
    }
  }

  /** Posts a saved verdict, leaving failed writes for the next tick (D-058). */
  async function postPendingReview(s: LoopState, partId: string): Promise<boolean> {
    const records = s.pendingReview;
    const record = records?.[partId];
    if (records === undefined || record === undefined) return false;
    if (record.posted === true) return true;
    try {
      const url = await github.postReview(record.prNumber, {
        event: "COMMENT",
        body: record.body,
        commitId: record.head,
      });
      record.reviewUrl = url;
      record.posted = true;
      await save();
      return true;
    } catch (error) {
      log(
        `${record.partKey}: could not post the review on PR #${record.prNumber}: ${message(error)}`,
      );
      return false;
    }
  }

  /**
   * Validates a pending review before its comment goes out (MET-230). A legacy record with
   * no verdict takes it from reviewerHeads when the head matches; otherwise it is dropped
   * with one line, so a stale verdict is never posted and a bad record never blocks reviews.
   */
  async function preparePendingReview(
    s: LoopState,
    partId: string,
  ): Promise<PreparedReview | undefined> {
    const record = s.pendingReview?.[partId];
    if (record === undefined) return undefined;
    let verdict = record.verdict;
    let findings = record.findings;
    if (verdict === undefined || findings === undefined) {
      const recorded = s.reviewerHeads?.[partId];
      if (recorded === undefined || recorded.sha !== record.head) {
        log(
          `${record.partKey}: dropped the pending review at ${record.head.slice(0, 7)}: no verdict for that head`,
        );
        const records = s.pendingReview;
        if (records !== undefined) {
          delete records[partId];
          if (Object.keys(records).length === 0) delete s.pendingReview;
        }
        await save();
        return undefined;
      }
      verdict = recorded.verdict;
      findings = recorded.findings;
      record.verdict = verdict;
      record.findings = findings;
    }
    if (verdict === undefined || findings === undefined) return undefined;
    return { record, verdict, findings };
  }

  /**
   * Settles a review whose PR comment is posted, then drops its pending record (MET-225).
   * A failed post, a network error on a settle write or the Linear reads it needs keep the
   * record, so a later tick finishes the settle without running the reviewer again for
   * that verdict (D-058).
   */
  async function settlePendingReview(s: LoopState, partId: string): Promise<void> {
    const record = s.pendingReview?.[partId];
    if (record === undefined || record.posted !== true) return;
    const prepared = await preparePendingReview(s, partId);
    if (prepared === undefined) return;
    const { verdict, findings } = prepared;
    let part: Issue;
    let parent: Issue;
    try {
      part = await linear.getIssue(record.partId);
      parent = await linear.getIssue(record.parentId);
    } catch (error) {
      log(`${record.partKey}: could not read it for the review settle: ${message(error)}`);
      return;
    }
    const pr: PullRequest = {
      number: record.prNumber,
      title: `${record.partKey}: review`,
      url: record.prUrl,
      headRefName: "",
      headRefOid: record.head,
      baseRefName: "",
      isDraft: false,
    };
    const linked: LinkedIssue = {
      ...part,
      parentId: record.parentId,
      parentKey: parent.key,
      blockers: [],
    };
    record.done ??= [];
    const settled = await settleReview(
      s,
      {
        part: linked,
        parent,
        pr,
        ...(verdict === undefined
          ? {}
          : {
              verdict: {
                decision: verdict === "approved" ? "approve" : "changes_requested",
                findings: findings ?? [],
              },
            }),
        ...(record.reviewUrl === undefined ? {} : { reviewUrl: record.reviewUrl }),
      },
      {
        linear,
        notifier,
        maxFailures: config.limits.qa_max_failures,
        log,
        steps: {
          done: record.done,
          async mark(step: string) {
            record.done ??= [];
            record.done.push(step);
            await save();
          },
        },
      },
    );
    if (settled === "pending") {
      // A network error stopped a write: keep the record and its done steps for the next
      // tick, as QA does (D-058).
      await save();
      return;
    }
    const records = s.pendingReview;
    if (records !== undefined) {
      delete records[partId];
      if (Object.keys(records).length === 0) delete s.pendingReview;
    }
    await save();
  }

  /**
   * Saves a direct review settlement before its writes and keeps it until every step is
   * done (MET-230, D-058). Not-judged and failed-run settles have no PR comment record, so
   * an escalation that times out needs its own record to retry.
   */
  async function settleReviewPersisted(
    s: LoopState,
    part: LinkedIssue,
    parent: Issue,
    pr: PullRequest,
    input: Omit<ReviewSettleInput, "part" | "parent" | "pr">,
  ): Promise<void> {
    s.pendingReviewSettle ??= {};
    let record = s.pendingReviewSettle[part.id];
    if (record === undefined) {
      record = {
        partId: part.id,
        partKey: part.key,
        parentId: parent.id,
        prNumber: pr.number,
        prUrl: pr.url,
        head: pr.headRefOid,
        ...(input.verdict === undefined
          ? {}
          : {
              verdict: input.verdict.decision === "approve" ? "approved" : "changes_requested",
              findings: input.verdict.findings,
            }),
        ...(input.notJudged === undefined ? {} : { notJudged: input.notJudged }),
        ...(input.error === undefined ? {} : { error: input.error }),
        ...(input.reviewUrl === undefined ? {} : { reviewUrl: input.reviewUrl }),
        done: [],
      };
      s.pendingReviewSettle[part.id] = record;
      await save();
    }
    const settled = await settleReview(
      s,
      {
        part,
        parent,
        pr,
        ...(record.verdict === undefined
          ? {}
          : {
              verdict: {
                decision: record.verdict === "approved" ? "approve" : "changes_requested",
                findings: record.findings ?? [],
              },
            }),
        ...(record.notJudged === undefined ? {} : { notJudged: record.notJudged }),
        ...(record.escalation === undefined ? {} : { escalation: record.escalation }),
        ...(record.error === undefined ? {} : { error: record.error }),
        ...(record.reviewUrl === undefined ? {} : { reviewUrl: record.reviewUrl }),
      },
      {
        linear,
        notifier,
        maxFailures: config.limits.qa_max_failures,
        log,
        steps: {
          done: record.done,
          async mark(step: string) {
            record.done.push(step);
            await save();
          },
          async decide(escalation) {
            // Save the escalation before the first Linear write, so a restart replays it
            // instead of counting the run again from an empty map (MET-232).
            record.escalation = escalation;
            try {
              await saveRequired();
            } catch (error) {
              // The write failed, so the decision is not durable. Drop it from memory and
              // let the retry decide again instead of treating it as saved (MET-232).
              delete record.escalation;
              throw error;
            }
          },
        },
      },
    );
    if (settled === "pending") {
      // A network error stopped a write: keep the record and its done steps for next tick.
      await save();
      return;
    }
    const records = s.pendingReviewSettle;
    if (records !== undefined) {
      delete records[part.id];
      if (Object.keys(records).length === 0) delete s.pendingReviewSettle;
    }
    await save();
  }

  /** Retries review settlements a network error left unfinished (MET-230, D-058). */
  async function retryReviewSettles(s: LoopState): Promise<void> {
    for (const partId of Object.keys(s.pendingReviewSettle ?? {})) {
      if (live.has(partId)) continue;
      const record = s.pendingReviewSettle?.[partId];
      if (record === undefined) continue;
      let part: Issue;
      let parent: Issue;
      try {
        part = await linear.getIssue(record.partId);
        parent = await linear.getIssue(record.parentId);
      } catch (error) {
        log(`${record.partKey}: could not read it for the review settle: ${message(error)}`);
        continue;
      }
      const pr: PullRequest = {
        number: record.prNumber,
        title: `${record.partKey}: review`,
        url: record.prUrl,
        headRefName: "",
        headRefOid: record.head,
        baseRefName: "",
        isDraft: false,
      };
      const linked: LinkedIssue = {
        ...part,
        parentId: record.parentId,
        parentKey: parent.key,
        blockers: [],
      };
      // The record already holds the inputs; the empty input is only a type placeholder.
      await settleReviewPersisted(s, linked, parent, pr, {});
    }
  }

  async function retryPendingReviews(s: LoopState): Promise<void> {
    for (const partId of Object.keys(s.pendingReview ?? {})) {
      if (live.has(partId)) continue;
      // Validate before the post: a legacy record with no matching head is dropped, never
      // published, and leaves reviewer dispatch free (MET-230).
      if ((await preparePendingReview(s, partId)) === undefined) continue;
      if (!(await postPendingReview(s, partId))) continue;
      await settlePendingReview(s, partId);
    }
  }

  // --- dispatch -----------------------------------------------------------

  /** Needs input: one comment, the state move and one ping (D-011, D-014). */
  async function escalate(
    target: { id: string; key: string; url?: string },
    reason: string,
    summary: string,
    comment: string,
  ): Promise<void> {
    // Needs input ends the harness switch for this issue (D-048).
    clearSwitch(target.id);
    await safely(`comment on ${target.key}`, () => linear.comment(target.id, comment));
    await safely(`move ${target.key} to Needs input`, () =>
      linear.moveTo(target.id, "Needs input"),
    );
    const issue = target.url ? { key: target.key, url: target.url } : { key: target.key };
    await safely("send the notice", () =>
      notifier.notify({ kind: "needs_input", issue, prs: [], reason, detail: summary }),
    );
  }

  /**
   * True when the parent is at or over its weighted token budget: then nothing new starts,
   * the parent goes to Needs input once, and the count continues from here after a human
   * moves it back to Ready (D-040, D-043).
   */
  async function overTokenBudget(s: LoopState, parent: Issue): Promise<boolean> {
    // Already escalated: a human has not moved it back to Ready yet.
    if (parent.state.toLowerCase() === "needs input") return true;
    const budget = tokenBudgetFor(parent.size, config.limits);
    const weight = config.limits.cached_token_weight;
    const used = usageSince(s, parent.id);
    const total = weightedTokens(used, weight);
    if (total < budget) return false;
    try {
      if ((await linear.getIssue(parent.id)).state.toLowerCase() === "needs input") return true;
    } catch {
      // Cannot tell whether it was already escalated: start nothing, do not spam.
      log(`${parent.key}: token budget reached; could not read the parent, waiting`);
      return true;
    }
    await escalate(
      { id: parent.id, key: parent.key, ...(parent.url ? { url: parent.url } : {}) },
      "token budget",
      `${total} of ${budget} weighted tokens`,
      `**harnessd token budget**: ${parent.key} used ${total} of its ${budget} weighted tokens ` +
        `(${used.input} input + ${used.cached} cached × ${weight} → ${Math.round(used.cached * weight)} weighted + ${used.output} output), ` +
        "so the loop starts no new run. " +
        "Move it back to Ready to continue with a fresh count (D-040, D-043).",
    );
    // usageSince subtracts this from the parent's cumulative sum, so store the sum, not the
    // delta since the last escalation. A second escalation must count from its own point too.
    s.usageBaseline ??= {};
    const cumulative = s.usage?.[parent.id] ?? { input: 0, cached: 0, output: 0 };
    s.usageBaseline[parent.id] = { ...cumulative, at: clock.now().toISOString() };
    await save();
    return true;
  }

  /** The `interrupted` record for a kept worktree. */
  function toInterrupted(
    entry: KeptRun,
    path: string,
    reason: InterruptedReason,
    at: string,
  ): InterruptedRun {
    return {
      issueId: entry.issueId,
      issueKey: entry.issueKey,
      role: entry.role,
      agent: entry.agent,
      worktree: path,
      branch: entry.branch,
      interruptedAt: at,
      reason,
      ...(entry.excludesFile ? { excludesFile: entry.excludesFile } : {}),
    };
  }

  /** Records a run a pause cancelled, worktree kept for inspection, and says so on the issue. */
  async function keepInterrupted(s: LoopState, entry: InFlightRun): Promise<void> {
    s.interrupted = s.interrupted.filter((e) => e.issueId !== entry.issueId);
    if (entry.worktree !== "") {
      s.interrupted.push(
        toInterrupted(
          entry,
          entry.worktree,
          entry.stopReason ?? "paused",
          entry.pausedAt ?? clock.now().toISOString(),
        ),
      );
    }
    const where =
      entry.worktree === "" ? "it had no worktree yet" : `worktree kept at ${entry.worktree}`;
    const why =
      entry.stopReason === "self-update"
        ? "Stopped over its budget while a self-update waited (D-014); it runs again after the restart"
        : "Paused by harnessd pause";
    await safely(`comment on ${entry.issueKey}`, () =>
      linear.comment(entry.issueId, `**harnessd**: ${why}; ${where}.`),
    );
    log(`${entry.issueKey}: ${entry.stopReason ?? "paused"}, re-queued, ${where}`);
  }

  /**
   * Keeps a worktree that holds unshipped work: it goes under `interrupted` so the next
   * dispatch resumes it on the same branch, and the issue gets one comment.
   */
  async function keepUnshipped(
    s: LoopState,
    entry: KeptRun,
    path: string,
    reason: WorktreeKeepReason,
    resumable = true,
  ): Promise<void> {
    const already = s.interrupted.some(
      (e) => e.issueId === entry.issueId && e.worktree === path && e.reason === reason,
    );
    if (resumable) {
      s.interrupted = s.interrupted.filter((e) => e.issueId !== entry.issueId);
      s.interrupted.push(toInterrupted(entry, path, reason, clock.now().toISOString()));
    }
    if (!already) {
      await safely(`comment on ${entry.issueKey}`, () =>
        linear.comment(entry.issueId, `**harnessd**: worktree kept at ${path}: ${reason}.`),
      );
      log(`${entry.issueKey}: worktree kept at ${path}: ${reason}`);
    }
  }

  /**
   * Removes a worktree through the guard. A kept worktree is recorded for the next run
   * (unless `resumable` is false) and commented on once.
   */
  async function removeWithGuard(
    s: LoopState,
    entry: KeptRun,
    path: string,
    options: { force?: boolean; resumable?: boolean } = {},
  ): Promise<void> {
    try {
      const remove = {
        ...(entry.excludesFile ? { excludesFile: entry.excludesFile } : {}),
        ...(options.force ? { force: true } : {}),
      };
      const result = await worktrees.remove(path, remove);
      if (!result.removed && result.kept !== undefined) {
        await keepUnshipped(s, entry, path, result.kept, options.resumable ?? true);
      }
    } catch (error) {
      log(`could not remove the worktree of ${entry.issueKey}: ${message(error)}`);
    }
  }

  /** Keep the run in flight until Linear confirms that it is Ready. */
  async function requeueStopped(s: LoopState, entry: InFlightRun): Promise<boolean> {
    const moved = await safely(`re-queue ${entry.issueKey}`, () =>
      linear.moveTo(entry.issueId, "Ready"),
    );
    if (!moved) return false;
    await keepInterrupted(s, entry);
    s.inFlight = s.inFlight.filter((e) => e !== entry);
    await save();
    return true;
  }

  async function finish(
    s: LoopState,
    entry: InFlightRun,
    result: RunResult,
    deferred = false,
    resumed = false,
  ): Promise<void> {
    // The run stays in flight until its work is recorded. A tick reads these entries before
    // it re-queues a run or applies a self-update, so neither can restart the daemon under
    // the ship step (MET-113, MET-109). The entry is dropped once, at the end.
    const id = entry.issueId;
    let drop = true;
    try {
      // The switch reads the adapter result, not the shipped outcome (D-048): a ship failure
      // stays a task failure on the same harness, so an existing switch record stays.
      const startedOn = runHarnesses.get(entry.issueId);
      const switchReason = startedOn === undefined ? undefined : switchWhy(result);
      if (startedOn !== undefined && switchReason !== undefined) {
        recordSwitch(s, id, startedOn, switchReason);
      }
      recordUsage(
        s,
        runParents.get(entry.issueId),
        entry.issueKey,
        entry.agent,
        result.tokens,
        result.turns,
        result.usageUnknown === true,
      );
      // A part run that reported a session keeps it for a QA send-back (MET-156).
      const harness = runHarnesses.get(entry.issueId);
      if (harness !== undefined && result.sessionId !== undefined && entry.worktree !== "") {
        s.sessions ??= {};
        s.sessions[id] = {
          harness,
          sessionId: result.sessionId,
          worktree: entry.worktree,
          branch: entry.branch,
          at: clock.now().toISOString(),
        };
      }
      const stopped = entry.pausedAt !== undefined && result.status !== "ok";
      if (stopped) {
        // A failed move keeps the entry: the next tick's re-queue tries again.
        if (!(await requeueStopped(s, entry))) drop = false;
        return;
      }
      // The daemon ships an ok part run: commit, push and open or update the PR (MET-109).
      // It runs before the worktree is removed and before the move to In Review.
      let outcome: RunResult = result;
      if (result.status === "ok" && entry.role !== "qa" && entry.worktree !== "") {
        const env = runEnvs.get(entry.issueId);
        const title = runTitles.get(entry.issueId) ?? entry.issueKey;
        let shipped: ShipResult;
        try {
          shipped = await ship({
            worktree: entry.worktree,
            branch: entry.branch,
            issueKey: entry.issueKey,
            title,
            ...(entry.issueUrl ? { issueUrl: entry.issueUrl } : {}),
            ...(result.finalText ? { finalText: result.finalText } : {}),
            ...(env ? { env } : {}),
            github,
          });
        } catch (error) {
          shipped = { ok: false, error: `push failed: ${oneLine(message(error))}` };
        }
        if (shipped.ok) {
          // The part is recorded as shipped before the move, so a Linear automation that moves
          // it back to In Progress is repaired on the next tick, and a failed move too (MET-128).
          s.shipped ??= {};
          s.shipped[entry.issueId] = {
            key: entry.issueKey,
            branch: entry.branch,
            prUrl: shipped.prUrl,
            at: clock.now().toISOString(),
          };
          log(`${entry.issueKey}: ${shipped.created ? "opened" : "updated"} PR ${shipped.prUrl}`);
        } else {
          outcome = { ...result, status: "error", error: shipped.error };
        }
      }
      runEnvs.delete(entry.issueId);
      runTitles.delete(entry.issueId);
      runParents.delete(entry.issueId);
      runHarnesses.delete(entry.issueId);
      if (entry.worktree !== "") await removeWithGuard(s, entry, entry.worktree);
      if (
        resumed &&
        result.status === "error" &&
        (result.turns === undefined || result.turns === 0)
      ) {
        // The harness no longer has the session: drop it and let the next run start cold,
        // with the full brief. No attempt is counted (MET-156).
        if (s.sessions !== undefined) delete s.sessions[id];
        const why = outcome.error ? oneLine(outcome.error) : "no turns";
        await safely(`re-queue ${entry.issueKey}`, () => linear.moveTo(id, "Ready"));
        log(`${entry.issueKey}: resume failed (${why}), cold next`);
      } else if (outcome.status === "ok") {
        delete s.attempts[id];
        delete s.qaFeedback[id];
        // An ok run ends the harness switch for this issue (D-048).
        clearSwitch(id);
        await safely(`move ${entry.issueKey} to In Review`, () => linear.moveTo(id, "In Review"));
        log(`${entry.issueKey}: done, In Review`);
      } else if (outcome.status === "cancelled" || outcome.status === "limited") {
        // A usage limit is no task failure: no attempt counted, no comment. noteRun held the harness (MET-70).
        await safely(`re-queue ${entry.issueKey}`, () => linear.moveTo(id, "Ready"));
        if (!deferred) log(`${entry.issueKey}: ${outcome.status}, re-queued`);
      } else {
        const failures = (s.attempts[id] ?? 0) + 1;
        const why = `${outcome.status}${outcome.error ? `: ${oneLine(outcome.error)}` : ""}`;
        if (failures >= MAX_RUN_ATTEMPTS) {
          delete s.attempts[id];
          await escalate(
            { id, key: entry.issueKey, ...(entry.issueUrl ? { url: entry.issueUrl } : {}) },
            "run failed",
            `the ${entry.agent} run failed twice (${why})`,
            `**harnessd**: the ${entry.agent} run failed twice (${why}), so this needs a human (D-014).`,
          );
          log(`${entry.issueKey}: failed twice (${why}), Needs input`);
        } else {
          s.attempts[id] = failures;
          await safely(`comment on ${entry.issueKey}`, () =>
            linear.comment(
              id,
              `**harnessd**: the ${entry.agent} run failed (${why}). Back to Ready for one retry (D-014).`,
            ),
          );
          await safely(`re-queue ${entry.issueKey}`, () => linear.moveTo(id, "Ready"));
          log(`${entry.issueKey}: failed (${why}), retrying once`);
        }
      }
    } finally {
      // Drop the run last, after the ship and the Linear move. No await runs between the
      // first three lines, so a tick cannot see half a finished run.
      live.delete(id);
      syncWatch();
      if (drop) {
        s.inFlight = s.inFlight.filter((e) => e !== entry);
        await save();
      }
    }
  }

  async function dispatch(
    s: LoopState,
    issue: LinkedIssue,
    role: SubIssueRole,
    qa: QaContext | undefined,
    report: TickReport,
  ): Promise<void> {
    if (pausedNow) return;
    const agentName = agentForRole(config, role);
    if (agentName === undefined) {
      log(`${issue.key}: no agent has role ${role}`);
      return;
    }
    const main = resolveAgentConfig(config, agentName);
    const budget = budgetMs(issue.size, config.limits);
    if (budget === undefined) {
      await escalate(
        issue,
        "size L",
        "L issues are split, never run",
        `**harnessd**: ${issue.key} is size L. L issues are split, never run (D-014): split it into S or M parts.`,
      );
      report.escalated.push(issue.key);
      return;
    }
    // The per-issue token budget counts every run of the parent, grill and plan included (D-040).
    let parentIssue: Issue | undefined = qa?.parent;
    if (parentIssue === undefined && issue.parentId !== undefined) {
      try {
        parentIssue = await linear.getIssue(issue.parentId);
      } catch (error) {
        log(`${issue.key}: could not read the parent for the token budget: ${message(error)}`);
      }
    }
    if (parentIssue !== undefined && (await overTokenBudget(s, parentIssue))) return;
    // The next harness in the fixed role order (D-048). With none left, the issue stays Ready.
    const choice = chooseForRun(s, issue.id, main);
    const agent = choice.agent;
    const adapter = agent && adapters[agent.harness];
    if (agent === undefined || adapter === undefined) {
      logNoHarness(issue.key, issue.id, choice.skipped);
      return;
    }
    noHarness.delete(issue.id);
    const started = await safely(`move ${issue.key} to In Progress`, () =>
      linear.moveTo(issue.id, "In Progress"),
    );
    if (!started) return;
    const switched = switchLine(issue.key, main, agent, choice.record, choice.why);
    if (switched !== undefined) log(switched);
    const switchReason =
      agent.harness === main.harness ? undefined : (choice.record?.reason ?? choice.why);

    const entry: InFlightRun = {
      issueId: issue.id,
      issueKey: issue.key,
      issueUrl: issue.url,
      role,
      agent: agentName,
      worktree: "",
      branch: "",
      startedAt: clock.now().toISOString(),
      pid,
    };
    s.inFlight.push(entry);
    // A part that runs again is no longer shipped: its state is not repaired (MET-128).
    if (s.shipped !== undefined) delete s.shipped[issue.id];
    runTitles.set(issue.id, issue.title);
    runParents.set(issue.id, qa?.parent.id ?? issue.parentId ?? issue.id);
    const fail = (error: unknown): Promise<void> =>
      finish(s, entry, {
        status: "error",
        exitCode: null,
        durationMs: 0,
        tokens: emptyTokenUsage(),
        error: message(error),
      });

    // Recorded before the worktree exists, so a crash from here on is re-queued.
    await save();

    if (qa !== undefined) {
      // QA always checks the PR head out afresh, so a worktree a pause kept is removed.
      const oldCheckout = s.interrupted.find((e) => e.issueId === issue.id);
      if (oldCheckout !== undefined) {
        s.interrupted = s.interrupted.filter((e) => e !== oldCheckout);
        // A QA checkout is never kept: remove the old one even with local changes.
        await removeWithGuard(s, oldCheckout, oldCheckout.worktree, {
          force: true,
          resumable: false,
        });
        await save();
      }
      report.dispatched.push(issue.key);
      startQa(s, entry, issue, qa, agent, adapter, budget, switchReason);
      log(`${issue.key}: ${agentName} started QA of ${qa.parts.map((p) => p.key).join(", ")}`);
      return;
    }

    let run: AdapterRun;
    let resumed = false;
    try {
      // A paused run's worktree is reused: createWorktree picks it back up on the same branch.
      const kept = s.interrupted.find((e) => e.issueId === issue.id);
      const worktree = await worktrees.create({ issueKey: issue.key, title: issue.title });
      entry.worktree = worktree.path;
      entry.branch = worktree.branch;
      if (kept !== undefined) {
        s.interrupted = s.interrupted.filter((e) => e !== kept);
        if (kept.worktree !== worktree.path) {
          // The title, and so the branch, changed: the old worktree is not this run's.
          // Keep it and say so when it holds unshipped work, but it cannot be resumed.
          await removeWithGuard(s, kept, kept.worktree, { resumable: false });
        }
      }
      await save();
      // A part whose qaFeedback is set was sent back by QA or the merge gate (MET-156).
      const review = s.qaFeedback[issue.id];
      const stored = review === undefined ? undefined : s.sessions?.[issue.id];
      const coldReason =
        review === undefined
          ? undefined
          : resumeColdReason(stored, agent.harness, worktree, adapter);
      const resumeSessionId = coldReason === undefined ? stored?.sessionId : undefined;
      let prompt =
        resumeSessionId !== undefined && review !== undefined
          ? buildResumePrompt({ issue, review })
          : buildPartPrompt({
              agent,
              issue,
              branch: worktree.branch,
              ...(review ? { review } : {}),
              ...(memory ? { memory } : {}),
            });
      if (kept?.worktree === worktree.path) prompt += `\n\n${RESUMED_RUN_NOTE}`;
      const id = `${issue.key}-${(s.attempts[issue.id] ?? 0) + 1}`;
      if (globalDir !== undefined) {
        // Save the guard's excludes path before sync writes anything, so a crash between
        // the two does not make synced files look like uncommitted work.
        entry.excludesFile = excludesFileFor(globalDir, id);
        await save();
      }
      // Before the agent starts, never in the adapter (D-002). A failure fails the run.
      const env = await prepareWorktree(worktree.path, id, agent);
      if (env !== undefined) runEnvs.set(issue.id, env);
      const task: Task = {
        id,
        title: `${issue.key}: ${issue.title}`,
        prompt,
        budgetMs: budget,
        maxTurns: maxTurnsFor(role, issue.size, config.limits),
      };
      if (agent.model !== undefined) task.model = agent.model;
      if (env !== undefined) task.env = env;
      if (resumeSessionId !== undefined) {
        task.resumeSessionId = resumeSessionId;
        resumed = true;
      }
      if (held(agent.harness)) {
        // Keep a previously paused worktree available for the eventual retry.
        if (kept?.worktree === entry.worktree) {
          s.interrupted.push(kept);
          entry.worktree = "";
        }
        await finish(
          s,
          entry,
          {
            status: "cancelled",
            exitCode: null,
            durationMs: 0,
            tokens: emptyTokenUsage(),
          },
          true,
        );
        return;
      }
      runHarnesses.set(issue.id, agent.harness);
      run = adapter.start(task, worktree.path);
      if (resumeSessionId !== undefined) {
        log(`${issue.key}: resuming ${harnessName(agent.harness)} session`);
      } else if (coldReason !== undefined) {
        log(`${issue.key}: cold run (${coldReason})`);
      }
      report.dispatched.push(issue.key);
    } catch (error) {
      await fail(error);
      return;
    }
    log(`${issue.key}: ${agentName} started (${issue.size ?? "M"}, ${budget / 60_000} min)`);
    const done = run.result.then(
      (result) => {
        noteRun(agent.harness, result);
        return finish(s, entry, result, false, resumed);
      },
      (error) => fail(error),
    );
    const l: LiveRun = {
      key: issue.key,
      entry,
      run,
      done,
      title: issue.title,
      budgetMs: budget,
      tokens: 0,
      harness: agent.harness,
      ...(switchReason === undefined ? {} : { switchReason }),
    };
    live.set(issue.id, l);
    follow(l, run);
    syncWatch();
    // Paused while this run was starting: stop it like the others.
    if (pausedNow) void pauseRuns();
  }

  /**
   * One QA round (docs/LOOP.md "QA"): each part's PR is checked out, tested and reviewed,
   * then settleQa moves the sub-issues. The round's worktree is recorded in the in-flight
   * entry, so a restart cleans it up. A pause aborts the round: it posts no review, counts
   * no QA failure, and the worktree in use is kept like a paused part's.
   */
  function startQa(
    s: LoopState,
    entry: InFlightRun,
    issue: LinkedIssue,
    qa: QaContext,
    agent: ResolvedAgentConfig,
    adapter: HarnessAdapter,
    budget: number,
    switchReason?: string,
  ): void {
    const maxRounds = config.limits.qa_max_failures;
    const abort = new AbortController();
    /** The QA agent's last run result, to tell a harness failure from a bad verdict (D-048). */
    let agentResult: RunResult | undefined;
    const l: LiveRun = {
      key: issue.key,
      entry,
      abort,
      done: Promise.resolve(),
      title: issue.title,
      budgetMs: budget,
      tokens: 0,
      harness: agent.harness,
      ...(switchReason === undefined ? {} : { switchReason }),
    };
    // The QA agent's run is the live run while it lasts, so a pause cancels it.
    const qaAdapter: HarnessAdapter = {
      id: adapter.id,
      start(task, cwd) {
        const deferred = deferWhileHeld(adapter.id);
        if (deferred !== undefined) return deferred;
        const run = adapter.start(task, cwd);
        l.run = run;
        follow(l, run);
        void run.result.then(
          (result) => {
            agentResult = result;
            noteRun(adapter.id, result);
          },
          () => undefined,
        );
        const clear = (): void => {
          if (l.run === run) delete l.run;
        };
        void run.result.then(clear, clear);
        if (abort.signal.aborted) void run.cancel();
        return run;
      },
    };
    live.set(issue.id, l);
    syncWatch();
    l.done = (async () => {
      let result: QaRunResult;
      try {
        result = await runQa(
          {
            qa: issue,
            parent: qa.parent,
            parts: qa.parts,
            approvedHeads: qa.approvedHeads,
            budgetMs: budget,
            maxTurns: maxTurnsFor("qa", qa.parent.size, config.limits),
            round: (s.qaFailures[qa.parent.id] ?? 0) + 1,
            maxRounds,
            ...(s.reviewedHeads === undefined ? {} : { reviewedHeads: s.reviewedHeads }),
          },
          {
            github,
            worktrees,
            adapter: qaAdapter,
            agent,
            commands: config.qa,
            signal: abort.signal,
            ...(options.runCommand ? { runCommand: options.runCommand } : {}),
            now: () => clock.now().getTime(),
            onWorktree: (path) => {
              entry.worktree = path;
              void save();
            },
            ...(globalDir === undefined
              ? {}
              : {
                  // runQa wraps a throw in the same "sync failed" message as a part run.
                  prepare: async (worktree, runId) =>
                    (await syncWorktree({ repoDir, globalDir, worktree, runId, agent })).env,
                }),
            ...(memory ? { memory } : {}),
            log,
          },
        );
      } catch (error) {
        result = {
          outcome: "error",
          reviews: qa.parts.map((part) => ({
            part,
            decision: "error" as const,
            failing: [],
            error: message(error),
          })),
          tokens: emptyTokenUsage(),
        };
        if (abort.signal.aborted) result.cancelled = true;
      }
      if (result.cancelled === true) await requeueStopped(s, entry);
      recordUsage(
        s,
        qa.parent.id,
        issue.key,
        agent.name,
        result.tokens ?? emptyTokenUsage(),
        result.turns,
        result.usageUnknown === true,
      );
      if (result.cancelled === true) {
        await save();
        return;
      }
      // The switch reads the QA agent's own result, not its verdict (D-048).
      if (agentResult !== undefined) {
        if (agentResult.status === "ok") clearSwitch(issue.id);
        else {
          const why = switchWhy(agentResult);
          if (why !== undefined) recordSwitch(s, issue.id, agent.harness, why);
        }
      }
      s.inFlight = s.inFlight.filter((e) => e !== entry);
      if (result.limited === true) {
        // The QA agent's harness hit a usage limit: no review, no QA failure (MET-70).
        await safely(`re-queue ${issue.key}`, () => linear.moveTo(issue.id, "Ready"));
        log(`${issue.key}: QA limited, re-queued`);
        await save();
        return;
      }
      // The head QA judged, per part: the same head is not reviewed twice (D-040).
      for (const r of result.reviews) {
        if (r.pr === undefined || r.decision === "error") continue;
        s.reviewedHeads ??= {};
        const head: ReviewedHead = {
          sha: r.pr.headRefOid,
          verdict: r.decision === "approve" ? "approved" : "changes_requested",
        };
        // The cases survive the builder's ok run, which deletes qaFeedback (D-054).
        if (r.decision === "request_changes" && r.cases !== undefined && r.cases.length > 0) {
          head.cases = r.cases;
        }
        s.reviewedHeads[r.part.id] = head;
      }
      const record: PendingQa = {
        parentId: qa.parent.id,
        qaKey: issue.key,
        reviews: result.reviews.map(pendingQaReview),
        done: [],
      };
      s.pendingQa ??= {};
      s.pendingQa[issue.id] = record;
      if (record.reviews.some((review) => !review.done)) {
        log(`${issue.key}: QA ${result.outcome}, pending`);
        await save();
        return;
      }

      // Keep the verdict before starting Linear writes. The live run owns this first attempt.
      await save();
      const settled = await settleQa(s, { qa: issue, parent: qa.parent }, result, {
        linear,
        notifier,
        maxFailures: maxRounds,
        log,
        steps: {
          done: record.done,
          async mark(step: string) {
            record.done.push(step);
            await save();
          },
        },
      });
      if (settled === "pending") {
        log(`${issue.key}: QA ${result.outcome}, pending`);
        return;
      }
      delete s.pendingQa[issue.id];
      if (Object.keys(s.pendingQa).length === 0) delete s.pendingQa;
      log(`${issue.key}: QA ${result.outcome}, ${settled}`);
      // Each approved part is its own merge entry, pinned to the head QA reviewed (D-040).
      for (const r of result.reviews) {
        if (r.decision !== "approve" || r.pr === undefined) continue;
        s.merges = s.merges.filter((m) => !m.prs.some((p) => p.partId === r.part.id));
        s.merges.push(pendingMerge(issue, qa.parent, [r], clock.now()));
      }
      await save();
    })().finally(() => {
      live.delete(issue.id);
      syncWatch();
    });
    // Paused while this round was starting: stop it like the others.
    if (pausedNow) void pauseRuns();
  }

  /**
   * Starts one review for a shipped part of an admitted parent in In Review that has no
   * reviewer verdict at its PR head (MET-224, D-060). It runs before QA and holds a
   * `max_concurrent` slot. A parent without a split record keeps running as before (D-050).
   */
  async function dispatchReviews(s: LoopState, report: TickReport): Promise<void> {
    const max = config.limits.max_concurrent;
    const shipped = s.shipped;
    if (pausedNow || s.inFlight.length >= max || shipped === undefined) return;
    const agentName = agentForRole(config, "reviewer");
    if (agentName === undefined) {
      log("no agent has role reviewer");
      return;
    }
    const main = resolveAgentConfig(config, agentName);
    const { ids: admitted, parents: holders } = admittedParents(await inFlightParents(s));
    const needsInput = new Set(holders.filter((p) => p.needsInput).map((p) => p.id));
    const parents = new Map<string, Issue>();
    for (const [id, record] of Object.entries(shipped)) {
      if (pausedNow || s.inFlight.length >= max) break;
      if (live.has(id) || s.inFlight.some((entry) => entry.issueId === id)) continue;
      if (s.pendingReview?.[id] !== undefined || s.pendingReviewSettle?.[id] !== undefined) {
        continue;
      }
      let part: Issue;
      try {
        part = await linear.getIssue(id);
      } catch (error) {
        log(`${record.key}: could not read it for the review: ${message(error)}`);
        continue;
      }
      if (part.state.toLowerCase() !== "in review") continue;
      // Only a part of a parent the loop split and admitted gets a review (D-050, D-057).
      let parentId: string | undefined;
      for (const [candidate, parentRecord] of Object.entries(s.splits ?? {})) {
        if (parentRecord.parts.includes(part.id)) {
          parentId = candidate;
          break;
        }
      }
      if (parentId === undefined) continue;
      if (!admitted.has(parentId) || needsInput.has(parentId)) continue;
      let pr: PullRequest | undefined;
      try {
        pr = await github.findPrByHead(record.branch);
      } catch (error) {
        log(`${record.key}: could not read its PR for the review: ${message(error)}`);
        continue;
      }
      if (pr === undefined) continue;
      if (s.reviewerHeads?.[id]?.sha === pr.headRefOid) continue;
      let parent = parents.get(parentId);
      if (parent === undefined) {
        try {
          parent = await linear.getIssue(parentId);
          parents.set(parentId, parent);
        } catch (error) {
          log(`${record.key}: could not read the parent for the review: ${message(error)}`);
          continue;
        }
      }
      const linked: LinkedIssue = {
        ...part,
        parentId,
        parentKey: parent.key,
        blockers: [],
      };
      await reviewPart(s, report, linked, parent, pr, main);
    }
  }

  /**
   * Starts one review of a part at its PR head when its budget allows (MET-224, D-060).
   * The caller has already checked the same-head gate and the dispatch guards. Returns true
   * when the review started.
   */
  async function reviewPart(
    s: LoopState,
    report: TickReport,
    part: LinkedIssue,
    parent: Issue,
    pr: PullRequest,
    main: ResolvedAgentConfig,
  ): Promise<boolean> {
    const budget = budgetMs(part.size, config.limits);
    if (budget === undefined) return false;
    if (await overTokenBudget(s, parent)) return false;
    const choice = chooseForRun(s, part.id, main);
    const agent = choice.agent;
    const adapter = agent && adapters[agent.harness];
    if (agent === undefined || adapter === undefined) {
      logNoHarness(part.key, part.id, choice.skipped);
      return false;
    }
    noHarness.delete(part.id);
    startReview(s, part, parent, pr, agent, adapter, budget, report);
    return true;
  }

  /**
   * The review a waiting QA round needs when the normal dispatch cannot see the part: a part
   * the loop never shipped in this state, or one of a parent it never split (MET-226). The
   * same-head gate holds, so a part with a verdict at this head is not reviewed again.
   */
  async function backfillReviews(
    s: LoopState,
    report: TickReport,
    pending: readonly LinkedIssue[],
    prs: ReadonlyMap<string, PullRequest>,
  ): Promise<void> {
    const max = config.limits.max_concurrent;
    const parents = new Map<string, Issue>();
    let main: ResolvedAgentConfig | undefined;
    for (const part of pending) {
      if (pausedNow || s.inFlight.length >= max) return;
      const pr = prs.get(part.id);
      if (pr === undefined) continue;
      if (s.reviewerHeads?.[part.id]?.sha === pr.headRefOid) continue;
      if (s.inFlight.some((entry) => entry.issueId === part.id)) continue;
      if (
        s.pendingReview?.[part.id] !== undefined ||
        s.pendingReviewSettle?.[part.id] !== undefined
      ) {
        continue;
      }
      const parentId = part.parentId;
      if (parentId === undefined) continue;
      let parent = parents.get(parentId);
      if (parent === undefined) {
        try {
          parent = await linear.getIssue(parentId);
          parents.set(parentId, parent);
        } catch (error) {
          log(`${part.key}: could not read its parent for the review: ${message(error)}`);
          continue;
        }
      }
      if (main === undefined) {
        const name = agentForRole(config, "reviewer");
        if (name === undefined) {
          log("no agent has role reviewer");
          return;
        }
        main = resolveAgentConfig(config, name);
      }
      await reviewPart(s, report, part, parent, pr, main);
    }
  }

  /**
   * One review run (MET-224, D-060). It stays in flight until it posts and records its
   * verdict, so a tick cannot start a second review of the same part. The part stays In
   * Review: a review creates no Linear state and no sub-issue.
   */
  function startReview(
    s: LoopState,
    part: LinkedIssue,
    parent: Issue,
    pr: PullRequest,
    agent: ResolvedAgentConfig,
    adapter: HarnessAdapter,
    budget: number,
    report: TickReport,
  ): void {
    const entry: InFlightRun = {
      issueId: part.id,
      issueKey: part.key,
      issueUrl: part.url,
      role: "reviewer",
      agent: agent.name,
      worktree: "",
      branch: pr.headRefName,
      startedAt: clock.now().toISOString(),
      pid,
    };
    s.inFlight.push(entry);
    const abort = new AbortController();
    let agentResult: RunResult | undefined;
    const l: LiveRun = {
      key: part.key,
      entry,
      abort,
      done: Promise.resolve(),
      title: part.title,
      budgetMs: budget,
      tokens: 0,
      harness: agent.harness,
    };
    // The reviewer's run is the live run while it lasts, so a pause cancels it.
    const reviewAdapter: HarnessAdapter = {
      id: adapter.id,
      start(task, cwd) {
        const deferred = deferWhileHeld(adapter.id);
        if (deferred !== undefined) return deferred;
        const run = adapter.start(task, cwd);
        l.run = run;
        follow(l, run);
        void run.result.then(
          (result) => {
            agentResult = result;
            noteRun(adapter.id, result);
          },
          () => undefined,
        );
        const clear = (): void => {
          if (l.run === run) delete l.run;
        };
        void run.result.then(clear, clear);
        if (abort.signal.aborted) void run.cancel();
        return run;
      },
    };
    live.set(part.id, l);
    syncWatch();
    report.dispatched.push(part.key);
    l.done = (async () => {
      let result: ReviewRunResult;
      const recorded = s.reviewerHeads?.[part.id];
      try {
        result = await runReview(
          {
            part,
            parent,
            pr,
            budgetMs: budget,
            maxTurns: maxTurnsFor("reviewer", part.size, config.limits),
            ...(recorded === undefined
              ? {}
              : { since: { sha: recorded.sha, findings: recorded.findings } }),
          },
          {
            github,
            worktrees,
            adapter: reviewAdapter,
            agent,
            signal: abort.signal,
            onWorktree: (path) => {
              entry.worktree = path;
              void save();
            },
            ...(globalDir === undefined
              ? {}
              : {
                  prepare: async (worktree, runId) =>
                    (await syncWorktree({ repoDir, globalDir, worktree, runId, agent })).env,
                }),
            ...(memory ? { memory } : {}),
            log,
          },
        );
      } catch (error) {
        result = { pr, tokens: emptyTokenUsage(), error: message(error) };
      }
      recordUsage(
        s,
        parent.id,
        part.key,
        agent.name,
        result.tokens ?? emptyTokenUsage(),
        result.turns,
        result.usageUnknown === true,
      );
      if (agentResult !== undefined) {
        if (agentResult.status === "ok") clearSwitch(part.id);
        else {
          const why = switchWhy(agentResult);
          if (why !== undefined) recordSwitch(s, part.id, agent.harness, why);
        }
      }
      if (entry.worktree !== "") {
        // A review checkout is never kept, even when the run failed (D-041).
        await removeWithGuard(s, entry, entry.worktree, { force: true });
      }
      if (result.cancelled === true) return;
      if (result.limited === true) {
        log(`${part.key}: review limited, retrying next tick`);
        return;
      }
      if (result.verdict !== undefined && result.body !== undefined) {
        const head: ReviewerHead = {
          sha: pr.headRefOid,
          verdict: result.verdict.decision === "approve" ? "approved" : "changes_requested",
          findings: result.verdict.findings,
          at: clock.now().toISOString(),
        };
        s.reviewerHeads ??= {};
        s.reviewerHeads[part.id] = head;
        s.pendingReview ??= {};
        s.pendingReview[part.id] = {
          partId: part.id,
          partKey: part.key,
          parentId: parent.id,
          prNumber: pr.number,
          prUrl: pr.url,
          head: pr.headRefOid,
          body: result.body,
          verdict: head.verdict,
          findings: head.findings,
        };
        await save();
        if (await postPendingReview(s, part.id)) {
          await settlePendingReview(s, part.id);
          log(`${part.key}: review ${head.verdict}, PR #${pr.number}`);
        }
      } else if (result.notJudged !== undefined) {
        // A turn cap, timeout, stall or invalid JSON is not judged: no review failure (D-052).
        await settleReviewPersisted(s, part, parent, pr, {
          notJudged: result.notJudged,
          ...(result.error === undefined ? {} : { error: result.error }),
        });
      } else {
        // A schema error or any other agent error counts a failed review (D-014, D-052).
        await settleReviewPersisted(s, part, parent, pr, {
          ...(result.error === undefined ? {} : { error: result.error }),
        });
        log(
          `${part.key}: review failed (${oneLine(result.error ?? "no verdict")}), retrying next tick`,
        );
      }
    })().finally(async () => {
      s.inFlight = s.inFlight.filter((e) => e !== entry);
      live.delete(part.id);
      syncWatch();
      await save();
    });
    // Paused while this review was starting: stop it like the others.
    if (pausedNow) void pauseRuns();
  }

  /** Ready sub-issues in priority order; parts must be unblocked, QA needs every part reviewed. */
  async function dispatchEligible(
    s: LoopState,
    report: TickReport,
    waiting: Set<string>,
  ): Promise<void> {
    const max = config.limits.max_concurrent;
    if (pausedNow) return;
    const candidates = await linear.listReadyContaining(team, PART_MARKER_PREFIX);
    const { ids: admitted, parents: holders } = admittedParents(await inFlightParents(s));
    const needsInput = new Set(holders.filter((p) => p.needsInput).map((p) => p.id));
    for (const issue of candidates) {
      if (pausedNow) break;
      if (s.inFlight.some((e) => e.issueId === issue.id)) continue;
      // A review whose settlement is unfinished still owns the part: a Ready move may have
      // landed before a timeout, so do not start its builder without the findings (MET-230).
      if (
        s.pendingReview?.[issue.id] !== undefined ||
        s.pendingReviewSettle?.[issue.id] !== undefined
      )
        continue;
      if (
        s.pendingQa?.[issue.id] !== undefined ||
        Object.values(s.pendingQa ?? {}).some((record) =>
          record.reviews.some((review) => review.partId === issue.id),
        )
      )
        continue;
      const marker = readPartMarker(issue.description);
      if (marker === undefined || (marker.role !== "qa" && s.inFlight.length >= max)) continue;
      const parentRecord = issue.parentId === undefined ? undefined : s.splits?.[issue.parentId];
      // A child the parent's split record does not list belongs to an older plan: leave it
      // alone, with no move and no comment (MET-217). A parent without a record keeps D-050's
      // "runs as before".
      if (
        parentRecord !== undefined &&
        !parentRecord.parts.includes(issue.id) &&
        parentRecord.qa !== issue.id
      ) {
        continue;
      }
      // Only an admitted in-flight parent's parts and QA start (D-050). A parent without a
      // split record was not split by the loop, so its parts keep running as before. A part
      // or QA of an admitted parent in Needs input keeps its place with no move and no
      // comment, and logs the wait line (D-057).
      if (
        issue.parentId !== undefined &&
        s.splits?.[issue.parentId] !== undefined &&
        (!admitted.has(issue.parentId) || needsInput.has(issue.parentId))
      ) {
        noteWait(issue.id, issue.key, holders, waiting);
        continue;
      }
      let qa: QaContext | undefined;
      if (marker.role === "qa") {
        if (issue.parentId === undefined) continue;
        // Per-part QA: review each part that is In Review at a head QA has not approved.
        // A part whose PR head did not change since its approval is not reviewed again (D-040).
        // With a split record, only the record's parts are reviewed, never an older plan's
        // marked child (MET-217).
        const record = s.splits?.[issue.parentId];
        const children = (await linear.listChildren(issue.parentId)).filter((child) =>
          record === undefined ? isWorkPart(child) : record.parts.includes(child.id),
        );
        const parts: LinkedIssue[] = [];
        const pendingReview: LinkedIssue[] = [];
        const pendingPrs = new Map<string, PullRequest>();
        const approvedHeads: Record<string, string> = {};
        for (const part of children) {
          if (part.state.toLowerCase() !== "in review") continue;
          let pr: PullRequest | undefined;
          try {
            pr = await github.findPrForIssue(part.key);
          } catch (error) {
            log(`${issue.key}: could not read the PR of ${part.key}: ${message(error)}`);
            continue;
          }
          const reviewed = s.reviewedHeads?.[part.id];
          if (
            reviewed?.verdict === "approved" &&
            pr !== undefined &&
            reviewed.sha === pr.headRefOid
          ) {
            continue;
          }
          // QA runs only after the reviewer approved the current PR head (MET-226, D-060).
          const reviewer = s.reviewerHeads?.[part.id];
          if (
            pr === undefined ||
            reviewer?.verdict !== "approved" ||
            reviewer.sha !== pr.headRefOid
          ) {
            pendingReview.push(part);
            if (pr !== undefined) pendingPrs.set(part.id, pr);
            continue;
          }
          parts.push(part);
          approvedHeads[part.id] = pr.headRefOid;
        }
        if (pendingReview.length > 0) {
          // A part the normal review dispatch cannot see still gets its review (MET-226).
          await backfillReviews(s, report, pendingReview, pendingPrs);
          noteReviewWait(issue.id, issue.key, pendingReview, waiting);
          continue;
        }
        if (parts.length === 0 || s.inFlight.length >= max) continue;
        let parent: Issue;
        try {
          parent = await linear.getIssue(issue.parentId);
        } catch (error) {
          log(`${issue.key}: could not read the parent, retrying next tick: ${message(error)}`);
          continue;
        }
        qa = { parent, parts, approvedHeads };
      } else if (issue.blockedBy.length > 0) {
        continue;
      }
      await dispatch(s, issue, marker.role, qa, report);
    }
  }

  // --- grill and split ----------------------------------------------------

  async function splitOne(
    issue: Issue,
    context: GrillContext,
    report: TickReport,
    shouldGrill: boolean,
  ): Promise<void> {
    const name = agentForRole(config, "coordinator");
    if (name === undefined) {
      log("no agent has role coordinator");
      return;
    }
    const main = resolveAgentConfig(config, name);
    const s = state;
    if (s === undefined) return;
    const record = s.splits?.[issue.id];
    // The next coordinator harness in the fixed order (D-048).
    const choice = chooseForRun(s, issue.id, main);
    const agent = choice.agent;
    const harness = agent && adapters[agent.harness];
    if (agent === undefined || harness === undefined) {
      logNoHarness(issue.key, issue.id, choice.skipped);
      return;
    }
    noHarness.delete(issue.id);
    const switched = switchLine(issue.key, main, agent, choice.record, choice.why);
    if (switched !== undefined) log(switched);
    const adapter = tracked(harness);

    // The children before this tick's grill. A marked child that was already here is an old
    // part, even when its marker matches the new plan (MET-216).
    const before = shouldGrill ? await linear.listChildren(issue.id) : [];
    const beforeIds = new Set(before.map((child) => child.id));
    // A parent without a record that still has marked children is grilled afresh, and the old
    // children are left alone. One line names them before the grill (MET-217).
    if (shouldGrill && record === undefined) {
      const oldParts = before.filter((child) => readPartMarker(child.description) !== undefined);
      if (oldParts.length > 0) {
        log(`${issue.key}: old parts not reused: ${oldParts.map((child) => child.key).join(", ")}`);
      }
    }
    let plan: SplitPlan = { parts: [], source: "model" };
    /** The grill's calls, rendered into each new part body (D-044). */
    let grillCalls: Call[] = [];
    // splitReady's grill flag, not the presence of marked children, decides the path. A parent
    // with a split record finishes its interrupted split without grilling again (MET-154).
    if (shouldGrill) {
      const grill = await grillIssue(issue, {
        adapter,
        agent,
        context,
        cwd: repoDir,
        linear,
        notifier,
        decisions,
        maxTurns: maxTurnsFor("coordinator", issue.size, config.limits),
      });
      grillCalls = grill.calls;
      if (state !== undefined) {
        recordUsage(
          state,
          issue.id,
          issue.key,
          agent.name,
          grill.tokens ?? emptyTokenUsage(),
          grill.turns,
          grill.usageUnknown === true,
        );
      }
      if (pausedNow) {
        log(`${issue.key}: paused, split skipped`);
        return;
      }
      if (grill.outcome === "limited") {
        if (grill.switchReason !== undefined) {
          recordSwitch(s, issue.id, agent.harness, grill.switchReason);
        }
        log(`${issue.key}: grill limited, the issue stays Ready`);
        return;
      }
      if (grill.outcome === "needs_input") {
        report.escalated.push(issue.key);
        clearSwitch(issue.id);
        log(`${issue.key}: grill escalated, Needs input`);
        return;
      }
      if (grill.outcome === "error") {
        if (grill.switchReason !== undefined) {
          recordSwitch(s, issue.id, agent.harness, grill.switchReason);
        }
        log(`${issue.key}: grill failed, retrying next tick: ${grill.error ?? "unknown"}`);
        return;
      }
      plan = await planIssue(issue, {
        adapter,
        agent,
        context,
        cwd: repoDir,
        calls: grill.calls,
        log,
        maxTurns: maxTurnsFor("coordinator", issue.size, config.limits),
      });
      if (state !== undefined) {
        recordUsage(
          state,
          issue.id,
          issue.key,
          agent.name,
          plan.tokens ?? emptyTokenUsage(),
          plan.turns,
          plan.usageUnknown === true,
        );
      }
      if (pausedNow) {
        log(`${issue.key}: paused, split skipped`);
        return;
      }
      if (plan.source === "limited") {
        if (plan.switchReason !== undefined) {
          recordSwitch(s, issue.id, agent.harness, plan.switchReason);
        }
        log(`${issue.key}: plan limited, the issue stays Ready`);
        return;
      }
      if (plan.source === "harness") {
        if (plan.switchReason !== undefined) {
          recordSwitch(s, issue.id, agent.harness, plan.switchReason);
        }
        log(`${issue.key}: plan failed, retrying next tick: ${plan.error ?? "unknown"}`);
        return;
      }
      if (plan.source === "bad") {
        // Two unusable plans: one comment, one notice, no sub-issue, Needs input (MET-160).
        const errors = plan.errors ?? [plan.error ?? "unknown"];
        await escalate(
          issue,
          "split",
          "the plan was rejected twice",
          `**Coordinator split**: needs input. The plan for ${issue.key} was rejected twice, ` +
            `so no sub-issues were created. The errors:\n` +
            errors.map((error) => `- ${oneLine(error)}`).join("\n") +
            `\n\nSplit it by hand, or move it back to Ready to plan again.`,
        );
        report.escalated.push(issue.key);
        return;
      }
      const tooBig = plan.parts.filter((p) => p.size === "L");
      if (tooBig.length > 0) {
        const why = `the plan still has L parts: ${tooBig.map((p) => p.title).join("; ")}`;
        await escalate(
          issue,
          "split",
          "an L issue did not split into S or M parts",
          `**Coordinator split**: needs input. ${issue.key} must be split into S or M parts before it runs (D-014), but ${why}. Split it by hand or reword it so it splits.`,
        );
        report.escalated.push(issue.key);
        return;
      }
    }

    // Read the children again after the grill and plan, then pass only the explicit reuse set.
    // A record names the current split; without one, this tick's plan does. Every other child
    // is left alone, never reused (MET-216).
    const fresh = (await linear.listChildren(issue.id)).filter(isLiveChild);
    let reuse: LinkedIssue[];
    if (record !== undefined) {
      // The record's own order is the plan order the split was built with (D-049).
      const byId = new Map(fresh.map((child) => [child.id, child]));
      reuse = [...record.parts.map((id) => byId.get(id)), byId.get(record.qa)].filter(
        (child): child is LinkedIssue => child !== undefined,
      );
    } else {
      const markers = new Set(partIds(plan.parts));
      reuse = fresh.filter((child) => {
        if (beforeIds.has(child.id)) return false;
        const marker = readPartMarker(child.description);
        return marker !== undefined && marker.role !== "qa" && markers.has(marker.id);
      });
    }
    const result = await splitIssue(issue, plan.parts, linear, reuse, grillCalls);
    if (state !== undefined) {
      state.splits ??= {};
      // A re-split keeps the record's first time: admission is oldest first (D-050). Only a
      // new record, after the owner canceled every part, gets a new time (MET-210).
      const at = state.splits[issue.id]?.at ?? clock.now().toISOString();
      state.splits[issue.id] = {
        key: issue.key,
        parts: result.parts.map((part) => part.id),
        qa: result.qa.id,
        at,
      };
      // Saved now, not at the end of the tick: the next tick must see the split even if this
      // process stops right after the move to In Progress (MET-154).
      await save();
    }
    if (result.created.length > 0) {
      // The first split note warns once per repo that QA runs no live app (MET-180). The key
      // is written only after the note is posted, so a failed comment can still warn later.
      const warning = noLiveQaWarning(config.qa, state?.qaLiveWarned, clock.now().toISOString());
      await linear.comment(issue.id, formatSplitComment(result, plan.reason, warning?.line));
      if (warning !== undefined && state !== undefined) {
        state.qaLiveWarned = warning.warnedAt;
        await save();
      }
    }
    await linear.moveTo(issue.id, "In Progress");
    // The coordinator's run is done: the next Ready issue starts on the main harness (D-048).
    clearSwitch(issue.id);
    report.split.push(issue.key);
    log(
      `${issue.key}: split into ${result.parts.map((p) => p.key).join(", ")} and QA ${result.qa.key}`,
    );
  }

  /** True when a parent in this state no longer holds a max_parents slot (MET-174, MET-209). */
  function endsParentSlot(state: string): boolean {
    const current = state.toLowerCase();
    return current === "done" || isCanceledState(state);
  }

  /** A parent in flight, with the split record time that orders the queue (D-050). */
  interface InFlightParent {
    id: string;
    key: string;
    at: string;
    /** True while Linear shows it in Needs input: it holds its slot but nothing of it starts. */
    needsInput: boolean;
  }

  /**
   * Parents in flight: those with a split record whose Linear state is not Done or Canceled
   * (MET-174, MET-209, D-050, D-057). A Ready parent with a record counts, and so does one
   * in Needs input: it keeps its slot until the owner moves it on. repairSplits drops a
   * record at Done or Canceled, and splitReady drops one whose recorded parts were all
   * canceled. Oldest split record first, so the earliest parent holds the first slot.
   */
  async function inFlightParents(
    s: LoopState | undefined,
    ready?: Set<string>,
  ): Promise<InFlightParent[]> {
    if (s?.splits === undefined) return [];
    const out: InFlightParent[] = [];
    for (const [id, record] of Object.entries(s.splits)) {
      const parent = { id, key: record.key, at: record.at, needsInput: false };
      // A Ready parent is in flight while its record stands; splitReady dropped an all-canceled
      // record before this read.
      if (ready?.has(id) === true) {
        out.push(parent);
        continue;
      }
      let issue: Issue;
      try {
        issue = await linear.getIssue(id);
      } catch {
        // Its state is unknown: count it, so a grill never overfills the limit.
        out.push(parent);
        continue;
      }
      if (!endsParentSlot(issue.state)) {
        parent.needsInput = issue.state.toLowerCase() === "needs input";
        out.push(parent);
      }
    }
    return out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.key.localeCompare(b.key));
  }

  /** The parents admitted now: the first max_parents in flight, oldest split record first. */
  function admittedParents(inFlight: InFlightParent[]): {
    ids: Set<string>;
    parents: InFlightParent[];
  } {
    const parents = inFlight.slice(0, config.limits.max_parents);
    return { ids: new Set(parents.map((p) => p.id)), parents };
  }

  /**
   * The in-flight holders a waiting parent or part saw last, so it logs once per wait and
   * again only when that set changes (D-050). The key includes each holder's Needs-input
   * flag, so a move into Needs input logs once more (D-057). An entry is dropped at the end
   * of a tick where the issue no longer waits.
   */
  const waited = new Map<string, string>();

  /**
   * The parts whose review was still pending when QA last looked, by QA sub-issue id. One
   * log line per wait and once per change, like the queue wait (D-050, MET-226).
   */
  const reviewWaits = new Map<string, string>();

  /** The holders as a dedup key, with each holder's Needs-input flag (D-057). */
  function holdersKey(holders: readonly InFlightParent[]): string {
    return holders
      .map((holder) => `${holder.key}:${holder.needsInput ? "needs input" : "in flight"}`)
      .sort()
      .join("|");
  }

  /** `<holders in flight>`: Needs-input holders named as such, mixed with the rest (D-057). */
  function waitText(holders: readonly InFlightParent[]): string {
    if (holders.length === 0) return "no parent is in flight";
    const parked = holders.filter((holder) => holder.needsInput);
    const flying = holders.filter((holder) => !holder.needsInput);
    const clauses: string[] = [];
    if (parked.length === 1) clauses.push(`${parked[0]?.key} needs input`);
    else if (parked.length > 1) clauses.push(`${parked.map((h) => h.key).join(", ")} need input`);
    if (flying.length === 1) clauses.push(`${flying[0]?.key} is in flight`);
    else if (flying.length > 1)
      clauses.push(`${flying.map((h) => h.key).join(", ")} are in flight`);
    return clauses.join(", ");
  }

  /** Logs `<key> waits, <holders>` once per wait and once per change of the set. */
  function noteWait(
    id: string,
    key: string,
    holders: readonly InFlightParent[],
    seen: Set<string>,
  ): void {
    seen.add(id);
    const next = holdersKey(holders);
    if (waited.get(id) === next) return;
    waited.set(id, next);
    log(`${key} waits, ${waitText(holders)}`);
  }

  /** Forgets the waits that ended since the last tick. */
  function clearWaits(seen: Set<string>): void {
    for (const id of [...waited.keys()]) if (!seen.has(id)) waited.delete(id);
    for (const id of [...reviewWaits.keys()]) if (!seen.has(id)) reviewWaits.delete(id);
  }

  /**
   * Logs `<QA key> waits, <part key> review pending` once per wait and once per change of
   * the pending parts (MET-226, D-050).
   */
  function noteReviewWait(
    id: string,
    key: string,
    parts: readonly LinkedIssue[],
    seen: Set<string>,
  ): void {
    seen.add(id);
    const ordered = [...parts].sort((a, b) => a.key.localeCompare(b.key));
    const next = ordered.map((part) => part.key).join("|");
    if (reviewWaits.get(id) === next) return;
    reviewWaits.set(id, next);
    log(`${key} waits, ${ordered.map((part) => `${part.key} review pending`).join(", ")}`);
  }

  async function splitReady(report: TickReport, waiting: Set<string>): Promise<void> {
    const issues = (await linear.listReady(team)).filter(
      (i) => readPartMarker(i.description) === undefined,
    );
    if (issues.length === 0) return;
    const context = await loadContext();

    // Settle the records on Ready parents first: a stale read keeps the parent in flight, an
    // interrupted split is finished without a grill, and no recorded work part left live frees
    // the parent for a new grill (MET-154, MET-217).
    const work: Array<{ issue: Issue; grill: boolean }> = [];
    for (const issue of issues) {
      if (pausedNow) break;
      const record = state?.splits?.[issue.id];
      if (record === undefined) {
        work.push({ issue, grill: true });
        continue;
      }
      let children: LinkedIssue[];
      try {
        children = await linear.listChildren(issue.id);
      } catch (error) {
        log(`${issue.key}: could not read the children, retrying next tick: ${message(error)}`);
        continue;
      }
      const ids = new Set(children.map((child) => child.id));
      if (![...record.parts, record.qa].every((id) => ids.has(id))) {
        // The read lags the split: grilling again would split the parent twice (MET-154).
        log(`${issue.key}: already split at ${record.at}, Linear read is stale; skipped`);
        continue;
      }
      const recorded = children.filter((child) => record.parts.includes(child.id));
      if (recorded.some(isLiveChild)) {
        // An interrupted split: finish it, but do not grill or plan it again.
        work.push({ issue, grill: false });
        continue;
      }
      // No recorded work part is live: the owner canceled or finished every part and moved
      // the parent back to Ready on purpose.
      if (state?.splits !== undefined) {
        delete state.splits[issue.id];
        await save();
      }
      work.push({ issue, grill: true });
    }
    if (pausedNow) return;

    // Grill only the top Ready parents, one per free max_parents slot (MET-174). An escalated,
    // failed or limited grill uses its slot for this tick and leaves the parent Ready for the
    // next one. Finishing an interrupted split starts no grill, so it is not limited.
    const ready = new Set(issues.map((issue) => issue.id));
    const limit = config.limits.max_parents;
    const inFlight = await inFlightParents(state, ready);
    let started = 0;
    const waitingParents: Array<{ id: string; key: string }> = [];
    for (const item of work) {
      if (pausedNow) break;
      if (item.grill) {
        if (inFlight.length + started >= limit) {
          waitingParents.push({ id: item.issue.id, key: item.issue.key });
          continue;
        }
        started++;
      }
      try {
        await splitOne(item.issue, context, report, item.grill);
      } catch (error) {
        log(`${item.issue.key}: split failed, retrying next tick: ${message(error)}`);
      }
    }
    if (waitingParents.length > 0) {
      // The line names the parents that hold the slots, recomputed so a grill started in this
      // tick is in the set. A parent left waiting logs again only when that set changes (D-050).
      const now = admittedParents(await inFlightParents(state, ready));
      for (const item of waitingParents) noteWait(item.id, item.key, now.parents, waiting);
    }
  }

  // --- pause --------------------------------------------------------------

  /** Coordinator runs go through this so a pause can cancel them. */
  function tracked(adapter: HarnessAdapter): HarnessAdapter {
    return {
      id: adapter.id,
      start(task, cwd) {
        const deferred = deferWhileHeld(adapter.id);
        if (deferred !== undefined) return deferred;
        const run = adapter.start(task, cwd);
        coordinatorRuns.add(run);
        syncWatch();
        void run.result
          .then(
            (result) => {
              noteRun(adapter.id, result);
              if (result.status === "limited" || result.status === "ok") return save();
            },
            () => undefined,
          )
          .finally(() => {
            coordinatorRuns.delete(run);
            syncWatch();
          });
        if (pausedNow) void run.cancel();
        return run;
      },
    };
  }

  /** Re-reads the flag; on an error the last known value stands. */
  async function readPaused(): Promise<boolean> {
    if (pauseInMemory) return true;
    if (options.paused !== undefined) {
      try {
        pausedNow = await options.paused();
      } catch (error) {
        log(`could not read the pause flag: ${message(error)}`);
      }
    }
    return pausedNow;
  }

  /**
   * Cancels every run in flight for a pause and waits until each has exited and been
   * recorded. Returns the keys this call cancelled.
   */
  async function pauseRuns(): Promise<string[]> {
    for (const run of coordinatorRuns) void run.cancel();
    const fresh = [...live.values()].filter((l) => l.entry.pausedAt === undefined);
    await markStopped(fresh, "pause");
    await awaitStopped([...live.values()].filter((l) => l.entry.pausedAt !== undefined));
    return fresh.map((l) => l.key);
  }

  /**
   * Marks runs as stopped with their worktree kept, before the kill, so a crash from here
   * on still keeps the worktrees. `stopReason` is unset for a pause.
   */
  async function markStopped(runs: LiveRun[], why: "pause" | "self-update"): Promise<void> {
    if (runs.length === 0) return;
    const stamp = clock.now().toISOString();
    for (const l of runs) {
      l.entry.pausedAt = stamp;
      if (why === "self-update") l.entry.stopReason = "self-update";
      else delete l.entry.stopReason;
    }
    await save();
    const keys = runs.map((l) => l.key).join(", ");
    log(
      why === "pause"
        ? `pause: cancelling ${keys}`
        : `self-update: cancelling ${keys}, over budget`,
    );
  }

  /** Cancels marked runs and waits until each has exited and been recorded. */
  async function awaitStopped(stopping: LiveRun[]): Promise<void> {
    await Promise.all(
      stopping.map(async (l) => {
        // A QA round between agent runs has no run: aborting stops its tests and reviews.
        l.abort?.abort();
        await l.run?.cancel();
        await l.done;
      }),
    );
  }

  /** While runs are in flight, the flag is re-read every watchMs, so a pause lands within 10 s. */
  function syncWatch(): void {
    const busy = live.size > 0 || coordinatorRuns.size > 0;
    if (busy && watch === undefined && options.paused !== undefined) {
      watch = clock.setInterval(() => void checkPause(), watchMs);
      // The watch alone never keeps the process alive.
      (watch as { unref?: () => void } | null)?.unref?.();
    } else if (!busy && watch !== undefined) {
      clock.clearInterval(watch);
      watch = undefined;
    }
  }

  async function checkPause(): Promise<void> {
    if (checking) return;
    checking = true;
    try {
      if (await readPaused()) await pauseRuns();
    } catch (error) {
      log(`pause check failed: ${message(error)}`);
    } finally {
      checking = false;
    }
  }

  // --- self-update --------------------------------------------------------

  /** Asks the updater for a newer build; a target becomes a pending update. */
  async function checkUpdate(
    s: LoopState,
    up: LoopSelfUpdate,
    trigger: SelfUpdateTrigger | undefined,
  ): Promise<void> {
    let target: Awaited<ReturnType<SelfUpdater["checkForUpdate"]>>;
    try {
      target = await up.updater.checkForUpdate();
    } catch (error) {
      log(`self-update: check failed: ${oneLine(message(error))}`);
      return;
    }
    const u = s.selfUpdate;
    if (target === undefined) {
      if (u?.state === "pending") {
        // Updated another way since: nothing is left to apply.
        delete s.selfUpdate;
        await save();
      }
      return;
    }
    if (u?.state === "pending" && u.to === target.to) return;
    const record: SelfUpdateRecord = {
      from: target.from,
      to: target.to,
      at: clock.now().toISOString(),
      state: "pending",
    };
    const cause = trigger ?? (u?.to === target.to ? u.trigger : undefined);
    if (cause !== undefined) record.trigger = cause;
    s.selfUpdate = record;
    await save();
    log(`self-update: ${shortSha(target.from)} -> ${shortSha(target.to)} waits for a safe point`);
  }

  /**
   * The safe point: no run in flight. A run over its size budget (D-014) is stopped like a
   * paused one: its worktree is kept and it runs again after the restart.
   */
  async function safePoint(s: LoopState, up: LoopSelfUpdate): Promise<void> {
    const now = clock.now().getTime();
    const over = [...live.values()].filter(
      (l) => l.entry.pausedAt === undefined && now - Date.parse(l.entry.startedAt) > l.budgetMs,
    );
    await markStopped(over, "self-update");
    await awaitStopped(over);
    if (s.inFlight.length > 0) return;
    await applyUpdate(s, up);
  }

  async function applyUpdate(s: LoopState, up: LoopSelfUpdate): Promise<void> {
    const u = s.selfUpdate;
    if (u === undefined) return;
    const span = `${shortSha(u.from)} -> ${shortSha(u.to)}`;
    u.state = "applying";
    u.at = clock.now().toISOString();
    delete u.error;
    // Saved first: the new process reads it and finishes the record.
    await save();
    log(`self-update: ${span}: safe point, updating`);
    let result: SelfUpdateResult | { status: "error"; error: string };
    try {
      result = await up.updater.applyUpdate({ from: u.from, to: u.to });
    } catch (error) {
      result = { status: "error", error: message(error) };
    }
    if (result.status === "applied") {
      restarting = true;
      log(`self-update: ${span}: built, restarting`);
      return;
    }
    const blocked = result.status === "blocked";
    const step = result.status === "failed" ? result.step : undefined;
    /** The step's output, for the comment's code block. */
    const output = result.status === "blocked" ? "" : lastLines(result.error);
    const detail =
      result.status === "blocked" ? result.reason : step ? `${step}: ${output}` : output;
    const reason = `self-update ${blocked ? "blocked" : "failed"}: ${detail}`;
    u.state = blocked ? "blocked" : "failed";
    u.error = detail;
    u.at = clock.now().toISOString();
    pausedNow = true;
    pausedSeen = true;
    pauseInMemory = !(await safely("pause the loop", () => up.pause(reason)));
    log(`${oneLine(reason)}; the old build keeps running, the loop is paused`);
    if (s.selfUpdateNotices[u.to] !== undefined) {
      // The same target failed before: the owner already knows.
      await save();
      return;
    }
    s.selfUpdateNotices[u.to] = clock.now().toISOString();
    await save();
    const what = blocked ? `is blocked: ${detail}` : `failed${step ? ` at ${step}` : ""}`;
    const body = [
      `**harnessd self-update**: the update from \`${shortSha(u.from)}\` to \`${shortSha(u.to)}\` ${what}. ` +
        "harnessd keeps the old build and is paused. Fix it, then run `harnessd resume`.",
      ...(blocked ? [] : ["", "```", output, "```"]),
    ].join("\n");
    const trigger = u.trigger;
    if (trigger !== undefined) {
      await safely(`comment on ${trigger.key}`, () => linear.comment(trigger.id, `${body}\n`));
      await safely(`move ${trigger.key} to Needs input`, () =>
        linear.moveTo(trigger.id, "Needs input"),
      );
    }
    const issue = trigger
      ? { key: trigger.key, ...(trigger.url ? { url: trigger.url } : {}) }
      : { key: "harnessd" };
    await safely("send the notice", () =>
      notifier.notify({
        kind: "needs_input",
        issue,
        prs: [],
        reason: `self-update ${blocked ? "blocked" : "failed"}`,
        detail: `${shortSha(u.from)} -> ${shortSha(u.to)}: ${detail}`,
      }),
    );
  }

  /** True while an update waits or restarts: the tick then dispatches, grills and merges nothing. */
  async function holdForUpdate(s: LoopState): Promise<boolean> {
    const up = options.selfUpdate;
    if (up === undefined) return false;
    if (restarting) return true;
    if (s.selfUpdate?.state !== "pending") return false;
    await safePoint(s, up);
    return true;
  }

  // --- tick ---------------------------------------------------------------

  async function pass(): Promise<TickReport> {
    const s = await init();
    const report: TickReport = {
      paused: false,
      requeued: [],
      split: [],
      escalated: [],
      dispatched: [],
      merged: [],
    };
    await requeue(s, report);
    await releaseHolds(s);
    if (await readPaused()) {
      report.paused = true;
      pausedSeen = true;
      // Written by the CLI while no daemon was reachable: stop what still runs.
      await pauseRuns();
      return report;
    }
    s.lastPollAt = clock.now().toISOString();
    // Before dispatch, so the retried verdict can still merge or send back this tick (D-058).
    await retryPendingQa(s);
    // A review comment a failed post left behind goes out before any new run starts (MET-224).
    await retryPendingReviews(s);
    // A review settle a timeout left unfinished finishes before dispatch (MET-230).
    await retryReviewSettles(s);
    // Before dispatch, so QA can start on the same tick: a shipped part Linear moved back to
    // In Progress is In Review again (MET-128). It runs while a self-update waits: it starts nothing.
    await repairShipped(s);
    await repairSplits(s);
    // Once after start, before dispatch: a previous process's leftover goes back to Ready
    // (MET-214). It starts nothing on its own and runs while a self-update waits.
    await sweepOrphans(s);
    const up = options.selfUpdate;
    if (pausedSeen) {
      pausedSeen = false;
      // `harnessd resume` after a blocked or failed update: check again.
      const last = s.selfUpdate;
      if (last?.state === "blocked" || last?.state === "failed") {
        checkWanted ??= {};
      }
    }
    const checkedBeforeMerge = up !== undefined && checkWanted !== undefined && !restarting;
    if (checkedBeforeMerge) {
      const wanted = checkWanted;
      checkWanted = undefined;
      await checkUpdate(s, up, wanted?.trigger);
    }
    if (await holdForUpdate(s)) {
      await save();
      report.paused = pausedNow;
      return report;
    }
    if (s.merges.length > 0) {
      const merges = await advanceMerges(s, {
        github,
        linear,
        notifier,
        config: config.merge,
        maxFailures: config.limits.qa_max_failures,
        // Re-read before every merge, so a pause stops merges too (MET-15).
        paused: readPaused,
        save,
        now: () => clock.now(),
        log,
      });
      report.merged = merges.merged;
      // A merge to the default branch, by harnessd or a human, may change harnessd itself.
      // Remembered first, so a pause in the same pass does not lose it.
      const landed = merges.landed.at(-1);
      if (up !== undefined && landed !== undefined) checkWanted = { trigger: landed };
      if (merges.paused) {
        report.paused = true;
        await pauseRuns();
        await save();
        return report;
      }
    }
    // Poll the default branch even when a merge happened outside the gate's queue.
    if (up !== undefined && (checkWanted !== undefined || !checkedBeforeMerge)) {
      const wanted = checkWanted;
      checkWanted = undefined;
      await checkUpdate(s, up, wanted?.trigger);
      if (await holdForUpdate(s)) {
        await save();
        report.paused = pausedNow;
        return report;
      }
    }
    const waiting = new Set<string>();
    // The review of an In Review part starts before QA sees the same head (MET-224).
    await dispatchReviews(s, report);
    await dispatchEligible(s, report, waiting);
    await splitReady(report, waiting);
    await dispatchEligible(s, report, waiting);
    clearWaits(waiting);
    await save();
    report.paused = pausedNow;
    return report;
  }

  /**
   * Counts a tick whose Linear call failed in transport, and drops the pooled connections
   * after 3 in a row (MET-213, D-058). A clean tick starts the count again.
   */
  function noteLinearTick(): void {
    if (!linearNetworkThisTick) {
      linearFailedTicks = 0;
      return;
    }
    linearNetworkThisTick = false;
    linearFailedTicks += 1;
    if (linearFailedTicks < 3) return;
    linearFailedTicks = 0;
    linearClient.resetConnections?.();
    log("Linear unreachable for 3 ticks, connections reset");
  }

  async function runPass(): Promise<TickReport> {
    try {
      return await pass();
    } finally {
      noteLinearTick();
    }
  }

  const safeTick = (): void => {
    loop.tick().catch((error) => log(`tick failed: ${message(error)}`));
  };

  const loop: CoordinatorLoop = {
    tick() {
      ticking ??= runPass().finally(() => {
        ticking = undefined;
      });
      return ticking;
    },
    async releaseExpiredHolds() {
      await releaseHolds(await init());
    },
    start() {
      if (timer !== undefined) return;
      timer = clock.setInterval(safeTick, intervalMs);
      safeTick();
    },
    stop() {
      if (timer === undefined) return;
      clock.clearInterval(timer);
      timer = undefined;
    },
    async idle() {
      for (;;) {
        if (ticking) await ticking.catch(() => undefined);
        if (live.size === 0 && !ticking) break;
        await Promise.all([...live.values()].map((l) => l.done));
      }
      await saving;
    },
    running() {
      return [...live.values()].map((l) => l.key);
    },
    pause() {
      pausedNow = true;
      return pauseRuns();
    },
    snapshot() {
      const runs = [...live.values()].map((l): RunActivity => {
        const a: RunActivity = {
          issueId: l.entry.issueId,
          issueKey: l.key,
          title: l.title,
          agent: l.entry.agent,
          role: l.entry.role,
          startedAt: l.entry.startedAt,
          budgetMs: l.budgetMs,
          tokens: l.tokens,
          harness: l.harness,
          stopping: l.entry.pausedAt !== undefined,
        };
        if (l.switchReason !== undefined) a.switchReason = l.switchReason;
        if (l.lastAction !== undefined) a.lastAction = l.lastAction;
        return a;
      });
      const blocked = (state?.merges ?? []).flatMap((m) =>
        m.prs
          .filter((pr) => pr.needsHuman !== undefined && pr.mergedAt === undefined)
          .map((pr) => ({
            issueKey: pr.partKey,
            parentKey: m.parentKey,
            prUrl: pr.url,
            reason: pr.needsHuman ?? "",
          })),
      );
      const limits = activeLimits(state?.limits ?? {}, clock.now());
      const out: LoopSnapshot = {
        lastPollAt: state?.lastPollAt ?? null,
        runs,
        blocked,
        limits,
        usage: state?.usage ?? {},
      };
      const u = state?.selfUpdate;
      if (u !== undefined) {
        out.selfUpdate = { from: u.from, to: u.to, at: u.at, state: u.state };
        if (u.error !== undefined) out.selfUpdate.error = u.error;
      }
      return out;
    },
    resume() {
      pauseInMemory = false;
      pausedNow = false;
      if (timer === undefined) return;
      // A tick already under way may have stopped at the pause check: tick again after it.
      void (ticking ?? Promise.resolve()).catch(() => undefined).then(safeTick);
    },
  };
  return loop;
}
