// The autonomy loop (SPEC "Autonomy loop" steps 1-7, D-010, D-012, D-013, D-014). See docs/LOOP.md.
//
// Each tick: re-queue runs a previous process left behind, check the pause flag, advance
// the merge gate, dispatch eligible sub-issues, grill and split Ready issues, then dispatch
// again. Linear is the source of truth; loop.json only remembers in-flight runs, paused
// runs, failure counts and QA approvals waiting to merge.
import {
  type AdapterRun,
  emptyTokenUsage,
  type HarnessAdapter,
  type HarnessId,
  type Issue,
  type LinkedIssue,
  type MergedConfig,
  type ResolvedAgentConfig,
  type RunResult,
  type Task,
} from "@harnessd/shared";
import { resolveAgentConfig } from "../config/merge.ts";
import type { GitHub } from "../github/client.ts";
import type { LinearClient, ListReadyOptions } from "../linear/client.ts";
import type { TaskWorktrees } from "../worktrees/index.ts";
import { createFileDecisionSink, type DecisionSink, workspaceVaultDir } from "./decisions.ts";
import { agentForRole, budgetMs, buildPartPrompt } from "./dispatch.ts";
import { grillIssue } from "./grill.ts";
import { advanceMerges, pendingMerge } from "./merge.ts";
import { type Notifier, NullNotifier } from "./notifier.ts";
import { planIssue, type SplitPlan } from "./plan.ts";
import { type GrillContext, loadGrillContext } from "./prompt.ts";
import { type CommandRunner, type QaRunResult, runQa, settleQa } from "./qa.ts";
import {
  formatSplitComment,
  isWorkPart,
  PART_MARKER_PREFIX,
  readPartMarker,
  type SubIssueRole,
  splitIssue,
} from "./split.ts";
import type { InFlightRun, LoopState, LoopStore } from "./state.ts";

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
>;

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

/** States in which a part no longer blocks its QA sub-issue. */
const QA_READY_STATES = new Set(["in review", "done"]);

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
  /** The installed skill pack (`~/.harnessd/skills`). The grill reads its method from it (D-021). */
  skillsDir?: string;
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
  /** Recorded as the owner of runs. Default this process. */
  pid?: number;
}

/** What a QA run checks: the parent's checklist and the parts that block QA. */
interface QaContext {
  parent: Issue;
  parts: LinkedIssue[];
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
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function createCoordinatorLoop(options: CoordinatorLoopOptions): CoordinatorLoop {
  const { config, linear, adapters, worktrees, github, store, repoDir, team } = options;
  const clock = options.clock ?? systemClock;
  const notifier = options.notifier ?? new NullNotifier();
  const decisions = options.decisions ?? createFileDecisionSink(workspaceVaultDir(repoDir));
  const skillsDir = options.skillsDir;
  const loadContext = options.context ?? (() => loadGrillContext(repoDir, { skillsDir }));
  const log = options.log ?? (() => {});
  const pid = options.pid ?? process.pid;
  const intervalMs = options.intervalMs ?? DEFAULT_LOOP_INTERVAL_MS;
  const watchMs = options.pauseWatchMs ?? DEFAULT_PAUSE_WATCH_MS;

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
  let watch: unknown;
  let checking = false;

  function init(): Promise<LoopState> {
    ready ??= (async () => {
      try {
        await worktrees.recover();
      } catch (error) {
        log(`worktree recovery failed: ${message(error)}`);
      }
      state = await store.load();
      return state;
    })();
    return ready;
  }

  /** Saves are chained so a slow write never lands after a newer one. */
  function save(): Promise<void> {
    const snapshot = structuredClone(state);
    if (snapshot === undefined) return saving;
    saving = saving
      .catch(() => undefined)
      .then(() => store.save(snapshot))
      .catch((error) => log(`could not save loop state: ${message(error)}`));
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

  // --- re-queue -----------------------------------------------------------

  /** In-flight entries no live run owns: a previous process died with them. No attempt counted. */
  async function requeue(s: LoopState, report: TickReport): Promise<void> {
    for (const entry of [...s.inFlight]) {
      if (live.has(entry.issueId)) continue;
      if (entry.pausedAt !== undefined) {
        // A pause cancelled it, then the process stopped before it was recorded. Keep the worktree.
        const moved = await safely(`re-queue ${entry.issueKey}`, () =>
          linear.moveTo(entry.issueId, "Ready"),
        );
        if (!moved) continue;
        s.inFlight = s.inFlight.filter((e) => e !== entry);
        await keepInterrupted(s, entry);
        report.requeued.push(entry.issueKey);
        continue;
      }
      if (entry.worktree !== "") {
        await safely(`remove the worktree of ${entry.issueKey}`, () =>
          worktrees.remove(entry.worktree),
        );
      }
      const moved = await safely(`re-queue ${entry.issueKey}`, () =>
        linear.moveTo(entry.issueId, "Ready"),
      );
      if (!moved) continue;
      s.inFlight = s.inFlight.filter((e) => e !== entry);
      report.requeued.push(entry.issueKey);
      log(`${entry.issueKey}: interrupted run re-queued`);
    }
    if (report.requeued.length > 0) await save();
  }

  // --- dispatch -----------------------------------------------------------

  /** Needs input: one comment, the state move and one ping (D-011, D-014). */
  async function escalate(
    target: { id: string; key: string; url?: string },
    reason: string,
    summary: string,
    comment: string,
  ): Promise<void> {
    await safely(`comment on ${target.key}`, () => linear.comment(target.id, comment));
    await safely(`move ${target.key} to Needs input`, () =>
      linear.moveTo(target.id, "Needs input"),
    );
    const url = target.url ? ` ${target.url}` : "";
    await safely("send the ping", () =>
      notifier.notify(`${target.key} needs input (${reason}): ${summary}${url}`),
    );
  }

  /** Records a run a pause cancelled, worktree kept for inspection, and says so on the issue. */
  async function keepInterrupted(s: LoopState, entry: InFlightRun): Promise<void> {
    s.interrupted = s.interrupted.filter((e) => e.issueId !== entry.issueId);
    if (entry.worktree !== "") {
      s.interrupted.push({
        issueId: entry.issueId,
        issueKey: entry.issueKey,
        role: entry.role,
        agent: entry.agent,
        worktree: entry.worktree,
        branch: entry.branch,
        interruptedAt: entry.pausedAt ?? clock.now().toISOString(),
        reason: "paused",
      });
    }
    const where =
      entry.worktree === "" ? "it had no worktree yet" : `worktree kept at ${entry.worktree}`;
    await safely(`comment on ${entry.issueKey}`, () =>
      linear.comment(entry.issueId, `**harnessd**: Paused by harnessd pause; ${where}.`),
    );
    log(`${entry.issueKey}: paused, re-queued, ${where}`);
  }

  async function finish(s: LoopState, entry: InFlightRun, result: RunResult): Promise<void> {
    live.delete(entry.issueId);
    syncWatch();
    s.inFlight = s.inFlight.filter((e) => e !== entry);
    if (entry.pausedAt !== undefined && result.status !== "ok") {
      // Cancelled by a pause: keep the worktree, back to Ready, no attempt counted.
      await keepInterrupted(s, entry);
      await safely(`re-queue ${entry.issueKey}`, () => linear.moveTo(entry.issueId, "Ready"));
      await save();
      return;
    }
    if (entry.worktree !== "") {
      await safely(`remove the worktree of ${entry.issueKey}`, () =>
        worktrees.remove(entry.worktree),
      );
    }
    const id = entry.issueId;
    if (result.status === "ok") {
      delete s.attempts[id];
      delete s.qaFeedback[id];
      await safely(`move ${entry.issueKey} to In Review`, () => linear.moveTo(id, "In Review"));
      log(`${entry.issueKey}: done, In Review`);
    } else if (result.status === "cancelled") {
      await safely(`re-queue ${entry.issueKey}`, () => linear.moveTo(id, "Ready"));
      log(`${entry.issueKey}: cancelled, re-queued`);
    } else {
      const failures = (s.attempts[id] ?? 0) + 1;
      const why = `${result.status}${result.error ? `: ${oneLine(result.error)}` : ""}`;
      if (failures >= MAX_RUN_ATTEMPTS) {
        delete s.attempts[id];
        await escalate(
          { id, key: entry.issueKey },
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
    await save();
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
    const agent = resolveAgentConfig(config, agentName);
    const adapter = adapters[agent.harness];
    if (adapter === undefined) {
      log(`${issue.key}: no adapter for harness ${agent.harness}`);
      return;
    }
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
    const started = await safely(`move ${issue.key} to In Progress`, () =>
      linear.moveTo(issue.id, "In Progress"),
    );
    if (!started) return;

    const entry: InFlightRun = {
      issueId: issue.id,
      issueKey: issue.key,
      role,
      agent: agentName,
      worktree: "",
      branch: "",
      startedAt: clock.now().toISOString(),
      pid,
    };
    s.inFlight.push(entry);
    report.dispatched.push(issue.key);
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
      const kept = s.interrupted.find((e) => e.issueId === issue.id);
      if (kept !== undefined) {
        s.interrupted = s.interrupted.filter((e) => e !== kept);
        await safely(`remove the old worktree of ${issue.key}`, () =>
          worktrees.remove(kept.worktree),
        );
        await save();
      }
      startQa(s, entry, issue, qa, agent, adapter, budget);
      log(`${issue.key}: ${agentName} started QA of ${qa.parts.map((p) => p.key).join(", ")}`);
      return;
    }

    let run: AdapterRun;
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
          await safely(`remove the old worktree of ${issue.key}`, () =>
            worktrees.remove(kept.worktree),
          );
        }
      }
      await save();
      const review = s.qaFeedback[issue.id];
      let prompt = buildPartPrompt({
        agent,
        issue,
        branch: worktree.branch,
        ...(review ? { review } : {}),
      });
      if (kept?.worktree === worktree.path) prompt += `\n\n${RESUMED_RUN_NOTE}`;
      const task: Task = {
        id: `${issue.key}-${(s.attempts[issue.id] ?? 0) + 1}`,
        title: `${issue.key}: ${issue.title}`,
        prompt,
        budgetMs: budget,
      };
      if (agent.model !== undefined) task.model = agent.model;
      run = adapter.start(task, worktree.path);
    } catch (error) {
      await fail(error);
      return;
    }
    log(`${issue.key}: ${agentName} started (${issue.size ?? "M"}, ${budget / 60_000} min)`);
    const done = run.result.then(
      (result) => finish(s, entry, result),
      (error) => fail(error),
    );
    live.set(issue.id, { key: issue.key, entry, run, done });
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
  ): void {
    const maxRounds = config.limits.qa_max_failures;
    const abort = new AbortController();
    const l: LiveRun = { key: issue.key, entry, abort, done: Promise.resolve() };
    // The QA agent's run is the live run while it lasts, so a pause cancels it.
    const qaAdapter: HarnessAdapter = {
      id: adapter.id,
      start(task, cwd) {
        const run = adapter.start(task, cwd);
        l.run = run;
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
            budgetMs: budget,
            round: (s.qaFailures[qa.parent.id] ?? 0) + 1,
            maxRounds,
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
        };
        if (abort.signal.aborted) result.cancelled = true;
      }
      live.delete(issue.id);
      syncWatch();
      s.inFlight = s.inFlight.filter((e) => e !== entry);
      if (result.cancelled === true) {
        // Cancelled by a pause: no review, no QA failure, back to Ready, worktree kept.
        await keepInterrupted(s, entry);
        await safely(`re-queue ${issue.key}`, () => linear.moveTo(issue.id, "Ready"));
        await save();
        return;
      }
      const settled = await settleQa(s, { qa: issue, parent: qa.parent }, result, {
        linear,
        notifier,
        maxFailures: maxRounds,
        log,
      });
      log(`${issue.key}: QA ${result.outcome}, ${settled}`);
      if (settled === "approved") {
        // The merge gate's record, pinned to the heads QA reviewed (docs/LOOP.md "Merge").
        s.merges = s.merges.filter((m) => m.qaId !== issue.id);
        s.merges.push(pendingMerge(issue, qa.parent, result.reviews, clock.now()));
      }
      await save();
    })();
    // Paused while this round was starting: stop it like the others.
    if (pausedNow) void pauseRuns();
  }

  /** Ready sub-issues in priority order; parts must be unblocked, QA needs every part reviewed. */
  async function dispatchEligible(s: LoopState, report: TickReport): Promise<void> {
    const max = config.limits.max_concurrent;
    if (pausedNow || s.inFlight.length >= max) return;
    const candidates = await linear.listReadyContaining(team, PART_MARKER_PREFIX);
    for (const issue of candidates) {
      if (pausedNow || s.inFlight.length >= max) break;
      if (s.inFlight.some((e) => e.issueId === issue.id)) continue;
      const marker = readPartMarker(issue.description);
      if (marker === undefined) continue;
      let qa: QaContext | undefined;
      if (marker.role === "qa") {
        if (issue.parentId === undefined) continue;
        // The parts that block QA; when Linear lost the relations, every part of the parent.
        const children = (await linear.listChildren(issue.parentId)).filter(isWorkPart);
        const blocking = children.filter((p) => issue.blockers.some((b) => b.id === p.id));
        const parts = blocking.length > 0 ? blocking : children;
        const reviewed = parts.every((p) => QA_READY_STATES.has(p.state.toLowerCase()));
        if (parts.length === 0 || !reviewed) continue;
        let parent: Issue;
        try {
          parent = await linear.getIssue(issue.parentId);
        } catch (error) {
          log(`${issue.key}: could not read the parent, retrying next tick: ${message(error)}`);
          continue;
        }
        qa = { parent, parts };
      } else if (issue.blockedBy.length > 0) {
        continue;
      }
      await dispatch(s, issue, marker.role, qa, report);
    }
  }

  // --- grill and split ----------------------------------------------------

  async function splitOne(issue: Issue, context: GrillContext, report: TickReport): Promise<void> {
    const name = agentForRole(config, "coordinator");
    if (name === undefined) {
      log("no agent has role coordinator");
      return;
    }
    const agent = resolveAgentConfig(config, name);
    const harness = adapters[agent.harness];
    if (harness === undefined) {
      log(`${issue.key}: no adapter for harness ${agent.harness}`);
      return;
    }
    const adapter = tracked(harness);

    const children = await linear.listChildren(issue.id);
    let plan: SplitPlan = { parts: [], source: "model" };
    // Parts already exist: an earlier tick grilled and split, then stopped early. Finish it.
    if (!children.some(isWorkPart)) {
      const grill = await grillIssue(issue, {
        adapter,
        agent,
        context,
        cwd: repoDir,
        linear,
        notifier,
        decisions,
      });
      if (pausedNow) {
        log(`${issue.key}: paused, split skipped`);
        return;
      }
      if (grill.outcome === "needs_input") {
        report.escalated.push(issue.key);
        log(`${issue.key}: grill escalated, Needs input`);
        return;
      }
      if (grill.outcome === "error") {
        log(`${issue.key}: grill failed, retrying next tick: ${grill.error ?? "unknown"}`);
        return;
      }
      plan = await planIssue(issue, { adapter, agent, context, cwd: repoDir, calls: grill.calls });
      if (pausedNow) {
        log(`${issue.key}: paused, split skipped`);
        return;
      }
      if (plan.source === "fallback") log(`${issue.key}: plan fallback: ${plan.error ?? ""}`);
      const tooBig = plan.parts.filter((p) => p.size === "L");
      if (tooBig.length > 0) {
        const why =
          plan.source === "fallback"
            ? `the plan reply was unusable (${oneLine(plan.error ?? "unknown")}), and the fallback is one part at the issue's size`
            : `the plan still has L parts: ${tooBig.map((p) => p.title).join("; ")}`;
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

    const result = await splitIssue(issue, plan.parts, linear, children);
    if (result.created.length > 0) {
      await linear.comment(issue.id, formatSplitComment(result, plan.source));
    }
    await linear.moveTo(issue.id, "In Progress");
    report.split.push(issue.key);
    log(
      `${issue.key}: split into ${result.parts.map((p) => p.key).join(", ")} and QA ${result.qa.key}`,
    );
  }

  async function splitReady(report: TickReport): Promise<void> {
    const issues = (await linear.listReady(team)).filter(
      (i) => readPartMarker(i.description) === undefined,
    );
    if (issues.length === 0) return;
    const context = await loadContext();
    for (const issue of issues) {
      if (pausedNow) break;
      try {
        await splitOne(issue, context, report);
      } catch (error) {
        log(`${issue.key}: split failed, retrying next tick: ${message(error)}`);
      }
    }
  }

  // --- pause --------------------------------------------------------------

  /** Coordinator runs go through this so a pause can cancel them. */
  function tracked(adapter: HarnessAdapter): HarnessAdapter {
    return {
      id: adapter.id,
      start(task, cwd) {
        const run = adapter.start(task, cwd);
        coordinatorRuns.add(run);
        syncWatch();
        void run.result.finally(() => {
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
    if (fresh.length > 0) {
      const stamp = clock.now().toISOString();
      for (const l of fresh) l.entry.pausedAt = stamp;
      // Marked before the kill, so a crash from here on still keeps the worktrees.
      await save();
      log(`pause: cancelling ${fresh.map((l) => l.key).join(", ")}`);
    }
    const stopping = [...live.values()].filter((l) => l.entry.pausedAt !== undefined);
    await Promise.all(
      stopping.map(async (l) => {
        // A QA round between agent runs has no run: aborting stops its tests and reviews.
        l.abort?.abort();
        await l.run?.cancel();
        await l.done;
      }),
    );
    return fresh.map((l) => l.key);
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
    if (await readPaused()) {
      report.paused = true;
      // Written by the CLI while no daemon was reachable: stop what still runs.
      await pauseRuns();
      return report;
    }
    s.lastPollAt = clock.now().toISOString();
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
      if (merges.paused) {
        report.paused = true;
        await pauseRuns();
        await save();
        return report;
      }
    }
    await dispatchEligible(s, report);
    await splitReady(report);
    await dispatchEligible(s, report);
    await save();
    report.paused = pausedNow;
    return report;
  }

  const safeTick = (): void => {
    loop.tick().catch((error) => log(`tick failed: ${message(error)}`));
  };

  const loop: CoordinatorLoop = {
    tick() {
      ticking ??= pass().finally(() => {
        ticking = undefined;
      });
      return ticking;
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
    resume() {
      pausedNow = false;
      if (timer === undefined) return;
      // A tick already under way may have stopped at the pause check: tick again after it.
      void (ticking ?? Promise.resolve()).catch(() => undefined).then(safeTick);
    },
  };
  return loop;
}
