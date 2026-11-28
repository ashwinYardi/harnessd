import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  type AdapterEvent,
  type DecisionNote,
  emptyTokenUsage,
  type HarnessAdapter,
  type HarnessId,
  type LinkedIssue,
  limitAvailableLine,
  limitHoldLine,
  type MergedConfig,
  type Priority,
  type RunResult,
  type Task,
  type WorkflowStateName,
  weightedTokens,
} from "@harnessd/shared";
import { createClaudeCodeAdapter } from "../adapters/claude-code.ts";
import { mergeLayers } from "../config/merge.ts";
import { createFilePauseStore, createPauseController } from "../control/pause.ts";
import type {
  CreatePrInput,
  GitHub,
  MergeInput,
  PullRequest,
  PullRequestStatus,
  ReviewInput,
} from "../github/client.ts";
import { type CreateSubIssueInput, LinearError, type ListReadyOptions } from "../linear/client.ts";
import { compareQueueOrder, parseLinkedIssue, type RawIssue } from "../linear/parse.ts";
import type { SelfUpdateResult, SelfUpdateTarget } from "../selfupdate/index.ts";
import { createGitWorktrees, type TaskWorktrees, type Worktree } from "../worktrees/index.ts";
import type { HoldEvent } from "./limits.ts";
import {
  type CoordinatorLoopOptions,
  createCoordinatorLoop,
  type LoopLinear,
  type LoopSelfUpdate,
  RESUMED_RUN_NOTE,
  systemClock,
  tokenBudgetFor,
  tokenSumOf,
} from "./loop.ts";
import { formatNotice } from "./notifier.ts";
import { type ReviewFinding, resetReviewNotJudged } from "./review.ts";
import { type ShipInput, type ShipResult, type ShipRun, shipPart } from "./ship.ts";
import { partMarker, readPartMarker } from "./split.ts";
import {
  createFileLoopStore,
  emptyLoopState,
  type LoopState,
  type LoopStore,
  parseLoopState,
} from "./state.ts";

const roots: string[] = [];
after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

// A harness run exports GIT_CONFIG_* that point at that run's own excludes file. The daemon
// itself has no such entries, and these tests make their own repos, so drop them: no test
// may inherit git config from the process that happens to start it. The owner's global
// config (a credential helper or a hook, say) must not decide whether a test git call ends.
for (const key of Object.keys(process.env)) {
  if (key === "GIT_CONFIG_COUNT" || /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(key))
    delete process.env[key];
}
process.env.GIT_TERMINAL_PROMPT = "0";
process.env.GIT_CONFIG_GLOBAL = "/dev/null";

// --- fake Linear -----------------------------------------------------------

interface FakeIssue {
  id: string;
  key: string;
  title: string;
  description: string;
  state: string;
  labels: string[];
  priority: Priority;
  sortOrder?: number;
  parentId?: string;
  createdAt: string;
}

const STATE_TYPES: Record<string, string> = {
  Backlog: "backlog",
  Ready: "unstarted",
  "In Progress": "started",
  "In Review": "started",
  "Needs input": "started",
  Done: "completed",
};

/** In-memory Linear with the LoopLinear surface. Issues go through the real parser. */
class FakeLinear implements LoopLinear {
  issues = new Map<string, FakeIssue>();
  relations: Array<{ blocker: string; blocked: string }> = [];
  comments: Array<{ key: string; body: string }> = [];
  moves: Array<{ key: string; state: WorkflowStateName }> = [];
  created: string[] = [];
  #next = 100;

  add(fields: Partial<FakeIssue> & { title: string }): FakeIssue {
    const n = this.#next++;
    const issue: FakeIssue = {
      id: `id-${n}`,
      key: `MET-${n}`,
      description: "",
      state: "Ready",
      labels: [],
      priority: 3,
      createdAt: new Date(Date.UTC(2026, 10, 1, 0, 0, n)).toISOString(),
      ...fields,
    };
    this.issues.set(issue.id, issue);
    return issue;
  }

  byKey(key: string): FakeIssue {
    const issue = [...this.issues.values()].find((i) => i.key === key);
    assert.ok(issue, `no issue ${key}`);
    return issue;
  }

  children(parent: FakeIssue): FakeIssue[] {
    return [...this.issues.values()].filter((i) => i.parentId === parent.id);
  }

  #get(id: string): FakeIssue {
    const issue = this.issues.get(id);
    assert.ok(issue, `no issue ${id}`);
    return issue;
  }

  raw(issue: FakeIssue): RawIssue {
    const parent = issue.parentId ? this.#get(issue.parentId) : undefined;
    const raw: RawIssue = {
      id: issue.id,
      identifier: issue.key,
      title: issue.title,
      description: issue.description,
      priority: issue.priority,
      url: `https://linear.test/${issue.key}`,
      createdAt: issue.createdAt,
      state: { name: issue.state },
      team: { id: "team-1", key: "MET" },
      labels: { nodes: issue.labels.map((name) => ({ name })) },
      parent: parent ? { id: parent.id, identifier: parent.key } : null,
      inverseRelations: {
        nodes: this.relations
          .filter((r) => r.blocked === issue.id)
          .map((r) => {
            const blocker = this.#get(r.blocker);
            return {
              type: "blocks",
              issue: {
                id: blocker.id,
                identifier: blocker.key,
                state: { name: blocker.state, type: STATE_TYPES[blocker.state] ?? "started" },
              },
            };
          }),
      },
    };
    if (issue.sortOrder !== undefined) raw.sortOrder = issue.sortOrder;
    return raw;
  }

  #linked(issue: FakeIssue): LinkedIssue {
    return parseLinkedIssue(this.raw(issue));
  }

  #ready(): LinkedIssue[] {
    return [...this.issues.values()]
      .filter((i) => i.state === "Ready")
      .sort((a, b) => compareQueueOrder(a, b))
      .map((i) => this.#linked(i));
  }

  async listReady(_options: ListReadyOptions) {
    return this.#ready().filter((i) => i.blockedBy.length === 0);
  }

  async listReadyContaining(_options: ListReadyOptions, text: string) {
    return this.#ready().filter((i) => i.description.includes(text));
  }

  async listChildren(parentId: string) {
    return this.children(this.#get(parentId)).map((i) => this.#linked(i));
  }

  async createSubIssue(parentId: string, input: CreateSubIssueInput) {
    const parent = this.#get(parentId);
    for (const label of input.labels ?? []) assert.ok(parent.labels.includes(label));
    const child = this.add({
      title: input.title,
      description: input.description,
      state: input.state,
      labels: [...(input.labels ?? [])],
      priority: parent.priority,
      parentId,
    });
    this.created.push(child.key);
    return this.#linked(child);
  }

  async createBlocksRelation(blockerId: string, blockedId: string) {
    this.relations.push({ blocker: blockerId, blocked: blockedId });
  }

  async moveTo(issueId: string, state: WorkflowStateName) {
    const issue = this.#get(issueId);
    issue.state = state;
    this.moves.push({ key: issue.key, state });
  }

  async comment(issueId: string, body: string) {
    this.comments.push({ key: this.#get(issueId).key, body });
    return `comment-${this.comments.length}`;
  }

  async getIssue(keyOrId: string) {
    const issue = this.issues.get(keyOrId) ?? this.byKey(keyOrId);
    return this.#linked(issue);
  }

  /** A fake Linear has no pool; the loop's 3-tick reset test replaces this (MET-213). */
  resetConnections(): void {}
}

// --- fake adapter ----------------------------------------------------------

/** One valid fix hint per open finding the decision prompt lists (MET-243). */
function fixDecisionReply(prompt: string): string {
  const ids = [...new Set([...prompt.matchAll(/^- (R\d+) \(/gm)].map((match) => match[1]))];
  return JSON.stringify({
    decision: "fix",
    findings: ids.map((id) => ({ id, hint: `Fix ${id}.` })),
  });
}

interface PendingRun {
  task: Task;
  cwd: string;
  finish(
    status?: RunResult["status"],
    error?: string,
    text?: string,
    resetAt?: string,
    tokens?: RunResult["tokens"],
    turns?: number,
    sessionId?: string,
    reason?: RunResult["reason"],
    usageUnknown?: true,
  ): void;
}

/**
 * Answers grill runs with `grillReply`, plan runs with `plans[key]` (or "not json"), a review
 * decision with one valid fix hint per open finding, and keeps every other run open until the
 * test finishes it.
 */
function fakeAdapter(
  options: {
    grillReply?: string;
    plans?: Record<string, string>;
    /** Replies per plan key, in order; the last one repeats. Overrides `plans`. */
    planReplies?: Record<string, string[]>;
    id?: HarnessId;
    /** Grill and plan runs end with this status instead of `ok`. */
    grillStatus?: RunResult["status"];
    planStatus?: RunResult["status"];
    /** The error and reason of a failed plan run, e.g. a turn cap (D-045). */
    planError?: string;
    planReason?: RunResult["reason"];
    /** True when the fake adapter honors `Task.resumeSessionId` (MET-156). */
    canResume?: boolean;
    /** The coordinator's strict reply to a review decision (MET-243). */
    reviewDecision?: string;
  } = {},
) {
  const tasks: Task[] = [];
  const pending: PendingRun[] = [];
  const adapter: HarnessAdapter = {
    id: options.id ?? "claude-code",
    ...(options.canResume === true ? { canResume: true } : {}),
    start(task, cwd) {
      tasks.push(task);
      const result = (
        status: RunResult["status"],
        text?: string,
        error?: string,
        resetAt?: string,
        tokens?: RunResult["tokens"],
        turns?: number,
        sessionId?: string,
        reason?: RunResult["reason"],
        usageUnknown?: true,
      ): RunResult => {
        const r: RunResult = {
          status,
          exitCode: 0,
          durationMs: 1,
          tokens: tokens ?? emptyTokenUsage(),
        };
        if (text !== undefined) r.finalText = text;
        if (error !== undefined) r.error = error;
        if (resetAt !== undefined) r.resetAt = resetAt;
        if (turns !== undefined) r.turns = turns;
        if (sessionId !== undefined) r.sessionId = sessionId;
        if (reason !== undefined) r.reason = reason;
        if (usageUnknown === true) r.usageUnknown = true;
        return r;
      };
      let resolve: (r: RunResult) => void = () => {};
      let promise: Promise<RunResult>;
      if (task.id.startsWith("grill-")) {
        promise = Promise.resolve(
          result(
            options.grillStatus ?? "ok",
            options.grillReply ?? '{"calls":[],"escalation":null}',
          ),
        );
      } else if (task.id.startsWith("plan-")) {
        const key = task.id.slice("plan-".length).replace(/-retry$/, "");
        const queue = options.planReplies?.[key];
        const text =
          queue === undefined
            ? (options.plans?.[key] ?? "not json")
            : queue.length > 1
              ? (queue.shift() as string)
              : queue[0];
        promise = Promise.resolve(
          result(
            options.planStatus ?? "ok",
            text,
            options.planError,
            undefined,
            undefined,
            undefined,
            undefined,
            options.planReason,
          ),
        );
      } else if (task.id.includes("-review-decision-r")) {
        promise = Promise.resolve(
          result("ok", options.reviewDecision ?? fixDecisionReply(task.prompt)),
        );
      } else {
        promise = new Promise((r) => {
          resolve = r;
        });
        pending.push({
          task,
          cwd,
          finish: (
            status = "ok",
            error,
            text,
            resetAt,
            tokens,
            turns,
            sessionId,
            reason,
            usageUnknown,
          ) =>
            resolve(
              result(status, text, error, resetAt, tokens, turns, sessionId, reason, usageUnknown),
            ),
        });
      }
      // Like a real adapter, each iteration replays the run from the start.
      const events: AsyncIterable<AdapterEvent> = {
        async *[Symbol.asyncIterator]() {
          yield { type: "end", result: await promise };
        },
      };
      const cancel = async () => {
        resolve(result("cancelled", undefined, "cancelled"));
        await promise;
      };
      return { events, result: promise, cancel };
    },
  };
  return { adapter, tasks, pending, runs: () => tasks.filter((t) => /^MET-/.test(t.id)) };
}

function fakeWorktrees() {
  const created: string[] = [];
  const removed: string[] = [];
  const checkouts: Array<{ issueKey: string; title: string; branch: string; sha: string }> = [];
  const worktrees: TaskWorktrees = {
    async create({ issueKey }): Promise<Worktree> {
      created.push(issueKey);
      return { path: `/wt/${issueKey}`, branch: issueKey.toLowerCase(), resumed: false };
    },
    async checkout(input): Promise<Worktree> {
      checkouts.push(input);
      return { path: `/wt/${input.issueKey}-${input.sha}`, branch: input.branch, resumed: false };
    },
    async remove(path) {
      removed.push(path);
      return { removed: true };
    },
    async recover() {},
  };
  return { worktrees, created, removed, checkouts };
}

function fakeGitHub() {
  const prs: Record<string, PullRequest> = {};
  const reviews: Array<ReviewInput & { number: number }> = [];
  /** What `gh pr view` reports per PR number; the default is open, green and unprotected. */
  const statuses: Record<number, Partial<PullRequestStatus>> = {};
  const merges: Array<{ number: number } & MergeInput> = [];
  const labels: Array<{ number: number; label: string }> = [];
  const views: number[] = [];
  const createdPrs: CreatePrInput[] = [];
  let nextPr = 100;
  const github: GitHub = {
    async defaultBranch() {
      return "main";
    },
    async findPrByHead(branch) {
      return Object.values(prs).find((pr) => pr.headRefName === branch);
    },
    async findPrForIssue(key) {
      return prs[key];
    },
    async createPr(input) {
      createdPrs.push(input);
      const n = nextPr++;
      const url = `https://github.test/o/r/pull/${n}`;
      const key = input.title.split(":")[0] ?? input.head;
      prs[key] = {
        number: n,
        title: input.title,
        url,
        headRefName: input.head,
        headRefOid: `sha${n}`,
        baseRefName: input.base,
        isDraft: false,
      };
      return url;
    },
    async prFiles() {
      return [{ path: "src/x.ts", additions: 3, deletions: 1 }];
    },
    async prDiff() {
      return "diff --git a/src/x.ts b/src/x.ts\n+const x = 1;";
    },
    async postReview(number, review) {
      reviews.push({ number, ...review });
      return `https://github.test/o/r/pull/${number}#review-${reviews.length}`;
    },
    async prStatus(number) {
      views.push(number);
      const files = statuses[number]?.files ?? [{ path: "src/x.ts", additions: 3, deletions: 1 }];
      return {
        number,
        url: `https://github.test/o/r/pull/${number}`,
        state: "OPEN",
        headRefOid: `sha${number}`,
        mergeable: "MERGEABLE",
        checks: [{ name: "CI / test", state: "pass", detail: "SUCCESS" }],
        files,
        changedFiles: files.length,
        ...statuses[number],
      };
    },
    async mergePr(number, input) {
      merges.push({ number, ...input });
      statuses[number] = { ...statuses[number], state: "MERGED" };
    },
    async addLabel(number, label) {
      labels.push({ number, label });
    },
  };
  const open = (key: string, number: number, branch = key.toLowerCase()): PullRequest => {
    const pr: PullRequest = {
      number,
      title: `${key}: work`,
      url: `https://github.test/o/r/pull/${number}`,
      headRefName: branch,
      headRefOid: `sha${number}`,
      baseRefName: "main",
      isDraft: false,
    };
    prs[key] = pr;
    return pr;
  };
  return { github, prs, reviews, statuses, merges, labels, views, open, createdPrs };
}

function memoryStore(initial: LoopState = emptyLoopState()): LoopStore & { state: LoopState } {
  const store = {
    state: structuredClone(initial),
    async load() {
      return structuredClone(store.state);
    },
    async save(next: LoopState) {
      store.state = structuredClone(next);
    },
  };
  return store;
}

/** One part in the fixed brief shape the plan check accepts (MET-160). */
function briefPart(role: string, size: string, title: string, doneWhen: number[]) {
  return {
    role,
    size,
    title,
    goal: `${title}.`,
    doneWhen,
    files: [`src/${role}.ts`],
    steps: [`Do ${title}.`],
    verify: [{ run: "pnpm test", expect: "passes" }],
    outOfScope: "The other parts.",
  };
}

function plan(...parts: Array<[string, string, string]>): string {
  return JSON.stringify({
    parts: parts.map(([role, size, title], i) =>
      briefPart(role, size, title, parts.length === 1 ? [1, 2] : [i === 0 ? 1 : 2]),
    ),
    reason: "The work does not fit one M part.",
  });
}

/** A plan with no reason: invalid, so the loop must retry once and then ask a human. */
function planWithoutReason(...parts: Array<[string, string, string]>): string {
  return JSON.stringify({
    parts: parts.map(([role, size, title], i) => briefPart(role, size, title, [i + 1])),
  });
}

const BODY = (size: string) =>
  `**Why**\nThe loop needs it.\n\n**Done when**\n- [ ] Works\n- [ ] Has tests\n\n**Size**: ${size}`;

function setup(
  options: {
    config?: MergedConfig;
    adapter?: ReturnType<typeof fakeAdapter>;
    store?: LoopStore;
    worktrees?: TaskWorktrees;
    linear?: FakeLinear;
    extra?: Partial<CoordinatorLoopOptions>;
  } = {},
) {
  resetReviewNotJudged();
  const linear = options.linear ?? new FakeLinear();
  const adapter = options.adapter ?? fakeAdapter();
  const wt = fakeWorktrees();
  const gh = fakeGitHub();
  const commands: Array<{ command: string; cwd: string }> = [];
  const memory = memoryStore();
  const store = options.store ?? memory;
  const notes: DecisionNote[] = [];
  const pings: string[] = [];
  const logs: string[] = [];
  // Most loop tests predate the serial default (D-040) and exercise several runs at once.
  // They set max_concurrent explicitly; the default itself is tested on mergeLayers([]).
  const config =
    options.config ??
    mergeLayers([
      {
        scope: "workspace",
        dir: "/repo/.harnessd",
        settings: { limits: { max_concurrent: 3 } },
        agents: {},
        rules: [],
        skills: [],
        mcp: {},
        skillSettings: {},
      },
    ]);
  const loop = createCoordinatorLoop({
    config,
    linear,
    adapters: { [adapter.adapter.id]: adapter.adapter },
    worktrees: options.worktrees ?? wt.worktrees,
    github: gh.github,
    runCommand: async (command, cwd) => {
      commands.push({ command, cwd });
      return { exitCode: 0, timedOut: false, output: "all green" };
    },
    store,
    repoDir: "/repo",
    team: { teamId: "MET" },
    context: async () => ({ spec: "SPEC", decisions: [] }),
    decisions: {
      async write(note) {
        notes.push(note);
        return note.title;
      },
    },
    notifier: {
      async notify(notice) {
        pings.push(formatNotice(notice));
      },
    },
    log: (line) => logs.push(line),
    pid: 4242,
    // Existing loop tests use fake worktree paths: the real ship step needs a real repo.
    // The ship tests below pass `shipPart` and a temp git repo with a bare remote.
    ship:
      options.extra?.ship ??
      (async () => ({
        ok: true as const,
        committed: false,
        prUrl: "https://github.test/o/r/pull/1",
        created: false,
      })),
    ...options.extra,
  });
  return { loop, linear, adapter, wt, gh, commands, memory, notes, pings, logs };
}

/** The issue keys the loop grilled, in order, from `grill-MET-100-1` task ids. */
function grilled(t: ReturnType<typeof setup>): string[] {
  return t.adapter.tasks
    .filter((task) => task.id.startsWith("grill-"))
    .map((task) => task.id.slice("grill-".length).replace(/-\d+$/, ""));
}

/** Lets every pending promise chain run (the fakes do no I/O). */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Waits until the fake adapter has started `count` runs. Under load, one `settle()` can be
 * too early; finishing a run that does not exist yet would leave `loop.idle()` pending.
 */
async function nextRun(adapter: ReturnType<typeof fakeAdapter>, count = 1): Promise<PendingRun> {
  for (let i = 0; i < 1000; i++) {
    const run = adapter.pending[count - 1];
    if (run !== undefined) return run;
    await settle();
  }
  throw new Error(`the adapter did not start run ${count}`);
}

function roleOf(issue: FakeIssue): string | undefined {
  return readPartMarker(issue.description)?.id;
}

// --- tests -----------------------------------------------------------------

test("a Ready issue splits into backend and frontend parts plus a QA part they block", async () => {
  const adapter = fakeAdapter({
    plans: { "MET-100": plan(["backend", "S", "API for avatars"], ["frontend", "M", "Avatar UI"]) },
  });
  const t = setup({ adapter });
  const parent = t.linear.add({ title: "Agents show avatars", labels: ["coordinator", "p1"] });
  parent.description = BODY("M");

  const report = await t.loop.tick();

  const children = t.linear.children(parent);
  assert.deepEqual(children.map(roleOf), ["backend", "frontend", "qa"]);
  const [backend, frontend, qa] = children as [FakeIssue, FakeIssue, FakeIssue];
  assert.equal(backend.title, "API for avatars");
  assert.equal(qa.title, "QA: Agents show avatars");
  for (const child of children) {
    assert.deepEqual(child.labels, ["coordinator"], "only the area label is copied");
    assert.match(child.description, /\*\*Why\*\*\n/);
    assert.match(child.description, /\*\*Done when\*\*\n- \[ \] /);
  }
  assert.match(backend.description, /- \[ \] Works/);
  assert.match(frontend.description, /- \[ \] Has tests/);
  assert.match(backend.description, /\*\*Why\*\*\nThe loop needs it\./);
  assert.match(qa.description, /- \[ \] Works \(verified\)/);
  assert.match(backend.description, /\*\*Size\*\*: S/);
  assert.match(frontend.description, /\*\*Size\*\*: M/);
  assert.deepEqual(t.linear.relations, [
    { blocker: backend.id, blocked: qa.id },
    { blocker: frontend.id, blocked: qa.id },
    { blocker: backend.id, blocked: frontend.id },
  ]);
  assert.equal(parent.state, "In Progress");
  assert.equal(report.split[0], parent.key);
  const splitComment = t.linear.comments.find((c) => c.body.startsWith("**Coordinator split**"));
  assert.match(splitComment?.body ?? "", new RegExp(`${qa.key} qa \\(M\\): blocked by`));
  assert.match(splitComment?.body ?? "", /Reason: The work does not fit/);

  // The grill ran first and its comment came before the split comment.
  assert.ok(t.adapter.tasks[0]?.id.startsWith("grill-"));
  assert.ok(t.adapter.tasks[1]?.id.startsWith("plan-"));
  assert.ok(t.linear.comments[0]?.body.startsWith("**Coordinator grill**"));
  assert.ok(
    !t.logs.some((line) => line.includes("old parts not reused")),
    "no old-parts line when the parent had no marked children",
  );

  // Serial parts: only part 1 runs; part 2 waits until part 1 is merged.
  assert.deepEqual(report.dispatched, [backend.key]);
  const runs = t.adapter.runs();
  assert.deepEqual(
    runs.map((r) => [r.id, r.budgetMs]),
    [[`${backend.key}-1`, 30 * 60_000]],
  );
  assert.match(runs[0]?.prompt ?? "", /You are backend, the harnessd backend agent\./);
  assert.match(runs[0]?.prompt ?? "", /Do not run `git commit`, `git push` or `gh pr create`/);
  assert.equal(t.adapter.pending[0]?.cwd, `/wt/${backend.key}`);
  assert.equal(backend.state, "In Progress");
  assert.equal(qa.state, "Ready");
  assert.deepEqual(t.loop.running(), [backend.key]);
  assert.equal(t.memory.state.inFlight.length, 1);
});

test("grill and plan runs are read-only; part and QA runs are not (D-059)", async () => {
  const adapter = fakeAdapter({ plans: { "MET-100": plan(["backend", "S", "API"]) } });
  const t = setup({ adapter });
  const parent = t.linear.add({ title: "P", labels: ["coordinator"], description: BODY("S") });

  await t.loop.tick();
  const children = t.linear.children(parent);
  const backend = children.find((child) => roleOf(child) === "backend");
  const qa = children.find((child) => roleOf(child) === "qa");
  assert.ok(backend, "the split made a backend part");
  assert.ok(qa, "the split made a QA part");

  const [grill, planRun, partRun] = adapter.tasks;
  assert.match(grill?.id ?? "", /^grill-/);
  assert.equal(grill?.readOnly, true, "a grill run is read-only");
  assert.match(planRun?.id ?? "", /^plan-/);
  assert.equal(planRun?.readOnly, true, "a plan run is read-only");
  assert.equal(partRun?.id, `${backend.key}-1`);
  assert.notEqual(partRun?.readOnly, true, "a builder keeps full access");

  // The part reaches In Review, so the reviewer runs before QA (MET-224, MET-226). Neither
  // is a coordinator run. The reviewer is read-only; QA keeps full access.
  adapter.pending[0]?.finish("ok");
  await t.loop.idle();
  t.gh.open(backend.key, 7);
  assert.deepEqual((await t.loop.tick()).dispatched, [backend.key], "the review starts before QA");
  const reviewRun = adapter.tasks.find((task) => task.role === "reviewer");
  assert.equal(reviewRun?.readOnly, true, "the reviewer is read-only");
  adapter.pending
    .find((pending) => pending.task.role === "reviewer")
    ?.finish("ok", undefined, JSON.stringify({ decision: "approve", findings: [] }));
  await t.loop.idle();
  assert.deepEqual(
    (await t.loop.tick()).dispatched,
    [qa.key],
    "QA starts only after the review approves the head",
  );
  const qaRun = adapter.tasks.at(-1);
  assert.match(qaRun?.id ?? "", /-qa-1-pr7$/);
  assert.notEqual(qaRun?.readOnly, true, "QA keeps full access");
  assert.equal(
    adapter.tasks.filter((task) => /^(grill|plan)-/.test(task.id)).length,
    2,
    "no coordinator run starts for a part or QA round",
  );

  adapter.pending
    .find((pending) => pending.task.id.endsWith("-qa-1-pr7"))
    ?.finish("ok", undefined, verdict(true, true));
  await t.loop.idle();
});

test("a backend-only issue gets no frontend part", async () => {
  const adapter = fakeAdapter({ plans: { "MET-100": plan(["backend", "S", "Only API"]) } });
  const t = setup({ adapter });
  const parent = t.linear.add({
    title: "Daemon health",
    labels: ["infra"],
    description: BODY("S"),
  });

  await t.loop.tick();

  assert.deepEqual(t.linear.children(parent).map(roleOf), ["backend", "qa"]);
  assert.equal(t.linear.relations.length, 1);
  assert.match(t.linear.byKey("MET-102").description, /\*\*Size\*\*: S/, "QA of an S issue is S");
});

test("an unusable plan runs once more, then moves the issue to Needs input", async () => {
  // Two parents in flight, so both grill on the same tick (MET-174).
  const config = mergeLayers([
    {
      scope: "workspace",
      dir: "/repo/.harnessd",
      settings: { limits: { max_concurrent: 3, max_parents: 2 } },
      agents: {},
      rules: [],
      skills: [],
      mcp: {},
      skillSettings: {},
    },
  ]);
  const t = setup({ config });
  const ui = t.linear.add({ title: "Board shows agents", labels: ["ui"], description: BODY("S") });
  const api = t.linear.add({ title: "Board API", labels: ["infra"], description: BODY("M") });

  const report = await t.loop.tick();

  assert.deepEqual(report.escalated.sort(), [ui.key, api.key].sort());
  for (const issue of [ui, api]) {
    assert.equal(issue.state, "Needs input");
    assert.deepEqual(t.linear.children(issue), [], "no fallback part and no QA part");
    const comment = t.linear.comments.find((c) => c.key === issue.key && c.body.includes("split"));
    assert.match(comment?.body ?? "", /rejected twice/);
    assert.match(comment?.body ?? "", /- not JSON/);
  }
  assert.equal(
    t.adapter.tasks.filter((task) => task.id.startsWith("plan-")).length,
    4,
    "one retry per issue",
  );
  assert.ok(
    t.adapter.tasks.some((task) => /## Errors in your previous plan/.test(task.prompt)),
    "the retry prompt lists the errors",
  );
  assert.equal(t.pings.length, 2, "one notice per issue");
});

test("a bad plan retries once with the errors, then splits", async () => {
  const adapter = fakeAdapter({
    planReplies: {
      "MET-100": ['{"parts":[]}', plan(["backend", "S", "API"], ["frontend", "S", "UI"])],
    },
  });
  const t = setup({ adapter });
  const parent = t.linear.add({ title: "Feature", labels: ["ui"], description: BODY("M") });

  const report = await t.loop.tick();

  assert.deepEqual(report.split, [parent.key]);
  assert.deepEqual(t.linear.children(parent).map(roleOf), ["backend", "frontend", "qa"]);
  const plans = t.adapter.tasks.filter((task) => task.id.startsWith("plan-"));
  assert.equal(plans.length, 2, "the plan ran twice");
  assert.doesNotMatch(plans[0]?.prompt ?? "", /Errors in your previous plan/);
  assert.match(plans[1]?.prompt ?? "", /## Errors in your previous plan/);
  assert.match(plans[1]?.prompt ?? "", /- parts: expected at least one part/);
  assert.equal(t.pings.length, 0, "no human needed");
});

test("a turn-capped plan run counts as a bad plan and stays on the same harness", async () => {
  const adapter = fakeAdapter({
    planStatus: "error",
    planError: "turn cap (50 turns)",
    planReason: "turn_cap",
  });
  const t = setup({ adapter });
  const parent = t.linear.add({ title: "Feature", labels: ["ui"], description: BODY("M") });

  await t.loop.tick();

  const plans = t.adapter.tasks.filter((task) => task.id.startsWith("plan-"));
  assert.equal(plans.length, 2, "one retry");
  assert.match(plans[1]?.prompt ?? "", /- turn cap \(50 turns\)/);
  assert.equal(parent.state, "Needs input");
  assert.match(
    t.linear.comments.find((c) => c.key === parent.key && /split/.test(c.body))?.body ?? "",
    /- turn cap \(50 turns\)/,
  );
  assert.equal(t.pings.length, 1);
  assert.equal(t.memory.state.harnessSwitch?.[parent.id], undefined, "no switch on a turn cap");
});

test("a re-tick creates nothing new, and an interrupted split is finished without a re-grill", async () => {
  const adapter = fakeAdapter({
    plans: { "MET-100": plan(["backend", "S", "API"], ["frontend", "S", "UI"]) },
  });
  const t = setup({ adapter });
  const parent = t.linear.add({ title: "Feature", labels: ["ui"], description: BODY("M") });

  await t.loop.tick();
  const created = [...t.linear.created];
  const relations = t.linear.relations.length;
  const comments = t.linear.comments.length;

  await t.loop.tick();
  assert.deepEqual(t.linear.created, created);
  assert.equal(t.linear.relations.length, relations);
  assert.equal(t.linear.comments.length, comments);

  // As if the daemon died after creating the parts but before moving the parent and
  // relating QA: the parent is Ready again and the QA relations are gone.
  parent.state = "Ready";
  t.linear.relations = t.linear.relations.slice(0, 1);
  const coordinatorTasks = t.adapter.tasks.filter((task) => /^(grill|plan)-/.test(task.id)).length;
  const report = await t.loop.tick();
  assert.deepEqual(report.split, [parent.key]);
  assert.deepEqual(t.linear.created, created, "no duplicate sub-issues");
  assert.equal(t.linear.relations.length, 3, "the missing relations are added back");
  assert.equal(
    t.adapter.tasks.filter((task) => /^(grill|plan)-/.test(task.id)).length,
    coordinatorTasks,
    "no second grill or plan",
  );
  assert.equal(t.linear.comments.length, comments, "nothing new to report");
  assert.equal(parent.state, "In Progress");
});

test("a stale Linear read after a split skips the parent instead of grilling it again", async () => {
  const adapter = fakeAdapter({
    plans: { "MET-100": plan(["backend", "S", "API"]) },
  });
  const t = setup({ adapter });
  const parent = t.linear.add({ title: "Feature", labels: ["ui"], description: BODY("S") });

  await t.loop.tick();
  const record = t.memory.state.splits?.[parent.id];
  assert.ok(record, "the split is recorded in loop.json");
  const tasks = t.adapter.tasks.length;
  const created = [...t.linear.created];

  // Linear lags a few seconds: the parent still looks Ready with no children.
  parent.state = "Ready";
  const children = t.linear.listChildren.bind(t.linear);
  t.linear.listChildren = async (id: string) => (id === parent.id ? [] : children(id));

  const report = await t.loop.tick();
  assert.deepEqual(report.split, [], "the parent is not split again");
  assert.equal(t.adapter.tasks.length, tasks, "no second grill or plan");
  assert.deepEqual(t.linear.created, created, "no duplicate sub-issues");
  assert.ok(
    t.logs.includes(`${parent.key}: already split at ${record.at}, Linear read is stale; skipped`),
    "the stale read is logged",
  );
});

test("a part that appears in the children read after the grill is reused, not created again", async () => {
  const adapter = fakeAdapter({
    plans: { "MET-100": plan(["backend", "S", "API"]) },
  });
  const t = setup({ adapter });
  const parent = t.linear.add({ title: "Feature", labels: ["ui"], description: BODY("S") });
  const late = t.linear.add({
    title: "API",
    state: "Backlog",
    parentId: parent.id,
    description: partMarker("backend"),
  });
  // The first read is stale and misses the part; the read after grill and plan sees it.
  const reads: number[] = [];
  const children = t.linear.listChildren.bind(t.linear);
  t.linear.listChildren = async (id: string) => {
    if (id !== parent.id) return children(id);
    const list = reads.length === 0 ? [] : await children(id);
    reads.push(list.length);
    return list;
  };

  await t.loop.tick();

  assert.deepEqual(reads.slice(0, 2), [0, 1], "the children are read again before the create");
  assert.deepEqual(
    t.linear
      .children(parent)
      .filter((c) => roleOf(c) === "backend")
      .map((c) => c.id),
    [late.id],
    "the late part is reused",
  );
  assert.equal(t.linear.created.includes(late.key), false, "the late part is not created again");
  assert.equal(t.linear.children(parent).filter((c) => roleOf(c) === "qa").length, 1);
  assert.equal(parent.state, "In Progress");
});

test("a parent whose recorded parts are all canceled is grilled again", async () => {
  const adapter = fakeAdapter({
    plans: { "MET-100": plan(["backend", "S", "API"]) },
  });
  const t = setup({ adapter });
  const parent = t.linear.add({ title: "Feature", labels: ["ui"], description: BODY("S") });

  await t.loop.tick();
  const recorded = t.memory.state.splits?.[parent.id];
  assert.ok(recorded);
  const grills = t.adapter.tasks.filter((task) => task.id.startsWith("grill-")).length;

  // The owner canceled every part and moved the parent back to Ready on purpose.
  parent.state = "Ready";
  for (const child of t.linear.children(parent)) {
    if (roleOf(child) !== "qa") child.state = "Canceled";
  }

  await t.loop.tick();

  assert.equal(
    t.adapter.tasks.filter((task) => task.id.startsWith("grill-")).length,
    grills + 1,
    "the grill runs again",
  );
  const next = t.memory.state.splits?.[parent.id];
  assert.ok(next, "the new split is recorded");
  assert.ok(
    next.parts.every((id) => !recorded.parts.includes(id)),
    "the canceled parts are gone from the record",
  );
  assert.notEqual(next.qa, recorded.qa, "the old QA child is not reused");
  assert.equal(parent.state, "In Progress");
});

test("a parent whose recorded parts are all Done or Canceled is grilled again and names them", async () => {
  const adapter = fakeAdapter({
    plans: { "MET-100": plan(["backend", "S", "API"], ["frontend", "S", "UI"]) },
  });
  const t = setup({ adapter });
  const parent = t.linear.add({ title: "Feature", labels: ["ui"], description: BODY("M") });

  await t.loop.tick();
  const recorded = t.memory.state.splits?.[parent.id];
  assert.ok(recorded);
  const oldChildren = t.linear.children(parent);
  const oldBackend = oldChildren.find((child) => roleOf(child) === "backend");
  const oldFrontend = oldChildren.find((child) => roleOf(child) === "frontend");
  const oldQa = oldChildren.find((child) => roleOf(child) === "qa");
  assert.ok(oldBackend && oldFrontend && oldQa);
  const grills = grilled(t).length;

  // One recorded part is Done, the other Canceled: no recorded work part is live.
  parent.state = "Ready";
  oldBackend.state = "Done";
  oldFrontend.state = "Canceled";

  await t.loop.tick();

  assert.equal(grilled(t).length, grills + 1, "the grill runs again");
  const oldLine = `${parent.key}: old parts not reused: ${oldBackend.key}, ${oldFrontend.key}, ${oldQa.key}`;
  assert.deepEqual(
    t.logs.filter((line) => line === oldLine),
    [oldLine],
    "one line names the old children in Linear order, QA included",
  );
  const next = t.memory.state.splits?.[parent.id];
  assert.ok(next, "the new split is recorded");
  assert.ok(
    next.parts.every((id) => !recorded.parts.includes(id)),
    "the Done and Canceled parts are not reused",
  );
  assert.notEqual(next.qa, recorded.qa, "the old QA child is not reused");
  assert.equal(oldBackend.state, "Done", "the old part is left alone");
  assert.equal(oldFrontend.state, "Canceled", "the old part is left alone");
  assert.equal(parent.state, "In Progress");
});

test("an interrupted split reuses its live recorded parts and adds the missing QA and serial relations (MET-216)", async () => {
  const adapter = fakeAdapter({
    plans: { "MET-100": plan(["backend", "S", "API"], ["frontend", "S", "UI"]) },
  });
  const t = setup({ adapter });
  const parent = t.linear.add({ title: "Feature", labels: ["ui"], description: BODY("M") });

  await t.loop.tick();
  const record = t.memory.state.splits?.[parent.id];
  assert.ok(record, "the split is recorded");
  const created = [...t.linear.created];
  const grills = grilled(t).length;
  const parts = record.parts.map((id) => t.linear.issues.get(id));
  const qa = t.linear.issues.get(record.qa);
  assert.ok(parts[0] && parts[1] && qa);

  // As if the process stopped after creating the sub-issues: the parent is Ready again and
  // the QA and serial relations are missing.
  parent.state = "Ready";
  t.linear.relations = [];

  const report = await t.loop.tick();

  assert.deepEqual(report.split, [parent.key]);
  assert.equal(grilled(t).length, grills, "there is no second grill");
  assert.deepEqual(t.linear.created, created, "no duplicate sub-issue is created");
  assert.deepEqual(
    record.parts.map((id) => t.linear.issues.get(id)?.id),
    parts.map((part) => part?.id),
    "the live recorded parts are reused",
  );
  assert.deepEqual(
    t.linear.relations.map((r) => [r.blocker, r.blocked]),
    [
      [parts[0].id, qa.id],
      [parts[1].id, qa.id],
      [parts[0].id, parts[1].id],
    ],
    "the missing QA and serial relations are added",
  );
  assert.equal(parent.state, "In Progress");
});

test("a split without a record does not reuse live children of an older plan (MET-216)", async () => {
  const adapter = fakeAdapter({
    plans: { "MET-100": plan(["backend", "S", "API"], ["frontend", "S", "UI"]) },
  });
  const t = setup({ adapter });
  const parent = t.linear.add({ title: "Feature", labels: ["ui"], description: BODY("M") });
  const oldBackend = t.linear.add({
    title: "Old API",
    state: "Backlog",
    parentId: parent.id,
    description: partMarker("backend"),
  });
  const oldQa = t.linear.add({
    title: "Old QA",
    state: "Backlog",
    parentId: parent.id,
    description: partMarker("qa"),
  });

  const report = await t.loop.tick();

  assert.deepEqual(report.split, [parent.key], "the parent is grilled and split");
  assert.ok(
    t.logs.includes(`${parent.key}: old parts not reused: ${oldBackend.key}, ${oldQa.key}`),
    "one line names the old children before the grill, QA included",
  );
  const record = t.memory.state.splits?.[parent.id];
  assert.ok(record, "the new split is recorded");
  assert.ok(!record.parts.includes(oldBackend.id), "the old backend part is not reused");
  assert.notEqual(record.qa, oldQa.id, "the old QA child is not reused");
  assert.equal(oldBackend.state, "Backlog", "the old part is left alone");
  assert.equal(oldQa.state, "Backlog", "the old QA is left alone");
  assert.ok(
    t.linear.relations.every(
      (r) =>
        ![oldBackend.id, oldQa.id].includes(r.blocker) &&
        ![oldBackend.id, oldQa.id].includes(r.blocked),
    ),
    "no relation touches an old child",
  );

  // The owner moves the old part to Ready. The record does not list it, so dispatch leaves it
  // alone: no move and no comment (MET-217).
  oldBackend.state = "Ready";
  const moves = t.linear.moves.length;
  const comments = t.linear.comments.length;
  const dispatched = (await t.loop.tick()).dispatched;
  assert.ok(!dispatched.includes(oldBackend.key), "the old Ready child is not dispatched");
  assert.equal(oldBackend.state, "Ready", "the old child keeps its place");
  assert.equal(t.linear.moves.length, moves, "the old child is not moved");
  assert.equal(t.linear.comments.length, comments, "the old child gets no comment");
});

test("a re-split keeps the record's first at and stays admitted ahead of a later parent", async () => {
  const time = manualClock("2026-11-26T10:00:00.000Z");
  const config = mergeLayers([
    {
      scope: "workspace",
      dir: "/repo/.harnessd",
      settings: { limits: { max_concurrent: 3, max_parents: 1 } },
      agents: {},
      rules: [],
      skills: [],
      mcp: {},
      skillSettings: {},
    },
  ]);
  const linear = new FakeLinear();
  const a = linear.add({ title: "A", labels: ["ui"], description: BODY("S") });
  const b = linear.add({ title: "B", state: "In Progress" });
  const bPart = linear.add({
    title: "B part",
    state: "Backlog",
    parentId: b.id,
    description: `${partMarker("backend")}\n**Size**: S`,
  });
  const adapter = fakeAdapter({
    plans: { [a.key]: plan(["backend", "S", "A API"], ["frontend", "S", "A UI"]) },
  });
  // The loop loads its state once. This store hands back the loaded object, so the test can
  // add the later parent's split record between ticks, as a restart would have loaded it.
  const state = emptyLoopState();
  const store: LoopStore = {
    async load() {
      return state;
    },
    async save() {},
  };
  const t = setup({ config, linear, adapter, store, extra: { clock: time.clock } });

  await t.loop.tick();
  const first = state.splits?.[a.id];
  assert.ok(first, "A's split is recorded at the first time");
  t.adapter.pending[0]?.finish("ok");
  await t.loop.idle();
  const children = t.linear.children(a);
  const backend = children.find((child) => roleOf(child) === "backend");
  const frontend = children.find((child) => roleOf(child) === "frontend");
  const qa = children.find((child) => roleOf(child) === "qa");
  assert.ok(backend && frontend && qa);
  // The backend part is still live; only the frontend part was canceled.
  backend.state = "In Progress";

  // The owner cancels one part and escalates A. B is a later parent already in flight.
  frontend.state = "Canceled";
  a.state = "Needs input";
  state.splits ??= {};
  state.splits[b.id] = {
    key: b.key,
    parts: [bPart.id],
    qa: "qa-b",
    at: time.at(10_000),
  };
  bPart.state = "Ready";

  time.advance(60_000);
  a.state = "Ready";
  const report = await t.loop.tick();

  const next = state.splits?.[a.id];
  assert.ok(next, "A keeps its split record");
  assert.equal(next.at, first.at, "the re-split keeps the record's first at time");
  assert.deepEqual(next.parts, [backend.id], "the record takes the new split's live parts");
  assert.equal(next.qa, qa.id, "the record takes the new split's QA");
  assert.deepEqual(report.dispatched, [], "A holds the only slot, so B's part does not start");
  assert.equal(bPart.state, "Ready", "B's part waits while A stays admitted ahead of B");
});

test("a re-split after every part was canceled deletes the record and writes a fresh at", async () => {
  const time = manualClock("2026-11-26T11:00:00.000Z");
  const linear = new FakeLinear();
  const parent = linear.add({ title: "Feature", labels: ["ui"], description: BODY("S") });
  const adapter = fakeAdapter({
    plans: { [parent.key]: plan(["backend", "S", "API"]) },
  });
  const t = setup({ linear, adapter, extra: { clock: time.clock } });

  await t.loop.tick();
  const first = t.memory.state.splits?.[parent.id];
  assert.ok(first, "the first split is recorded");
  t.adapter.pending[0]?.finish("ok");
  await t.loop.idle();

  // The owner canceled every part and moved the parent back to Ready on purpose.
  for (const child of t.linear.children(parent)) {
    if (roleOf(child) !== "qa") child.state = "Canceled";
  }
  time.advance(60_000);
  parent.state = "Ready";

  await t.loop.tick();

  const next = t.memory.state.splits?.[parent.id];
  assert.ok(next, "the regrill records a new split");
  assert.notDeepEqual(next.parts, first.parts, "the canceled parts are replaced");
  assert.notEqual(next.at, first.at, "the regrill does not keep the old at time");
  assert.equal(next.at, time.at(0), "the new record gets the current time");
});

test("the sweep drops a split record when the parent is Done", async () => {
  const adapter = fakeAdapter({
    plans: { "MET-100": plan(["backend", "S", "API"]) },
  });
  const t = setup({ adapter });
  const parent = t.linear.add({ title: "Feature", labels: ["ui"], description: BODY("S") });

  await t.loop.tick();
  assert.ok(t.memory.state.splits?.[parent.id]);

  parent.state = "Done";
  await t.loop.tick();

  assert.equal(t.memory.state.splits?.[parent.id], undefined, "the record is dropped");
});

test("two Ready parents give one grill with the default max_parents", async () => {
  const adapter = fakeAdapter({
    plans: {
      "MET-100": plan(["backend", "S", "API"]),
      "MET-101": plan(["backend", "S", "API too"]),
    },
  });
  const t = setup({ adapter });
  const first = t.linear.add({ title: "First", labels: ["ui"], description: BODY("S") });
  const second = t.linear.add({ title: "Second", labels: ["ui"], description: BODY("S") });

  const report = await t.loop.tick();

  assert.deepEqual(report.split, [first.key]);
  assert.deepEqual(grilled(t), [first.key], "only one grill");
  assert.equal(first.state, "In Progress");
  assert.equal(second.state, "Ready", "the other parent stays Ready");
  assert.deepEqual(t.linear.children(second), [], "and is not split");
});

test("the second parent grills after the first is Done and repairSplits drops its record", async () => {
  const adapter = fakeAdapter({
    plans: {
      "MET-100": plan(["backend", "S", "API"]),
      "MET-101": plan(["backend", "S", "API too"]),
    },
  });
  const t = setup({ adapter });
  const first = t.linear.add({ title: "First", labels: ["ui"], description: BODY("S") });
  const second = t.linear.add({ title: "Second", labels: ["ui"], description: BODY("S") });
  await t.loop.tick();
  assert.deepEqual(grilled(t), [first.key]);

  first.state = "Done";
  const report = await t.loop.tick();

  assert.equal(t.memory.state.splits?.[first.id], undefined, "the Done parent's record is gone");
  assert.deepEqual(report.split, [second.key]);
  assert.deepEqual(grilled(t), [first.key, second.key], "the second parent grills now");
  assert.equal(second.state, "In Progress");
});

test("the first split note warns once that QA runs no live app (MET-180)", async () => {
  const adapter = fakeAdapter({
    plans: {
      "MET-100": plan(["backend", "S", "API"]),
      "MET-101": plan(["backend", "S", "API too"]),
    },
  });
  const t = setup({ adapter });
  const first = t.linear.add({ title: "First", labels: ["ui"], description: BODY("S") });
  const second = t.linear.add({ title: "Second", labels: ["ui"], description: BODY("S") });

  await t.loop.tick();

  const note = (key: string) =>
    t.linear.comments.find((c) => c.key === key && c.body.startsWith("**Coordinator split**"))
      ?.body;
  assert.match(
    note(first.key) ?? "",
    /QA runs no live app: \.harnessd\/config\.toml has no \[qa\] kind \(docs\/CONFIG\.md\)\.\nReason:/,
  );
  assert.equal(typeof t.memory.state.qaLiveWarned, "string", "the warning time is recorded");

  first.state = "Done";
  await t.loop.tick();

  assert.ok(note(second.key), "the second parent splits");
  assert.doesNotMatch(note(second.key) ?? "", /QA runs no live app/, "the warning went out once");
  assert.match(note(second.key) ?? "", /Reason:/);
});

test("Linear's manual order wins over creation order", async () => {
  const adapter = fakeAdapter({
    plans: {
      "MET-100": plan(["backend", "S", "API"]),
      "MET-101": plan(["backend", "S", "API too"]),
    },
  });
  const t = setup({ adapter });
  const older = t.linear.add({
    title: "Older",
    labels: ["ui"],
    description: BODY("S"),
    sortOrder: 2,
  });
  const newer = t.linear.add({
    title: "Newer",
    labels: ["ui"],
    description: BODY("S"),
    sortOrder: 1,
  });

  const report = await t.loop.tick();

  assert.deepEqual(report.split, [newer.key]);
  assert.deepEqual(grilled(t), [newer.key], "the newer issue with the lower sortOrder is first");
  assert.equal(older.state, "Ready", "the older issue waits");
});

test("an equal sortOrder falls back to priority", async () => {
  const adapter = fakeAdapter({
    plans: {
      "MET-100": plan(["backend", "S", "API"]),
      "MET-101": plan(["backend", "S", "API too"]),
    },
  });
  const t = setup({ adapter });
  const older = t.linear.add({
    title: "Older, lower priority",
    labels: ["ui"],
    description: BODY("S"),
    priority: 2,
    sortOrder: 1,
  });
  const newer = t.linear.add({
    title: "Newer, urgent",
    labels: ["ui"],
    description: BODY("S"),
    priority: 1,
    sortOrder: 1,
  });

  const report = await t.loop.tick();

  assert.deepEqual(report.split, [newer.key]);
  assert.deepEqual(grilled(t), [newer.key], "priority breaks the sortOrder tie");
  assert.equal(older.state, "Ready");
});

test("a split parent in Needs input holds its slot: no grill, no part and one wait line (D-057)", async () => {
  const config = mergeLayers([
    {
      scope: "workspace",
      dir: "/repo/.harnessd",
      settings: {
        limits: { max_concurrent: 3, max_parents: 1, token_budget: { S: 100, M: 100 } },
      },
      agents: {},
      rules: [],
      skills: [],
      mcp: {},
      skillSettings: {},
    },
  ]);
  const linear = new FakeLinear();
  const a = linear.add({ title: "A", labels: ["ui"], description: BODY("S") });
  const b = linear.add({ title: "B", labels: ["ui"], description: BODY("S") });
  const adapter = fakeAdapter({
    plans: {
      [a.key]: plan(["backend", "S", "A API"]),
      [b.key]: plan(["backend", "S", "B API"]),
    },
  });
  // A is already at its token budget: the first part dispatch parks A after its split (D-043).
  const store = memoryStore({
    ...emptyLoopState(),
    usage: { [a.id]: { input: 100, cached: 0, output: 0 } },
  });
  const t = setup({ config, linear, adapter, store });

  await t.loop.tick();
  const part = t.linear.children(a).find((child) => roleOf(child) === "backend");
  const qa = t.linear.children(a).find((child) => roleOf(child) === "qa");
  assert.ok(part);
  assert.ok(qa);
  assert.equal(a.state, "Needs input", "the token budget parked A after its split");
  assert.deepEqual(grilled(t), [a.key]);
  assert.deepEqual(t.loop.snapshot().runs, [], "the part did not start");
  const runsAfterEscalation = t.adapter.runs().length;

  const waitLine = `${b.key} waits, ${a.key} needs input`;
  const waitLines = () => t.logs.filter((line) => line === waitLine);
  for (let i = 0; i < 3; i++) await t.loop.tick();

  assert.deepEqual(grilled(t), [a.key], "B never grills while A holds the slot");
  assert.equal(b.state, "Ready", "B stays Ready with no split");
  assert.deepEqual(t.linear.children(b), []);
  assert.equal(waitLines().length, 1, "B logs the Needs-input wait once");
  assert.equal(part.state, "Ready", "A's part keeps its place, with no move");
  assert.equal(qa.state, "Ready", "its QA keeps its place too");
  assert.equal(
    t.linear.comments.filter((c) => c.key === part.key).length,
    0,
    "no comment on the waiting part",
  );
  assert.equal(t.adapter.runs().length, runsAfterEscalation, "no part or QA run starts");

  // The owner moves A on. Its part resumes, and B still waits because A holds the only slot.
  a.state = "In Progress";
  const flightLine = `${b.key} waits, ${a.key} is in flight`;
  const flightLinesBefore = t.logs.filter((line) => line === flightLine).length;
  const resumed = await t.loop.tick();
  assert.deepEqual(resumed.dispatched, [part.key]);
  assert.equal(part.state, "In Progress");
  assert.deepEqual(grilled(t), [a.key], "A still holds the slot");
  assert.equal(
    t.logs.filter((line) => line === flightLine).length,
    flightLinesBefore + 1,
    "the wait line logs once more when the holder leaves Needs input",
  );
});

test("a split parent in Needs input releases its slot once it is Done or Canceled", async () => {
  const config = mergeLayers([
    {
      scope: "workspace",
      dir: "/repo/.harnessd",
      settings: { limits: { max_concurrent: 3, max_parents: 1 } },
      agents: {},
      rules: [],
      skills: [],
      mcp: {},
      skillSettings: {},
    },
  ]);
  const linear = new FakeLinear();
  const parked = linear.add({ title: "Parked", state: "Needs input" });
  const done = linear.add({ title: "Done parent", state: "Done" });
  const canceled = linear.add({ title: "Canceled parent", state: "Canceled" });
  const next = linear.add({ title: "Next", labels: ["ui"], description: BODY("S") });
  const state = emptyLoopState();
  state.splits = {
    [parked.id]: { key: parked.key, parts: [], qa: "qa-1", at: "2026-11-24T10:00:00.000Z" },
    [done.id]: { key: done.key, parts: [], qa: "qa-2", at: "2026-11-23T10:00:00.000Z" },
    [canceled.id]: { key: canceled.key, parts: [], qa: "qa-3", at: "2026-11-22T10:00:00.000Z" },
  };
  const store = memoryStore(state);
  const adapter = fakeAdapter({ plans: { [next.key]: plan(["backend", "S", "Next API"]) } });
  const t = setup({ config, linear, adapter, store });

  await t.loop.tick();

  assert.deepEqual(grilled(t), [], "the Needs-input parent holds the only slot");
  assert.equal(next.state, "Ready");
  assert.ok(
    t.logs.includes(`${next.key} waits, ${parked.key} needs input`),
    "the wait line names the parked holder",
  );
  assert.equal(store.state.splits?.[done.id], undefined, "a Done parent holds no slot");
  assert.equal(store.state.splits?.[canceled.id], undefined, "a Canceled parent holds no slot");

  parked.state = "Done";
  const report = await t.loop.tick();

  assert.equal(store.state.splits?.[parked.id], undefined, "its record is dropped at Done");
  assert.deepEqual(report.split, [next.key]);
  assert.deepEqual(grilled(t), [next.key], "the slot goes to the next parent");
  assert.equal(next.state, "In Progress");
});

test("a waiting parent logs one wait line, and again only when the in-flight set changes", async () => {
  const config = mergeLayers([
    {
      scope: "workspace",
      dir: "/repo/.harnessd",
      settings: { limits: { max_concurrent: 3, max_parents: 2 } },
      agents: {},
      rules: [],
      skills: [],
      mcp: {},
      skillSettings: {},
    },
  ]);
  const adapter = fakeAdapter({
    plans: {
      "MET-100": plan(["backend", "S", "API"]),
      "MET-101": plan(["backend", "S", "API too"]),
      "MET-102": plan(["backend", "S", "API three"]),
      "MET-103": plan(["backend", "S", "API four"]),
    },
  });
  const t = setup({ config, adapter });
  const first = t.linear.add({ title: "First", labels: ["ui"], description: BODY("S") });
  const second = t.linear.add({ title: "Second", labels: ["ui"], description: BODY("S") });
  const third = t.linear.add({ title: "Third", labels: ["ui"], description: BODY("S") });
  const fourth = t.linear.add({ title: "Fourth", labels: ["ui"], description: BODY("S") });
  const waitLines = () => t.logs.filter((line) => line.includes(" waits, "));

  await t.loop.tick();
  assert.deepEqual(waitLines(), [
    `${third.key} waits, ${first.key}, ${second.key} are in flight`,
    `${fourth.key} waits, ${first.key}, ${second.key} are in flight`,
  ]);

  await t.loop.tick();
  assert.equal(waitLines().length, 2, "no second line per tick");

  // The oldest parent finishes, so a slot frees for the third. The fourth still waits, and
  // its set changed from the first two to the second and third.
  first.state = "Done";
  await t.loop.tick();

  assert.deepEqual(grilled(t), [first.key, second.key, third.key]);
  assert.equal(third.state, "In Progress");
  assert.equal(fourth.state, "Ready");
  assert.deepEqual(waitLines().slice(2), [
    `${fourth.key} waits, ${second.key}, ${third.key} are in flight`,
  ]);
});

test("the wait line names Needs-input holders, joins two, and mixes them with in flight", async () => {
  const config = mergeLayers([
    {
      scope: "workspace",
      dir: "/repo/.harnessd",
      settings: { limits: { max_concurrent: 3, max_parents: 2 } },
      agents: {},
      rules: [],
      skills: [],
      mcp: {},
      skillSettings: {},
    },
  ]);
  const adapter = fakeAdapter({
    plans: {
      "MET-100": plan(["backend", "S", "API"]),
      "MET-101": plan(["backend", "S", "API too"]),
    },
  });
  const t = setup({ config, adapter });
  const first = t.linear.add({ title: "First", labels: ["ui"], description: BODY("S") });
  const second = t.linear.add({ title: "Second", labels: ["ui"], description: BODY("S") });
  const third = t.linear.add({ title: "Third", labels: ["ui"], description: BODY("S") });
  // Only the waiting parent's lines; its split also leaves parts that log their own waits.
  const waitLines = () => t.logs.filter((line) => line.startsWith(`${third.key} waits, `));

  await t.loop.tick();
  assert.deepEqual(waitLines(), [`${third.key} waits, ${first.key}, ${second.key} are in flight`]);

  // One holder parks: the same set now reads differently, so it logs once more.
  second.state = "Needs input";
  await t.loop.tick();
  assert.deepEqual(waitLines().slice(1), [
    `${third.key} waits, ${second.key} needs input, ${first.key} is in flight`,
  ]);
  await t.loop.tick();
  assert.equal(waitLines().length, 2, "a tick with the same set logs nothing");

  // Two holders park: the keys join and the line says "need input".
  first.state = "Needs input";
  await t.loop.tick();
  assert.deepEqual(waitLines().slice(2), [
    `${third.key} waits, ${first.key}, ${second.key} need input`,
  ]);
  await t.loop.tick();
  assert.equal(waitLines().length, 3, "no line per tick");
});

test("only the oldest split records are admitted; a part of the others logs the wait line", async () => {
  const config = mergeLayers([
    {
      scope: "workspace",
      dir: "/repo/.harnessd",
      settings: { limits: { max_concurrent: 3, max_parents: 1 } },
      agents: {},
      rules: [],
      skills: [],
      mcp: {},
      skillSettings: {},
    },
  ]);
  const linear = new FakeLinear();
  const older = linear.add({ title: "Older", state: "In Progress" });
  const newer = linear.add({ title: "Newer", state: "In Progress" });
  const olderPart = linear.add({
    title: "Older part",
    parentId: older.id,
    description: `${partMarker("backend")}\n**Size**: S`,
  });
  const newerPart = linear.add({
    title: "Newer part",
    parentId: newer.id,
    description: `${partMarker("backend")}\n**Size**: S`,
  });
  const state = emptyLoopState();
  state.splits = {
    [older.id]: {
      key: older.key,
      parts: [olderPart.id],
      qa: "qa-old",
      at: "2026-11-23T10:00:00.000Z",
    },
    [newer.id]: {
      key: newer.key,
      parts: [newerPart.id],
      qa: "qa-new",
      at: "2026-11-23T11:00:00.000Z",
    },
  };
  const t = setup({ config, linear, store: memoryStore(state) });

  const report = await t.loop.tick();

  assert.deepEqual(report.dispatched, [olderPart.key], "only the oldest parent is admitted");
  assert.equal(olderPart.state, "In Progress");
  assert.equal(newerPart.state, "Ready");
  assert.ok(t.logs.includes(`${newerPart.key} waits, ${older.key} is in flight`));

  await t.loop.tick();
  assert.equal(
    t.logs.filter((line) => line === `${newerPart.key} waits, ${older.key} is in flight`).length,
    1,
    "the part logs its wait once",
  );
});

test("a part of a parent in Needs input does not dispatch", async () => {
  const linear = new FakeLinear();
  const parent = linear.add({ title: "Parked", state: "Needs input" });
  const part = linear.add({
    title: "Part",
    parentId: parent.id,
    description: `${partMarker("backend")}\n**Size**: S`,
  });
  const state = emptyLoopState();
  state.splits = {
    [parent.id]: {
      key: parent.key,
      parts: [part.id],
      qa: "qa",
      at: "2026-11-23T10:00:00.000Z",
    },
  };
  const t = setup({ linear, store: memoryStore(state) });

  const report = await t.loop.tick();

  assert.deepEqual(report.dispatched, []);
  assert.equal(part.state, "Ready");
  assert.equal(t.adapter.runs().length, 0);
});

test("at most 3 agents run at once; a finished run frees a slot", async () => {
  const config = mergeLayers([
    {
      scope: "workspace",
      dir: "/repo/.harnessd",
      settings: { limits: { max_concurrent: 3 } },
      agents: {},
      rules: [],
      skills: [],
      mcp: {},
      skillSettings: {},
    },
  ]);
  const t = setup({ config });
  const parent = t.linear.add({ title: "Big one", state: "In Progress" });
  for (let i = 1; i <= 5; i++) {
    t.linear.add({
      title: `Part ${i}`,
      parentId: parent.id,
      description: `${partMarker(`backend-${i}`)}\n**Size**: S`,
    });
  }

  const first = await t.loop.tick();
  assert.equal(first.dispatched.length, 3);
  assert.equal(t.loop.running().length, 3);
  assert.equal((await t.loop.tick()).dispatched.length, 0, "still full");

  t.adapter.pending[0]?.finish("ok");
  await settle();
  assert.equal(t.linear.byKey(first.dispatched[0] ?? "").state, "In Review");

  const next = await t.loop.tick();
  assert.equal(next.dispatched.length, 1);
  assert.equal(t.loop.running().length, 3);
  for (const run of t.adapter.pending) run.finish("ok");
  await t.loop.idle();
  const fifth = await t.loop.tick();
  assert.equal(fifth.dispatched.length, 1);
  for (const run of t.adapter.pending) run.finish("ok");
  await t.loop.idle();
  assert.equal(t.adapter.runs().length, 5);
});

test("max_concurrent and budget_minutes come from the config", async () => {
  const config = mergeLayers([
    {
      scope: "workspace",
      dir: "/repo/.harnessd",
      settings: { limits: { max_concurrent: 1, budget_minutes: { S: 5, M: 50 } } },
      agents: {},
      rules: [],
      skills: [],
      mcp: {},
      skillSettings: {},
    },
  ]);
  const t = setup({ config });
  const parent = t.linear.add({ title: "P", state: "In Progress" });
  t.linear.add({
    title: "a",
    parentId: parent.id,
    description: `${partMarker("backend")}\n**Size**: M`,
  });
  t.linear.add({
    title: "b",
    parentId: parent.id,
    description: `${partMarker("frontend")}\n**Size**: S`,
  });

  assert.equal((await t.loop.tick()).dispatched.length, 1);
  assert.equal(t.adapter.runs()[0]?.budgetMs, 50 * 60_000);
  t.adapter.pending[0]?.finish("ok");
  await t.loop.idle();
  await t.loop.tick();
  assert.equal(t.adapter.runs()[1]?.budgetMs, 5 * 60_000);
});

test("an L issue is never run: L parts or a rejected plan go to Needs input", async () => {
  // Three parents in flight, so all three grill on the same tick (MET-174).
  const config = mergeLayers([
    {
      scope: "workspace",
      dir: "/repo/.harnessd",
      settings: { limits: { max_concurrent: 3, max_parents: 3 } },
      agents: {},
      rules: [],
      skills: [],
      mcp: {},
      skillSettings: {},
    },
  ]);
  const adapter = fakeAdapter({
    plans: {
      "MET-100": plan(["backend", "L", "Everything"]),
      "MET-102": plan(["backend", "M", "Half"], ["backend", "S", "Other half"]),
    },
  });
  const t = setup({ config, adapter });
  const stillL = t.linear.add({ title: "Huge", description: BODY("L") });
  const invalid = t.linear.add({ title: "Huge too", description: BODY("L") });
  const splits = t.linear.add({ title: "Huge but splits", description: BODY("L") });

  const report = await t.loop.tick();

  assert.deepEqual(report.escalated, [stillL.key, invalid.key]);
  for (const issue of [stillL, invalid]) {
    assert.equal(issue.state, "Needs input");
    assert.equal(t.linear.children(issue).length, 0);
  }
  const comment = (key: string) =>
    t.linear.comments.filter((c) => c.key === key).at(-1)?.body ?? "";
  assert.match(
    comment(stillL.key),
    /must be split into S or M parts .*D-014.* L parts: Everything/,
  );
  assert.match(comment(invalid.key), /plan for MET-101 was rejected twice/);
  assert.equal(t.pings.length, 2);
  assert.match(t.pings[0] ?? "", /^MET-100 needs input \(split\): /);

  assert.deepEqual(t.linear.children(splits).map(roleOf), ["backend", "backend-2", "qa"]);
  assert.equal(t.adapter.runs().length, 1, "only the first serial part runs");
  assert.ok(t.adapter.runs().every((r) => !r.id.startsWith(stillL.key)));
});

test("a hand-made L sub-issue is not run either", async () => {
  const t = setup();
  const parent = t.linear.add({ title: "P", state: "In Progress" });
  const part = t.linear.add({
    title: "Too big",
    parentId: parent.id,
    description: `${partMarker("backend")}\n**Size**: L`,
  });
  const report = await t.loop.tick();
  assert.deepEqual(report.escalated, [part.key]);
  assert.equal(part.state, "Needs input");
  assert.equal(t.adapter.runs().length, 0);
});

test("a failed run goes back to Ready once; the second failure goes to Needs input", async () => {
  const t = setup();
  const parent = t.linear.add({ title: "P", state: "In Progress" });
  const part = t.linear.add({
    title: "Flaky",
    parentId: parent.id,
    description: `${partMarker("backend")}\n**Size**: S`,
  });

  await t.loop.tick();
  t.adapter.pending[0]?.finish("error", "exit 1");
  await t.loop.idle();
  assert.equal(part.state, "Ready");
  assert.equal(t.memory.state.attempts[part.id], 1);
  assert.match(t.linear.comments.at(-1)?.body ?? "", /failed \(error: exit 1\)\. Back to Ready/);
  assert.deepEqual(t.wt.removed, [`/wt/${part.key}`]);

  await t.loop.tick();
  assert.equal(t.adapter.runs()[1]?.id, `${part.key}-2`);
  t.adapter.pending[1]?.finish("timeout", "over budget");
  await t.loop.idle();
  assert.equal(part.state, "Needs input");
  assert.match(t.linear.comments.at(-1)?.body ?? "", /failed twice \(timeout: over budget\)/);
  assert.deepEqual(t.pings, [
    `${part.key} needs input (run failed): the backend run failed twice (timeout: over budget) https://linear.test/${part.key}`,
  ]);
  assert.equal(t.memory.state.attempts[part.id], undefined);

  await t.loop.tick();
  assert.equal(t.adapter.runs().length, 2, "Needs input is not picked up again");
});

test("a turn-capped part counts one attempt and is not shipped", async () => {
  const t = setup();
  const parent = t.linear.add({ title: "P", state: "In Progress" });
  const part = t.linear.add({
    title: "Long build",
    parentId: parent.id,
    description: `${partMarker("backend")}\n**Size**: S`,
  });

  await t.loop.tick();
  assert.equal(t.adapter.runs()[0]?.maxTurns, 80);
  t.adapter.pending[0]?.finish("error", "turn cap (80 turns)");
  await t.loop.idle();
  assert.equal(part.state, "Ready");
  assert.equal(t.memory.state.attempts[part.id], 1);
  assert.match(t.linear.comments.at(-1)?.body ?? "", /turn cap \(80 turns\)/);
  assert.deepEqual(t.wt.removed, [`/wt/${part.key}`]);
  assert.equal(t.memory.state.shipped?.[part.id], undefined);
});

test("a limited run goes back to Ready and uses no attempt (MET-70)", async () => {
  const t = setup();
  const parent = t.linear.add({ title: "P", state: "In Progress" });
  const part = t.linear.add({
    title: "Limited",
    parentId: parent.id,
    description: `${partMarker("backend")}\n**Size**: S`,
  });

  await t.loop.tick();
  t.adapter.pending[0]?.finish("limited", "usage limit reached");
  await t.loop.idle();
  assert.equal(part.state, "Ready");
  assert.equal(t.memory.state.attempts[part.id], undefined);
  assert.equal(t.pings.length, 0);
  assert.ok(!t.linear.comments.some((c) => /failed/.test(c.body)), "no failure comment");
});

// --- usage limits (MET-70) ---------------------------------------------------

/** A clock the test moves by hand. */
function manualClock(start = "2026-11-20T17:37:00.000Z") {
  let now = Date.parse(start);
  return {
    clock: { now: () => new Date(now), setInterval: () => 0, clearInterval: () => {} },
    advance(ms: number) {
      now += ms;
    },
    at: (ms: number) => new Date(now + ms).toISOString(),
  };
}

/** The frontend agent runs on Codex; every other agent on Claude Code. */
const FRONTEND_ON_CODEX = mergeLayers([
  {
    scope: "workspace",
    dir: "/repo/.harnessd",
    settings: { limits: { max_concurrent: 3 } },
    agents: { frontend: { harness: "codex", label: "frontend", keyPrefix: "agents.frontend" } },
    rules: [],
    skills: [],
    mcp: {},
    skillSettings: {},
  },
]);

const BACKEND_ON_OPENCODE = mergeLayers([
  {
    scope: "workspace",
    dir: "/repo/.harnessd",
    settings: { limits: { max_concurrent: 3 } },
    agents: { backend: { harness: "opencode", label: "backend", keyPrefix: "agents.backend" } },
    rules: [],
    skills: [],
    mcp: {},
    skillSettings: {},
  },
]);

/** The backend agent runs on Codex; every other agent on Claude Code. */
const BACKEND_ON_CODEX = mergeLayers([
  {
    scope: "workspace",
    dir: "/repo/.harnessd",
    settings: { limits: { max_concurrent: 3 } },
    agents: { backend: { harness: "codex", label: "backend", keyPrefix: "agents.backend" } },
    rules: [],
    skills: [],
    mcp: {},
    skillSettings: {},
  },
]);

const MINUTE = 60_000;

function part(t: ReturnType<typeof setup>, parentId: string, role: string, title: string) {
  return t.linear.add({ title, parentId, description: `${partMarker(role)}\n**Size**: S` });
}

function gate() {
  let open = (): void => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

test("a hold that starts during worktree creation prevents the next adapter start", async () => {
  const time = manualClock();
  const adapter = fakeAdapter();
  const wt = fakeWorktrees();
  const preparing = gate();
  const proceed = gate();
  const t = setup({
    adapter,
    extra: { clock: time.clock },
    worktrees: {
      ...wt.worktrees,
      async create(input) {
        if (input.title === "Second") {
          preparing.open();
          await proceed.promise;
        }
        return wt.worktrees.create(input);
      },
    },
  });
  const parent = t.linear.add({ title: "P", state: "In Progress" });
  const first = part(t, parent.id, "backend", "First");
  assert.deepEqual((await t.loop.tick()).dispatched, [first.key]);

  const second = part(t, parent.id, "frontend", "Second");
  const tick = t.loop.tick();
  await preparing.promise;
  adapter.pending[0]?.finish("limited", "usage limit reached", undefined, time.at(MINUTE));
  await settle();
  proceed.open();
  assert.deepEqual((await tick).dispatched, []);
  assert.equal(adapter.runs().length, 1);
  assert.equal(second.state, "Ready");
  assert.deepEqual(t.memory.state.attempts, {});
  assert.ok(wt.removed.includes(`/wt/${second.key}`));
});

test("a limited run holds its harness; the next try skips it and counts no attempt (D-048)", async () => {
  const time = manualClock();
  const codex = fakeAdapter({ id: "codex" });
  const claude = fakeAdapter();
  const t = setup({
    adapter: claude,
    config: FRONTEND_ON_CODEX,
    extra: { clock: time.clock, adapters: { "claude-code": claude.adapter, codex: codex.adapter } },
  });
  const parent = t.linear.add({ title: "P", state: "In Progress" });
  const a = part(t, parent.id, "backend", "A");
  const ui = part(t, parent.id, "frontend", "UI");

  assert.deepEqual((await t.loop.tick()).dispatched, [a.key, ui.key]);
  const resetAt = time.at(60 * MINUTE);
  claude.pending[0]?.finish("limited", "usage limit reached", undefined, resetAt);
  await settle();
  await settle();
  assert.equal(a.state, "Ready");
  assert.equal(t.memory.state.attempts[a.id], undefined, "no attempt used");
  assert.deepEqual(t.memory.state.limits["claude-code"], {
    until: resetAt,
    since: time.at(0),
  });
  assert.equal(t.memory.state.harnessSwitch?.[a.id]?.from, "claude-code");
  assert.deepEqual(
    t.logs.filter((l) => /limited until/.test(l)),
    [limitHoldLine("claude-code", resetAt)],
  );

  // The next tick skips the held harness: the backend runs on Codex, and the frontend joins it.
  codex.pending[0]?.finish("ok");
  const ui2 = part(t, parent.id, "frontend", "UI 2");
  time.advance(30 * MINUTE);
  assert.deepEqual((await t.loop.tick()).dispatched, [a.key, ui2.key]);
  assert.equal(claude.runs().length, 1, "the held harness starts nothing");
  assert.equal(codex.runs().length, 3, "UI, A and UI 2 all ran on Codex");
  assert.ok(
    t.logs.includes(`${a.key}: Claude Code hit its usage limit, retrying on Codex`),
    t.logs.join("\n"),
  );
  assert.equal(
    t.logs.filter((l) => /limited until/.test(l)).length,
    1,
    "logged once, not per tick",
  );
  for (const run of [...codex.pending]) run.finish("ok");
  await t.loop.idle();
  assert.equal(a.state, "In Review");

  // The reset passes: the hold ends, once.
  time.advance(30 * MINUTE);
  await t.loop.tick();
  assert.deepEqual(t.memory.state.limits, {});
  assert.deepEqual(
    t.logs.filter((l) => /available again/.test(l)),
    [limitAvailableLine("claude-code")],
  );
});

test("a hold shows in the snapshot and reports its start and end once (MET-82)", async () => {
  const time = manualClock();
  const holds: HoldEvent[] = [];
  const t = setup({ extra: { clock: time.clock, onHold: (e) => holds.push(e) } });
  const parent = t.linear.add({ title: "P", state: "In Progress" });
  part(t, parent.id, "backend", "A");
  part(t, parent.id, "backend", "B");
  assert.deepEqual(t.loop.snapshot().limits, []);

  await t.loop.tick();
  const resetAt = time.at(60 * MINUTE);
  for (const run of [...t.adapter.pending])
    run.finish("limited", "usage limit reached", undefined, resetAt);
  await t.loop.idle();
  assert.deepEqual(t.loop.snapshot().limits, [
    { harness: "claude-code", until: resetAt, backoff: false },
  ]);
  assert.deepEqual(
    holds,
    [{ harness: "claude-code", kind: "start", at: time.at(0) }],
    "one start for two runs",
  );

  time.advance(60 * MINUTE);
  assert.deepEqual(t.loop.snapshot().limits, [], "an expired hold is left out before release");
  time.advance(MINUTE);
  await t.loop.tick();
  assert.deepEqual(
    holds.at(-1),
    { harness: "claude-code", kind: "end", at: resetAt, since: time.at(-61 * MINUTE) },
    "ends at its reset time, with its own start",
  );
  assert.equal(holds.length, 2);
  for (const run of [...t.adapter.pending]) run.finish("ok");
  await t.loop.idle();
});

test("a new limit after an expired hold that was not released yet ends the old hold first", async () => {
  const time = manualClock();
  const holds: HoldEvent[] = [];
  const t = setup({ extra: { clock: time.clock, onHold: (e) => holds.push(e) } });
  const parent = t.linear.add({ title: "P", state: "In Progress" });
  part(t, parent.id, "backend", "A");
  part(t, parent.id, "backend", "B");
  await t.loop.tick();
  const [first, second] = [...t.adapter.pending];
  first?.finish("limited", "usage limit reached", undefined, time.at(10 * MINUTE));
  await settle();
  time.advance(20 * MINUTE);
  second?.finish("limited", "usage limit reached", undefined, time.at(60 * MINUTE));
  await t.loop.idle();
  assert.deepEqual(holds, [
    { harness: "claude-code", kind: "start", at: time.at(-20 * MINUTE) },
    {
      harness: "claude-code",
      kind: "end",
      at: time.at(-10 * MINUTE),
      since: time.at(-20 * MINUTE),
    },
    { harness: "claude-code", kind: "start", at: time.at(0) },
  ]);
});

test("no reset time: a 15 minute backoff that doubles, and an ok run clears it", async () => {
  const time = manualClock();
  const t = setup({ extra: { clock: time.clock } });
  const parent = t.linear.add({ title: "P", state: "In Progress" });
  const a = part(t, parent.id, "backend", "A");

  await t.loop.tick();
  t.adapter.pending[0]?.finish("limited", "rate limit");
  await t.loop.idle();
  assert.equal(t.memory.state.limits["claude-code"]?.backoffMs, 15 * MINUTE);
  assert.ok(t.logs.includes(limitHoldLine("claude-code", time.at(15 * MINUTE), true)));

  time.advance(14 * MINUTE);
  assert.deepEqual((await t.loop.tick()).dispatched, []);
  time.advance(1 * MINUTE);
  assert.deepEqual((await t.loop.tick()).dispatched, [a.key]);
  t.adapter.pending.at(-1)?.finish("limited", "rate limit");
  await t.loop.idle();
  assert.equal(t.memory.state.limits["claude-code"]?.backoffMs, 30 * MINUTE, "doubled");
  assert.ok(t.logs.includes(limitHoldLine("claude-code", time.at(30 * MINUTE), true)));

  time.advance(30 * MINUTE);
  assert.deepEqual((await t.loop.tick()).dispatched, [a.key]);
  t.adapter.pending.at(-1)?.finish("ok");
  await t.loop.idle();
  assert.deepEqual(t.memory.state.limits, {}, "an ok run clears the backoff");
  assert.equal(a.state, "In Review");
  assert.equal(t.memory.state.attempts[a.id], undefined);
});

test("an in-flight run that ends ok during a backoff hold leaves the hold as it is", async () => {
  const time = manualClock();
  const t = setup({ extra: { clock: time.clock } });
  const parent = t.linear.add({ title: "P", state: "In Progress" });
  part(t, parent.id, "backend", "A");
  part(t, parent.id, "backend", "B");
  await t.loop.tick();
  const [first, second] = [...t.adapter.pending];
  first?.finish("limited", "rate limit");
  await settle();
  const hold = t.memory.state.limits["claude-code"];
  second?.finish("ok");
  await t.loop.idle();
  assert.deepEqual(t.memory.state.limits["claude-code"], hold);
  assert.deepEqual(t.loop.snapshot().limits, [
    { harness: "claude-code", until: time.at(15 * MINUTE), backoff: true },
  ]);
});

test("a hold that starts during QA checkout prevents the reviewer from starting", async () => {
  const time = manualClock();
  const wt = fakeWorktrees();
  const preparing = gate();
  const proceed = gate();
  const t = setup({
    extra: { clock: time.clock },
    worktrees: {
      ...wt.worktrees,
      async checkout(input) {
        preparing.open();
        await proceed.promise;
        return wt.worktrees.checkout(input);
      },
    },
  });
  const work = t.linear.add({ title: "Work", state: "In Progress" });
  const first = part(t, work.id, "backend", "First");
  const { backend, qa } = qaFixture(t, "In Progress");
  assert.deepEqual((await t.loop.tick()).dispatched, [first.key]);

  backend.state = "In Review";
  t.gh.open(backend.key, 7);
  await t.loop.tick();
  await preparing.promise;
  t.adapter.pending[0]?.finish("limited", "usage limit reached", undefined, time.at(MINUTE));
  await settle();
  proceed.open();
  await t.loop.idle();

  assert.equal(t.adapter.runs().length, 1);
  assert.equal(qa.state, "Ready");
  assert.deepEqual(t.memory.state.qaFailures, {});
  assert.deepEqual(t.gh.reviews, []);
  assert.ok(wt.removed.includes(`/wt/${qa.key}-sha7`));
});

test("a limited QA run counts no QA failure and goes back to Ready", async () => {
  const time = manualClock();
  const t = setup({ extra: { clock: time.clock } });
  const { parent, backend, qa } = qaFixture(t);
  t.gh.open(backend.key, 7);

  assert.deepEqual((await t.loop.tick()).dispatched, [qa.key]);
  await settle();
  t.adapter.pending[0]?.finish("limited", "usage limit reached", undefined, time.at(MINUTE));
  await t.loop.idle();
  assert.equal(qa.state, "Ready");
  assert.equal(backend.state, "In Review", "the part is not sent back");
  assert.deepEqual(t.memory.state.qaFailures, {});
  assert.equal(t.gh.reviews.length, 0);
  assert.equal(t.linear.comments.length, 0);
  assert.deepEqual(t.wt.removed, [`/wt/${qa.key}-sha7`]);
  assert.equal(parent.state, "In Progress");
  assert.deepEqual((await t.loop.tick()).dispatched, [], "QA waits for the reset");

  time.advance(MINUTE);
  assert.deepEqual((await t.loop.tick()).dispatched, [qa.key]);
});

test("a QA checkout error counts no failure, and the next tick runs QA again", async () => {
  const wt = fakeWorktrees();
  let fail = true;
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const t = setup({
    worktrees: {
      ...wt.worktrees,
      async checkout(input) {
        if (fail) {
          fail = false;
          await wait;
          throw new Error("fetch failed");
        }
        return wt.worktrees.checkout(input);
      },
    },
  });
  const { parent, backend, qa } = qaFixture(t);
  t.gh.open(backend.key, 7);

  assert.deepEqual((await t.loop.tick()).dispatched, [qa.key]);
  release();
  await t.loop.idle();
  assert.equal(qa.state, "Ready");
  assert.notEqual(qa.state, "Needs input");
  assert.equal(backend.state, "In Review", "the part is not sent back");
  assert.equal(parent.state, "In Progress");
  assert.deepEqual(t.memory.state.qaFailures, {}, "no QA failure counted");
  assert.deepEqual(t.memory.state.reviewedHeads ?? {}, {});
  assert.equal(t.gh.reviews.length, 0);
  assert.equal(t.linear.comments.length, 0, "no comment is posted");
  assert.deepEqual(t.pings, []);
  assert.ok(
    t.logs.includes(
      `${qa.key}: QA not judged (could not check out PR #7: fetch failed), re-queued`,
    ),
  );

  assert.deepEqual((await t.loop.tick()).dispatched, [qa.key], "the next tick runs QA again");
  (await nextRun(t.adapter)).finish("ok", undefined, verdict(true, true));
  await t.loop.idle();
  assert.equal(t.gh.reviews.length, 1, "the retry really reviews the PR");
  assert.equal(backend.state, "In Review");
});

test("a Linear network error keeps the QA verdict and posts it after two failed ticks (MET-213)", async () => {
  const linear = new FakeLinear();
  let failComment = true;
  let failMove = true;
  const networkError = () => new LinearError("network", "Linear request failed: fetch failed");
  const comment = linear.comment.bind(linear);
  const moveTo = linear.moveTo.bind(linear);
  linear.comment = async (id, body) => {
    if (failComment) throw networkError();
    return comment(id, body);
  };
  linear.moveTo = async (id, state) => {
    if (failMove && state === "Ready") throw networkError();
    return moveTo(id, state);
  };
  const t = setup({ linear });
  const { parent, backend, qa } = qaFixture(t);
  t.gh.open(backend.key, 7);

  assert.deepEqual((await t.loop.tick()).dispatched, [qa.key]);
  (await nextRun(t.adapter)).finish("ok", undefined, verdict(true, true));
  await t.loop.idle();

  assert.equal(qa.state, "In Progress", "the QA ticket stays In Progress while the verdict waits");
  assert.equal(parent.state, "In Progress");
  assert.deepEqual(t.memory.state.qaFailures, {}, "no QA failure counted");
  assert.ok(t.memory.state.pendingQa?.[qa.id], "the verdict is kept");
  assert.equal(t.gh.reviews.length, 1, "the GitHub review posted");
  assert.equal(t.linear.comments.length, 0, "the Linear comment did not");

  failComment = false;
  await t.loop.tick();
  assert.ok(t.memory.state.pendingQa?.[qa.id], "the failed move keeps the verdict");
  assert.equal(qa.state, "In Progress");
  assert.equal(t.linear.comments.filter((c) => c.key === qa.key).length, 1);

  failMove = false;
  await t.loop.tick();
  assert.equal(t.memory.state.pendingQa, undefined, "the third tick finishes the writes");
  assert.equal(qa.state, "Done", "the merge gate takes the approval in the same tick");
  assert.equal(t.linear.comments.filter((c) => c.key === qa.key).length, 1);
  assert.equal(t.gh.reviews.length, 1);
  assert.equal(t.linear.moves.filter((m) => m.state === "Needs input").length, 0);
  assert.equal(parent.state, "Done");
  assert.deepEqual(t.memory.state.qaFailures, {});
  assert.deepEqual(
    t.gh.merges.map((m) => m.number),
    [7],
    "the approved PR merged once after the retry",
  );
  assert.ok(t.logs.includes(`${qa.key}: QA verdict posted after retry`));
});

test("a GitHub network error keeps the QA verdict and posts it on the next tick (MET-213)", async () => {
  const gh = fakeGitHub();
  let fail = true;
  const github: GitHub = {
    ...gh.github,
    async postReview(number, review) {
      if (fail) {
        fail = false;
        throw new Error("read ECONNRESET");
      }
      return gh.github.postReview(number, review);
    },
  };
  const t = setup({ extra: { github } });
  const { backend, qa } = qaFixture(t);
  gh.open(backend.key, 7);

  assert.deepEqual((await t.loop.tick()).dispatched, [qa.key]);
  (await nextRun(t.adapter)).finish("ok", undefined, verdict(true, true));
  await t.loop.idle();

  assert.equal(gh.reviews.length, 0, "the review post failed");
  assert.equal(qa.state, "In Progress");
  assert.ok(t.memory.state.pendingQa?.[qa.id]);
  assert.deepEqual(t.memory.state.qaFailures, {}, "no QA failure counted");
  assert.deepEqual(t.memory.state.merges, []);

  await t.loop.tick();
  assert.equal(gh.reviews.length, 1);
  assert.equal(gh.reviews[0]?.event, "APPROVE");
  assert.equal(t.memory.state.pendingQa, undefined);
  assert.equal(qa.state, "Done", "the merge gate takes the approval in the same tick");
  assert.equal(gh.merges.length, 1, "the approval merged after the retry");
  assert.ok(t.logs.includes(`${qa.key}: QA verdict posted after retry`));
});

test("retrying a QA send-back keeps its cases and counts the verdict once", async () => {
  const t = setup();
  const { parent, backend, qa } = qaFixture(t);
  t.gh.open(backend.key, 7);
  let down = true;
  const comment = t.linear.comment.bind(t.linear);
  t.linear.comment = async (id, body) => {
    if (id === qa.id && down) throw new Error("fetch failed");
    return comment(id, body);
  };

  assert.deepEqual((await t.loop.tick()).dispatched, [qa.key]);
  (await nextRun(t.adapter)).finish("ok", undefined, verdict(false, true));
  await t.loop.idle();

  assert.equal(backend.state, "Ready", "the part move succeeded before the outage");
  const cases = t.memory.state.pendingQa?.[qa.id]?.reviews[0]?.cases;
  assert.equal(cases?.length, 1);
  assert.deepEqual((await t.loop.tick()).dispatched, [], "the fix waits for its QA feedback");
  assert.deepEqual(t.memory.state.qaFailures, {});
  assert.deepEqual(t.pings, []);

  down = false;
  assert.deepEqual((await t.loop.tick()).dispatched, [backend.key]);
  assert.equal(t.memory.state.pendingQa, undefined);
  assert.equal(t.memory.state.qaFailures[parent.id], 1);
  assert.deepEqual(t.memory.state.qaFeedback[backend.id]?.cases, cases);
  assert.equal(t.linear.comments.filter((c) => c.key === backend.key).length, 1);
  assert.equal(t.gh.reviews.length, 1);
  assert.deepEqual(t.pings, []);
  (await nextRun(t.adapter, 2)).finish("ok");
  await t.loop.idle();
});

test("three failed Linear ticks in a row reset the connections once (MET-213)", async () => {
  const linear = new FakeLinear();
  let resets = 0;
  linear.resetConnections = () => {
    resets += 1;
  };
  let down = true;
  linear.listReadyContaining = async () => {
    if (down) throw new LinearError("network", "Linear request failed: fetch failed");
    return [];
  };
  const t = setup({ linear });
  const tick = () => t.loop.tick().catch(() => undefined);

  await tick();
  await tick();
  assert.equal(resets, 0, "two failed ticks are not enough");
  down = false;
  await tick();
  assert.equal(resets, 0, "a clean tick starts the count again");
  down = true;
  await tick();
  await tick();
  assert.equal(resets, 0);
  await tick();
  assert.equal(resets, 1, "the third failed tick in a row resets the pool");
  await tick();
  assert.equal(resets, 1, "the count starts again after a reset");
  assert.equal(
    t.logs.filter((line) => line === "Linear unreachable for 3 ticks, connections reset").length,
    1,
  );
});

// --- fallback harness (MET-81) ------------------------------------------------

/** The backend agent runs on Claude Code with opus, and on Codex with gpt-5 while Claude Code is held. */
const BACKEND_WITH_FALLBACK = mergeLayers([
  {
    scope: "workspace",
    dir: "/repo/.harnessd",
    settings: { limits: { max_concurrent: 3 } },
    agents: {
      backend: {
        model: "opus",
        fallback_harness: "codex",
        fallback_model: "gpt-5",
        label: "backend",
        keyPrefix: "agents.backend",
      },
    },
    rules: [],
    skills: [],
    mcp: {},
    skillSettings: {},
  },
]);

function fallbackSetup() {
  const time = manualClock();
  const codex = fakeAdapter({ id: "codex" });
  const claude = fakeAdapter();
  const t = setup({
    adapter: claude,
    config: BACKEND_WITH_FALLBACK,
    extra: { clock: time.clock, adapters: { "claude-code": claude.adapter, codex: codex.adapter } },
  });
  const parent = t.linear.add({ title: "P", state: "In Progress" });
  return { t, time, codex, claude, parent };
}

test("while the main harness is held, the agent runs on its fallback harness and model, then on the main one after the reset", async () => {
  const { t, time, codex, claude, parent } = fallbackSetup();
  const a = part(t, parent.id, "backend", "A");

  assert.deepEqual((await t.loop.tick()).dispatched, [a.key]);
  assert.equal(claude.runs()[0]?.model, "opus");
  claude.pending[0]?.finish("limited", "usage limit reached", undefined, time.at(60 * MINUTE));
  await t.loop.idle();
  assert.equal(a.state, "Ready");

  time.advance(5 * MINUTE);
  assert.deepEqual((await t.loop.tick()).dispatched, [a.key]);
  assert.equal(claude.runs().length, 1, "the held harness starts nothing");
  assert.equal(codex.runs().length, 1);
  assert.equal(codex.runs()[0]?.model, "gpt-5");
  assert.ok(
    t.logs.includes(`${a.key}: Claude Code hit its usage limit, retrying on Codex`),
    t.logs.join("\n"),
  );
  codex.pending[0]?.finish("ok");
  await t.loop.idle();
  assert.equal(a.state, "In Review");
  assert.ok(t.memory.state.limits["claude-code"], "an ok fallback run does not end the main hold");

  time.advance(55 * MINUTE);
  const b = part(t, parent.id, "backend", "B");
  assert.deepEqual((await t.loop.tick()).dispatched, [b.key]);
  assert.equal(claude.runs().length, 2, "back on the main harness after the reset");
  assert.equal(claude.runs()[1]?.model, "opus");
  assert.equal(codex.runs().length, 1);
  claude.pending.at(-1)?.finish("ok");
  await t.loop.idle();
});

test("a held fallback harness is not used: the part waits in Ready", async () => {
  const { t, time, codex, claude, parent } = fallbackSetup();
  const a = part(t, parent.id, "backend", "A");

  await t.loop.tick();
  claude.pending[0]?.finish("limited", "usage limit reached", undefined, time.at(60 * MINUTE));
  await t.loop.idle();
  assert.deepEqual((await t.loop.tick()).dispatched, [a.key]);
  codex.pending[0]?.finish("limited", "rate limit", undefined, time.at(30 * MINUTE));
  await t.loop.idle();
  assert.equal(a.state, "Ready");
  assert.equal(t.memory.state.attempts[a.id], undefined);
  assert.ok(t.memory.state.limits.codex, "the fallback run's limit holds the fallback harness");

  time.advance(10 * MINUTE);
  assert.deepEqual((await t.loop.tick()).dispatched, [], "both harnesses are held");
  assert.equal(claude.runs().length + codex.runs().length, 2);

  time.advance(20 * MINUTE);
  assert.deepEqual((await t.loop.tick()).dispatched, [a.key], "the fallback hold ended first");
  assert.equal(codex.runs().length, 2);
  codex.pending.at(-1)?.finish("ok");
  await t.loop.idle();
});

test("no fallback harness, or one with no adapter: a held agent waits as before", async () => {
  const time = manualClock();
  const claude = fakeAdapter();
  const t = setup({ adapter: claude, config: BACKEND_WITH_FALLBACK, extra: { clock: time.clock } });
  const parent = t.linear.add({ title: "P", state: "In Progress" });
  const a = part(t, parent.id, "backend", "A");

  await t.loop.tick();
  claude.pending[0]?.finish("limited", "usage limit reached", undefined, time.at(60 * MINUTE));
  await t.loop.idle();
  assert.deepEqual((await t.loop.tick()).dispatched, [], "codex has no adapter");
  assert.ok(!t.logs.some((l) => / while /.test(l)));
  assert.equal(a.state, "Ready");
});

test("a timeout moves the next try to the next harness and counts one attempt (D-048)", async () => {
  const opencode = fakeAdapter({ id: "opencode" });
  const codex = fakeAdapter({ id: "codex" });
  const t = setup({
    adapter: opencode,
    config: BACKEND_ON_OPENCODE,
    extra: { adapters: { opencode: opencode.adapter, codex: codex.adapter } },
  });
  const parent = t.linear.add({ title: "P", state: "In Progress" });
  const a = part(t, parent.id, "backend", "A");

  assert.deepEqual((await t.loop.tick()).dispatched, [a.key]);
  assert.equal(opencode.runs().length, 1);
  opencode.pending[0]?.finish("timeout", "budget of 1800000ms exceeded");
  await t.loop.idle();
  assert.equal(a.state, "Ready");
  assert.equal(t.memory.state.attempts[a.id], 1);
  assert.equal(t.memory.state.harnessSwitch?.[a.id]?.from, "opencode");

  assert.deepEqual((await t.loop.tick()).dispatched, [a.key]);
  assert.equal(codex.runs().length, 1, "the retry runs on the next harness");
  assert.equal(opencode.runs().length, 1, "the timed-out harness does not retry");
  assert.ok(t.logs.includes(`${a.key}: OpenCode timed out, retrying on Codex`), t.logs.join("\n"));

  codex.pending.at(-1)?.finish("timeout", "budget of 1800000ms exceeded");
  await t.loop.idle();
  assert.equal(a.state, "Needs input", "two failures still go to Needs input");
  assert.equal(t.memory.state.harnessSwitch?.[a.id], undefined);
  assert.equal(t.pings.length, 1);
});

test("a harness whose installed check failed is skipped (D-048)", async () => {
  const opencode = fakeAdapter({ id: "opencode" });
  const codex = fakeAdapter({ id: "codex" });
  const t = setup({
    adapter: opencode,
    config: BACKEND_ON_OPENCODE,
    extra: {
      adapters: { opencode: opencode.adapter, codex: codex.adapter },
      harnessChecks: () => [{ id: "harness.opencode.cli", state: "missing" as const }],
    },
  });
  const parent = t.linear.add({ title: "P", state: "In Progress" });
  const a = part(t, parent.id, "backend", "A");

  assert.deepEqual((await t.loop.tick()).dispatched, [a.key]);
  assert.equal(opencode.runs().length, 0, "the not-installed harness starts nothing");
  assert.equal(codex.runs().length, 1);
  assert.ok(
    t.logs.includes(`${a.key}: OpenCode is not installed, running on Codex`),
    t.logs.join("\n"),
  );
  codex.pending[0]?.finish("ok");
  await t.loop.idle();
});

test("with no harness left the issue stays Ready and logs the line once (D-048)", async () => {
  const opencode = fakeAdapter({ id: "opencode" });
  const t = setup({
    adapter: opencode,
    config: BACKEND_ON_OPENCODE,
    extra: {
      harnessChecks: () => [
        { id: "harness.opencode.cli", state: "missing" as const },
        { id: "harness.codex.cli", state: "missing" as const },
        { id: "harness.claude-code.cli", state: "missing" as const },
      ],
    },
  });
  const parent = t.linear.add({ title: "P", state: "In Progress" });
  const a = part(t, parent.id, "backend", "A");

  assert.deepEqual((await t.loop.tick()).dispatched, []);
  assert.deepEqual((await t.loop.tick()).dispatched, []);
  assert.equal(a.state, "Ready");
  assert.equal(t.memory.state.attempts[a.id], undefined, "no attempt is counted");
  assert.deepEqual(t.linear.comments, [], "no comment is posted");
  assert.deepEqual(t.pings, [], "no notice is sent");
  const lines = t.logs.filter((l) => l.startsWith(`${a.key}: no harness left`));
  assert.equal(lines.length, 1, "logged once per set of reasons");
  assert.match(lines[0] ?? "", /OpenCode is not installed/);
  assert.match(lines[0] ?? "", /Codex has no adapter/);
});

test("a turn cap keeps the same harness and counts one attempt (D-048)", async () => {
  const opencode = fakeAdapter({ id: "opencode" });
  const codex = fakeAdapter({ id: "codex" });
  const t = setup({
    adapter: opencode,
    config: BACKEND_ON_OPENCODE,
    extra: { adapters: { opencode: opencode.adapter, codex: codex.adapter } },
  });
  const parent = t.linear.add({ title: "P", state: "In Progress" });
  const a = part(t, parent.id, "backend", "A");

  await t.loop.tick();
  opencode.pending[0]?.finish(
    "error",
    "turn cap (80 turns)",
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    "turn_cap",
  );
  await t.loop.idle();
  assert.equal(t.memory.state.harnessSwitch?.[a.id], undefined, "no switch on a turn cap");
  assert.equal(t.memory.state.attempts[a.id], 1);

  assert.deepEqual((await t.loop.tick()).dispatched, [a.key]);
  assert.equal(opencode.runs().length, 2, "the retry stays on the same harness");
  assert.equal(codex.runs().length, 0);
  opencode.pending.at(-1)?.finish("ok");
  await t.loop.idle();
});

test("a ship failure keeps the harness of the switched run (D-048)", async () => {
  const opencode = fakeAdapter({ id: "opencode" });
  const codex = fakeAdapter({ id: "codex" });
  const linear = new FakeLinear();
  const parent = linear.add({ title: "P", state: "In Progress" });
  const a = linear.add({
    title: "A",
    parentId: parent.id,
    description: `${partMarker("backend")}\n**Size**: S`,
  });
  const store = memoryStore();
  store.state.harnessSwitch = {
    [a.id]: { from: "opencode", reason: "timed out", at: "2026-11-23T09:00:00.000Z" },
  };
  const t = setup({
    linear,
    store,
    adapter: opencode,
    config: BACKEND_ON_OPENCODE,
    extra: {
      adapters: { opencode: opencode.adapter, codex: codex.adapter },
      ship: async () => ({ ok: false as const, error: "push failed: nope" }),
    },
  });

  assert.deepEqual((await t.loop.tick()).dispatched, [a.key]);
  assert.equal(codex.runs().length, 1, "the switch picks the next harness");
  assert.equal(opencode.runs().length, 0);
  codex.pending[0]?.finish("ok");
  await t.loop.idle();
  assert.equal(a.state, "Ready");
  assert.equal(store.state.attempts[a.id], 1);
  assert.equal(store.state.harnessSwitch?.[a.id]?.from, "opencode", "the record stays");

  assert.deepEqual((await t.loop.tick()).dispatched, [a.key]);
  assert.equal(codex.runs().length, 2, "the retry stays on the same harness");
  assert.equal(opencode.runs().length, 0);
  codex.pending.at(-1)?.finish("ok");
  await t.loop.idle();
});

test("a grill timeout switches the coordinator harness (D-048)", async () => {
  const claude = fakeAdapter({ grillStatus: "timeout" });
  const codex = fakeAdapter({ id: "codex", plans: { "MET-100": plan(["backend", "S", "API"]) } });
  const t = setup({
    adapter: claude,
    extra: { adapters: { "claude-code": claude.adapter, codex: codex.adapter } },
  });
  const issue = t.linear.add({ title: "Work", description: BODY("M") });

  const first = await t.loop.tick();
  assert.deepEqual(first.split, []);
  assert.equal(issue.state, "Ready");
  assert.equal(t.memory.state.harnessSwitch?.[issue.id]?.from, "claude-code");
  assert.equal(claude.tasks.filter((task) => task.id.startsWith("grill-")).length, 2, "two tries");

  const next = await t.loop.tick();
  assert.deepEqual(next.split, [issue.key]);
  assert.ok(
    codex.tasks.some((task) => task.id.startsWith("grill-")),
    "the grill ran on Codex",
  );
  assert.ok(
    t.logs.includes(`${issue.key}: Claude Code timed out, retrying on Codex`),
    t.logs.join("\n"),
  );
  assert.equal(t.memory.state.harnessSwitch?.[issue.id], undefined, "the split ends the switch");
});

test("a limited grill or plan run does not escalate: the issue stays Ready, nothing is posted", async () => {
  for (const which of ["grill", "plan"] as const) {
    const time = manualClock();
    const adapter = fakeAdapter(
      which === "grill" ? { grillStatus: "limited" } : { planStatus: "limited" },
    );
    const t = setup({ adapter, extra: { clock: time.clock } });
    const issue = t.linear.add({ title: "Work", description: BODY("M") });

    const report = await t.loop.tick();
    assert.deepEqual(report.escalated, [], which);
    assert.deepEqual(report.split, [], which);
    assert.equal(issue.state, "Ready", which);
    assert.equal(t.linear.children(issue).length, 0, which);
    assert.deepEqual(t.pings, [], which);
    assert.ok(t.memory.state.limits["claude-code"], `${which}: the coordinator harness is held`);
    if (which === "grill") assert.deepEqual(t.linear.comments, []);
    const runs = t.adapter.tasks.length;
    await t.loop.tick();
    assert.equal(t.adapter.tasks.length, runs, `${which}: no run while held`);
  }
});

test("a hold in loop.json survives a restart", async () => {
  const time = manualClock();
  const state = emptyLoopState();
  state.limits["claude-code"] = { until: time.at(60 * MINUTE), since: time.at(0) };
  const store = memoryStore(state);
  const t = setup({ store, extra: { clock: time.clock } });
  const parent = t.linear.add({ title: "P", state: "In Progress" });
  const a = part(t, parent.id, "backend", "A");
  assert.deepEqual((await t.loop.tick()).dispatched, []);
  time.advance(60 * MINUTE);
  assert.deepEqual((await t.loop.tick()).dispatched, [a.key]);
  assert.deepEqual(store.state.limits, {});
});

/** A parent with one backend part and its QA sub-issue, as a split leaves them. */
function qaFixture(t: ReturnType<typeof setup>, partState = "In Review") {
  const parent = t.linear.add({ title: "P", state: "In Progress", description: BODY("M") });
  const backend = t.linear.add({
    title: "API",
    parentId: parent.id,
    state: partState,
    description: `${partMarker("backend")}\n**Size**: S`,
  });
  const qa = t.linear.add({
    title: "QA: P",
    parentId: parent.id,
    description: `${partMarker("qa")}\n**Size**: M`,
  });
  t.linear.relations.push({ blocker: backend.id, blocked: qa.id });
  // MET-226: QA starts only after the reviewer approved the current PR head. These tests
  // use PR #7 at sha7, so the part is review-approved unless a test says otherwise.
  t.memory.state.reviewerHeads ??= {};
  t.memory.state.reviewerHeads[backend.id] = {
    sha: "sha7",
    verdict: "approved",
    findings: [],
    at: "2026-11-23T10:00:00.000Z",
  };
  return { parent, backend, qa };
}

/** Give a synthetic QA fixture the records a real shipped part would already have. */
function trackShippedPart(
  t: ReturnType<typeof setup>,
  { parent, backend, qa }: ReturnType<typeof qaFixture>,
) {
  t.memory.state.splits = {
    [parent.id]: { key: parent.key, parts: [backend.id], qa: qa.id, at: "2026-11-23T10:00:00Z" },
  };
  t.memory.state.shipped = {
    [backend.id]: {
      key: backend.key,
      branch: backend.key.toLowerCase(),
      prUrl: "https://github.test/o/r/pull/7",
      at: "2026-11-23T10:00:00Z",
    },
  };
}

const verdict = (...pass: boolean[]) => {
  let n = 0;
  const cases: Array<{
    id: string;
    item: string;
    repro: string;
    expected: string;
    actual: string;
  }> = [];
  pass.forEach((p, i) => {
    if (p) return;
    n += 1;
    cases.push({
      id: `C${n}`,
      item: `item ${i + 1}`,
      repro: "pnpm test",
      expected: "it passes",
      actual: `evidence ${i + 1}`,
    });
  });
  return JSON.stringify({
    items: pass.map((p, i) => ({ text: `item ${i + 1}`, pass: p, evidence: `evidence ${i + 1}` })),
    testsPassed: true,
    cases,
  });
};

test("QA reviews one part as soon as it reaches In Review, at its PR head", async () => {
  const t = setup();
  const parent = t.linear.add({ title: "P", state: "In Progress", description: BODY("M") });
  const backend = t.linear.add({
    title: "API",
    parentId: parent.id,
    state: "In Review",
    description: `${partMarker("backend")}\n**Size**: S`,
  });
  const frontend = t.linear.add({
    title: "UI",
    parentId: parent.id,
    state: "In Progress",
    description: `${partMarker("frontend")}\n**Size**: S`,
  });
  const qa = t.linear.add({
    title: "QA: P",
    parentId: parent.id,
    description: `${partMarker("qa")}\n**Size**: M`,
  });
  t.linear.relations.push(
    { blocker: backend.id, blocked: qa.id },
    { blocker: frontend.id, blocked: qa.id },
  );
  t.gh.open(backend.key, 7);
  // MET-226: the reviewer approved this head, so QA may start.
  t.memory.state.reviewerHeads = {
    [backend.id]: {
      sha: "sha7",
      verdict: "approved",
      findings: [],
      at: "2026-11-23T10:00:00.000Z",
    },
  };

  assert.deepEqual((await t.loop.tick()).dispatched, [qa.key]);
  assert.equal(qa.state, "In Progress");
  await settle();

  assert.deepEqual(t.wt.checkouts, [
    { issueKey: qa.key, title: "pr 7", branch: backend.key.toLowerCase(), sha: "sha7" },
  ]);
  const path = `/wt/${qa.key}-sha7`;
  assert.deepEqual(t.commands, [
    { command: "pnpm install --frozen-lockfile --prefer-offline", cwd: path },
    { command: "pnpm test", cwd: path },
  ]);
  const run = t.adapter.runs()[0];
  assert.equal(t.adapter.pending[0]?.cwd, path);
  assert.equal(run?.id, `${qa.key}-qa-1-pr7`);
  assert.ok((run?.budgetMs ?? 0) <= 120 * 60_000);
  assert.match(run?.prompt ?? "", /1\. Works\n2\. Has tests/);
  assert.match(run?.prompt ?? "", /`pnpm test` passed/);
  assert.match(run?.prompt ?? "", /diff --git a\/src\/x\.ts/);
  assert.match(run?.prompt ?? "", /## CI\n- CI \/ test: success/);
  assert.match(run?.prompt ?? "", /## Part brief\nharnessd part: backend/);
  assert.match(run?.prompt ?? "", /Judge each item only from the test results/);
  assert.doesNotMatch(run?.prompt ?? "", /code style|code quality|Open a file only/);
  assert.doesNotMatch(run?.prompt ?? "", /Read the diff and the code/);
  assert.equal(
    t.memory.state.inFlight[0]?.worktree,
    path,
    "the worktree is recorded for a restart",
  );

  t.adapter.pending[0]?.finish("ok", undefined, verdict(true, true));
  await t.loop.idle();
  assert.equal(t.gh.reviews.length, 1);
  assert.equal(t.gh.reviews[0]?.event, "APPROVE");
  assert.equal(t.gh.reviews[0]?.commitId, "sha7");
  assert.deepEqual(t.wt.removed, [path]);
  assert.equal(qa.state, "Ready", "QA waits Ready for the next part");
  assert.equal(backend.state, "In Review");
  assert.equal(frontend.state, "In Progress", "the other part is untouched");
  assert.match(t.linear.comments.at(-1)?.body ?? "", /approved.*\n\n.*PR #7.*review-1/s);
  assert.deepEqual(t.memory.state.inFlight, []);
  assert.deepEqual(t.memory.state.qaFailures, {});
  assert.deepEqual(t.memory.state.reviewedHeads?.[backend.id], {
    sha: "sha7",
    verdict: "approved",
  });
  assert.equal(
    t.memory.state.reviewedHeads?.[backend.id]?.cases,
    undefined,
    "an approval stores no cases",
  );
  assert.deepEqual(
    t.memory.state.merges.map((m) => [m.qaKey, m.prs.map((p) => [p.number, p.sha])]),
    [[qa.key, [[7, "sha7"]]]],
    "one merge entry with one PR",
  );
});

/** A split parent with one shipped part at PR #7, In Review, and its QA sub-issue. */
function reviewFixture(options: { partSize?: string; withQa?: boolean } = {}) {
  const linear = new FakeLinear();
  const parent = linear.add({ title: "P", state: "In Progress", description: BODY("M") });
  const part = linear.add({
    title: "API",
    parentId: parent.id,
    state: "In Review",
    description: [
      partMarker("backend"),
      "",
      "**Goal**",
      "Ship the API.",
      "",
      "**Done when**",
      "- [ ] Works",
      "",
      `**Size**: ${options.partSize ?? "S"}`,
    ].join("\n"),
  });
  let qa: FakeIssue | undefined;
  let qaId = "qa-1";
  if (options.withQa !== false) {
    qa = linear.add({
      title: "QA: P",
      parentId: parent.id,
      state: "Ready",
      description: `${partMarker("qa")}\n**Size**: M`,
    });
    qaId = qa.id;
    linear.relations.push({ blocker: part.id, blocked: qa.id });
  }
  const state = emptyLoopState();
  state.splits = {
    [parent.id]: {
      key: parent.key,
      parts: [part.id],
      qa: qaId,
      at: "2026-11-23T10:00:00.000Z",
    },
  };
  state.shipped = {
    [part.id]: {
      key: part.key,
      branch: part.key.toLowerCase(),
      prUrl: "https://github.test/o/r/pull/7",
      at: "2026-11-23T10:01:00.000Z",
    },
  };
  return { linear, parent, part, qa, state };
}

const ONE_AT_A_TIME = mergeLayers([
  {
    scope: "workspace",
    dir: "/repo/.harnessd",
    settings: { limits: { max_concurrent: 1 } },
    agents: {},
    rules: [],
    skills: [],
    mcp: {},
    skillSettings: {},
  },
]);

test("a shipped part in In Review gets one review before QA, at its PR head (MET-224)", async () => {
  const fx = reviewFixture();
  const store = memoryStore(fx.state);
  const t = setup({ config: ONE_AT_A_TIME, linear: fx.linear, store });
  t.gh.open(fx.part.key, 7);

  const report = await t.loop.tick();

  assert.deepEqual(report.dispatched, [fx.part.key], "the review starts before QA");
  const run = t.adapter.runs()[0];
  assert.equal(run?.id, `${fx.part.key}-review-pr7`);
  assert.equal(run?.readOnly, true, "the reviewer edits nothing");
  assert.equal(run?.role, "reviewer");
  assert.equal(run?.maxTurns, 15, "the reviewer turn cap for an S part");
  assert.equal(run?.budgetMs, 30 * 60_000, "the part's size budget");
  assert.match(run?.prompt ?? "", /diff --git a\/src\/x\.ts/);
  assert.match(run?.prompt ?? "", /The loop needs it\./, "the parent issue");
  assert.match(run?.prompt ?? "", /\*\*Goal\*\*\nShip the API\./, "the part brief");
  assert.match(run?.prompt ?? "", /Edit nothing/);
  assert.deepEqual(t.wt.checkouts, [
    {
      issueKey: fx.part.key,
      title: "pr 7",
      branch: fx.part.key.toLowerCase(),
      sha: "sha7",
    },
  ]);
  assert.equal(t.adapter.pending[0]?.cwd, `/wt/${fx.part.key}-sha7`);
  assert.equal(fx.qa?.state, "Ready", "QA does not start while the review holds the slot");
  assert.equal(t.gh.reviews.length, 0);

  const nit: ReviewFinding = {
    file: "src/api.ts",
    line: 9,
    severity: "nit",
    kind: "design",
    text: "The name hides the seam.",
  };
  t.adapter.pending[0]?.finish(
    "ok",
    undefined,
    JSON.stringify({ decision: "approve", findings: [nit] }),
    undefined,
    { input: 10, cacheRead: 5, cacheWrite: 2, output: 3 },
    4,
  );
  await t.loop.idle();

  assert.equal(t.gh.reviews.length, 1);
  assert.equal(t.gh.reviews[0]?.event, "COMMENT");
  assert.equal(t.gh.reviews[0]?.commitId, "sha7");
  assert.match(
    t.gh.reviews[0]?.body ?? "",
    /- src\/api\.ts:9 \(nit, design\): The name hides the seam\./,
  );
  const head = store.state.reviewerHeads?.[fx.part.id];
  assert.equal(head?.sha, "sha7");
  assert.equal(head?.verdict, "approved");
  assert.deepEqual(head?.findings, [nit]);
  assert.match(head?.at ?? "", /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(
    store.state.usage?.[fx.parent.id],
    { input: 10, cached: 7, output: 3 },
    "review tokens count in the parent's sum",
  );
  assert.deepEqual(t.wt.removed, [`/wt/${fx.part.key}-sha7`], "the review checkout is never kept");

  const next = await t.loop.tick();
  assert.deepEqual(next.dispatched, [fx.qa?.key], "QA starts on the next tick");
  assert.equal(
    t.adapter.runs().filter((task) => task.role === "reviewer").length,
    1,
    "the approved head is not reviewed twice",
  );
  t.adapter.pending.at(-1)?.finish("ok", undefined, verdict(true, true));
  await t.loop.idle();
});

for (const mode of ["agent", "tests"]) {
  test(`QA in ${mode} mode stays Ready until the reviewer approves the PR head (MET-226)`, async () => {
    const t = setup({ config: ONE_AT_A_TIME });
    const fx = qaFixture(t);
    const { backend, qa } = fx;
    trackShippedPart(t, fx);
    t.memory.state.reviewerHeads = {};
    if (mode === "tests") {
      backend.description += "\n\n**Verify**\n- `pnpm test` → exits 0\n\n**QA**: tests";
    }
    t.gh.open(backend.key, 7);

    assert.deepEqual((await t.loop.tick()).dispatched, [backend.key]);
    assert.equal(qa.state, "Ready");
    assert.deepEqual(t.commands, [], "QA tests have not started");
    const line = `${qa.key} waits, ${backend.key} review pending`;
    assert.equal(t.logs.filter((entry) => entry === line).length, 1);

    assert.deepEqual((await t.loop.tick()).dispatched, [], "the same pending set waits quietly");
    assert.equal(t.logs.filter((entry) => entry === line).length, 1);

    (await nextRun(t.adapter)).finish(
      "ok",
      undefined,
      JSON.stringify({ decision: "approve", findings: [] }),
    );
    await t.loop.idle();
    assert.deepEqual((await t.loop.tick()).dispatched, [qa.key]);
    if (mode === "agent")
      (await nextRun(t.adapter, 2)).finish("ok", undefined, verdict(true, true));
    await t.loop.idle();
    assert.equal(t.adapter.runs().length, mode === "tests" ? 1 : 2);
    assert.equal(t.memory.state.merges[0]?.prs[0]?.sha, "sha7");
  });
}

test("a part of a parent with no split record still gets the review QA waits for (MET-226)", async () => {
  const t = setup({ config: ONE_AT_A_TIME });
  const parent = t.linear.add({ title: "P", state: "In Progress", description: BODY("M") });
  const part = t.linear.add({
    title: "API",
    parentId: parent.id,
    state: "In Review",
    description: `${partMarker("backend")}\n**Size**: S`,
  });
  const qa = t.linear.add({
    title: "QA: P",
    parentId: parent.id,
    description: `${partMarker("qa")}\n**Size**: M`,
  });
  t.linear.relations.push({ blocker: part.id, blocked: qa.id });
  t.gh.open(part.key, 7);

  assert.deepEqual(
    (await t.loop.tick()).dispatched,
    [part.key],
    "the QA wait starts the review no other path would",
  );
  assert.equal(qa.state, "Ready");
  assert.equal(
    t.logs.filter((line) => line === `${qa.key} waits, ${part.key} review pending`).length,
    1,
  );

  (await nextRun(t.adapter)).finish(
    "ok",
    undefined,
    JSON.stringify({ decision: "approve", findings: [] }),
  );
  await t.loop.idle();
  assert.deepEqual((await t.loop.tick()).dispatched, [qa.key], "QA runs on the approved head");
});

test("a part missing from shipped still gets the review its QA round waits for (MET-226)", async () => {
  const t = setup({ config: ONE_AT_A_TIME });
  const { parent, backend, qa } = qaFixture(t);
  t.memory.state.splits = {
    [parent.id]: { key: parent.key, parts: [backend.id], qa: qa.id, at: "2026-11-23T10:00:00Z" },
  };
  t.memory.state.reviewerHeads = {};
  delete t.memory.state.shipped;
  t.gh.open(backend.key, 7);

  assert.deepEqual((await t.loop.tick()).dispatched, [backend.key], "the review is backfilled");
  assert.equal(t.wt.checkouts.at(-1)?.sha, "sha7");
  assert.equal(qa.state, "Ready");

  (await nextRun(t.adapter)).finish(
    "ok",
    undefined,
    JSON.stringify({ decision: "approve", findings: [] }),
  );
  await t.loop.idle();
  assert.equal(t.memory.state.reviewerHeads?.[backend.id]?.sha, "sha7");
  assert.deepEqual((await t.loop.tick()).dispatched, [qa.key], "QA starts after the approval");
});

test("a part QA already approved still gets the review it never had (MET-233)", async () => {
  const t = setup({ config: ONE_AT_A_TIME });
  const parent = t.linear.add({ title: "P", state: "In Progress", description: BODY("M") });
  const part = t.linear.add({
    title: "API",
    parentId: parent.id,
    state: "In Review",
    description: `${partMarker("backend")}\n**Size**: S`,
  });
  const qa = t.linear.add({
    title: "QA: P",
    parentId: parent.id,
    description: `${partMarker("qa")}\n**Size**: M`,
  });
  t.linear.relations.push({ blocker: part.id, blocked: qa.id });
  // An old part: QA approved this head, but no reviewer ever judged it, and the daemon holds
  // no shipped or split record for it (MET-233, D-060).
  t.memory.state.reviewedHeads = { [part.id]: { sha: "sha7", verdict: "approved" } };
  t.gh.open(part.key, 7);

  const first = await t.loop.tick();
  assert.deepEqual(first.dispatched, [part.key], "the review runs where the skip used to be");
  assert.equal(
    t.adapter.runs().filter((run) => run.role === "reviewer").length,
    1,
    "one review run",
  );
  assert.equal(
    t.adapter.runs().filter((run) => run.role === "qa").length,
    0,
    "no QA run before the review",
  );
  assert.equal(qa.state, "Ready");

  (await nextRun(t.adapter)).finish(
    "ok",
    undefined,
    JSON.stringify({ decision: "approve", findings: [] }),
  );
  await t.loop.idle();
  assert.equal(t.memory.state.reviewerHeads?.[part.id]?.sha, "sha7");

  assert.deepEqual((await t.loop.tick()).dispatched, [], "both approved this head: no QA run");
  assert.equal(
    t.adapter.runs().filter((run) => run.role === "qa").length,
    0,
    "the QA approval at this head stands",
  );
  assert.equal(qa.state, "Ready");
});

test("a head that moves during QA re-queues the round and runs a delta review (MET-226)", async () => {
  const t = setup({ config: ONE_AT_A_TIME });
  const fx = qaFixture(t);
  const { backend, qa } = fx;
  trackShippedPart(t, fx);
  t.gh.open(backend.key, 7);
  // Each read is a snapshot, as a fresh `gh pr view` is, so the round sees a push mid-run.
  const read = t.gh.github.findPrForIssue.bind(t.gh.github);
  t.gh.github.findPrForIssue = async (key) => {
    const found = await read(key);
    return found === undefined ? undefined : { ...found };
  };

  assert.deepEqual((await t.loop.tick()).dispatched, [qa.key]);
  await settle();
  const pr = t.gh.prs[backend.key];
  assert.ok(pr);
  pr.headRefOid = "sha7-pushed";
  t.adapter.pending[0]?.finish("ok", undefined, verdict(true, true));
  await t.loop.idle();

  assert.equal(qa.state, "Ready", "the stale round is re-queued");
  assert.deepEqual(t.memory.state.qaFailures, {}, "a stale verdict counts no QA failure");
  assert.deepEqual(t.gh.reviews, [], "no verdict is posted for the head that moved");
  assert.deepEqual(t.memory.state.merges, []);

  assert.deepEqual(
    (await t.loop.tick()).dispatched,
    [backend.key],
    "the delta review runs on the new head",
  );
  (await nextRun(t.adapter, 2)).finish(
    "ok",
    undefined,
    JSON.stringify({ decision: "approve", findings: [] }),
  );
  await t.loop.idle();
  assert.deepEqual((await t.loop.tick()).dispatched, [qa.key], "QA runs on the reviewed new head");
  await nextRun(t.adapter, 3);
  assert.equal(t.wt.checkouts.at(-1)?.sha, "sha7-pushed");
});

test("a reloaded stale pending QA result re-queues QA and counts no failure (MET-232)", async () => {
  const root = await mkdtemp(join(tmpdir(), "harnessd-stale-qa-"));
  roots.push(root);
  const fx = reviewFixture();
  assert.ok(fx.qa);
  const qa = fx.qa;
  fx.state.reviewerHeads = {
    [fx.part.id]: {
      sha: "sha7",
      verdict: "changes_requested",
      findings: [],
      at: "2026-11-27T10:00:00.000Z",
    },
  };
  fx.state.qaFailures = { [fx.parent.id]: 1 };
  fx.state.pendingQa = {
    [qa.id]: {
      parentId: fx.parent.id,
      qaKey: qa.key,
      reviews: [
        {
          partId: fx.part.id,
          partKey: fx.part.key,
          decision: "error",
          failing: [],
          prNumber: 7,
          prUrl: "https://github.test/o/r/pull/7",
          head: "sha7",
          event: "COMMENT",
          body: "**harnessd QA**: re-queued.",
          done: true,
          stale: true,
          error: "the PR head moved from sha7 to sha8 during QA",
        },
      ],
      done: [],
    },
  };
  const store = createFileLoopStore(root);
  await store.save(fx.state);
  assert.equal((await store.load()).pendingQa?.[qa.id]?.reviews[0]?.stale, true, "reloaded stale");

  const t = setup({ config: ONE_AT_A_TIME, linear: fx.linear, store });
  t.gh.open(fx.part.key, 7);
  await t.loop.tick();

  assert.equal(qa.state, "Ready", "the stale round is re-queued");
  const after = await store.load();
  assert.deepEqual(after.qaFailures, { [fx.parent.id]: 1 }, "the count is unchanged");
  assert.deepEqual(t.pings, [], "no notice is sent");
  assert.equal(fx.parent.state, "In Progress", "no escalation");
  assert.equal(after.pendingQa, undefined, "the settled record is dropped");
  assert.deepEqual(
    fx.linear.comments.filter((comment) => comment.key === fx.parent.key),
    [],
    "no parent comment",
  );
});

/** A pending QA approval for the review fixture's part, saved at PR #7 sha7 (MET-233). */
function pendingQaApproval(fx: ReturnType<typeof reviewFixture>) {
  const qa = fx.qa;
  assert.ok(qa);
  fx.state.reviewerHeads = {
    [fx.part.id]: {
      sha: "sha7",
      verdict: "approved",
      findings: [],
      at: "2026-11-23T10:00:00.000Z",
    },
  };
  fx.state.qaFailures = { [fx.parent.id]: 1 };
  // The live round records its approval before its pending post and settle finish; the retry
  // must clear it when it discards the verdict (MET-233).
  fx.state.reviewedHeads = { [fx.part.id]: { sha: "sha7", verdict: "approved" } };
  fx.state.pendingQa = {
    [qa.id]: {
      parentId: fx.parent.id,
      qaKey: qa.key,
      reviews: [
        {
          partId: fx.part.id,
          partKey: fx.part.key,
          decision: "approve",
          failing: [],
          prNumber: 7,
          prUrl: "https://github.test/o/r/pull/7",
          head: "sha7",
          event: "APPROVE",
          body: "**harnessd QA**: approved.",
          done: false,
        },
      ],
      done: [],
    },
  };
  return qa;
}

test("a pending QA retry drops a verdict whose PR head moved before it posts (MET-233)", async () => {
  const fx = reviewFixture();
  const qa = pendingQaApproval(fx);
  const store = memoryStore(fx.state);
  const t = setup({ config: ONE_AT_A_TIME, linear: fx.linear, store });
  t.gh.open(fx.part.key, 7);
  const pr = t.gh.prs[fx.part.key];
  assert.ok(pr);
  pr.headRefOid = "sha8";
  qa.state = "In Progress";

  await t.loop.tick();

  assert.deepEqual(t.gh.reviews, [], "the stale verdict is never posted");
  assert.equal(qa.state, "Ready", "QA is re-queued");
  assert.deepEqual(store.state.qaFailures, { [fx.parent.id]: 1 }, "the count is unchanged");
  assert.equal(store.state.pendingQa, undefined, "the settled record is dropped");
  assert.deepEqual(store.state.merges, [], "nothing is pinned to the stale head");
  assert.equal(
    store.state.reviewedHeads?.[fx.part.id],
    undefined,
    "the discarded approval no longer marks the head as QA-approved",
  );
  assert.ok(
    t.logs.some((line) => line.includes("moved from sha7 to sha8")),
    "the moved head is logged",
  );
});

test("a pending QA retry never posts on a saved PR that closed (MET-233)", async () => {
  const fx = reviewFixture();
  const qa = pendingQaApproval(fx);
  const store = memoryStore(fx.state);
  const t = setup({ config: ONE_AT_A_TIME, linear: fx.linear, store });
  // PR #7 closed, and PR #8 now carries the issue at the same sha.
  t.gh.open(fx.part.key, 8);
  const pr = t.gh.prs[fx.part.key];
  assert.ok(pr);
  pr.headRefOid = "sha7";
  qa.state = "In Progress";

  await t.loop.tick();

  assert.deepEqual(t.gh.reviews, [], "the verdict never goes to the closed PR #7");
  assert.ok(
    t.linear.moves.some((move) => move.key === qa.key && move.state === "Ready"),
    "QA is re-queued before it runs again on the unchanged sha",
  );
  assert.equal(store.state.pendingQa, undefined, "the record is dropped");
  assert.ok(
    t.logs.some((line) => line.includes("PR #7 closed")),
    "the closed PR is logged",
  );
});

test("a stale pending verdict ignores its saved not-judged marker (MET-233)", async () => {
  const linear = new FakeLinear();
  let failComment = false;
  const comment = linear.comment.bind(linear);
  linear.comment = async (id, body) => {
    if (failComment) throw new Error("fetch failed");
    return comment(id, body);
  };
  const t = setup({ config: ONE_AT_A_TIME, linear });
  const { parent, backend, qa } = qaFixture(t);
  trackShippedPart(t, { parent, backend, qa });
  t.gh.open(backend.key, 7);

  // One not-judged QA run on sha7: the next one on the same head would escalate (D-052).
  assert.deepEqual((await t.loop.tick()).dispatched, [qa.key]);
  (await nextRun(t.adapter)).finish("timeout", "budget of 1000ms exceeded");
  await t.loop.idle();
  assert.equal(qa.state, "Ready", "the not-judged round re-queues");

  // The second run is not judged too, and its settle fails a Linear write, so the record
  // keeps the not-judged marker with no count committed.
  failComment = true;
  assert.deepEqual((await t.loop.tick()).dispatched, [qa.key]);
  (await nextRun(t.adapter, 2)).finish("timeout", "budget of 1000ms exceeded");
  await t.loop.idle();
  assert.equal(
    t.memory.state.pendingQa?.[qa.id]?.reviews[0]?.notJudged,
    "timeout",
    "the marker is saved with the pending verdict",
  );

  // The head moves before the retry, so the saved verdict is stale, not a second timeout.
  failComment = false;
  const pr = t.gh.prs[backend.key];
  assert.ok(pr);
  pr.headRefOid = "sha8";

  await t.loop.tick();

  assert.equal(qa.state, "Ready", "a stale verdict re-queues instead of escalating");
  assert.equal(parent.state, "In Progress", "the parent is not escalated");
  assert.deepEqual(t.pings, [], "no notice is sent");
  assert.equal(t.memory.state.pendingQa, undefined, "the record is dropped");
  assert.ok(
    t.logs.some((line) => line.includes("moved from sha7 to sha8")),
    "the moved head is logged",
  );
});

test("a network error on the pending QA head read keeps the record for the next tick (MET-233)", async () => {
  const fx = reviewFixture();
  const qa = pendingQaApproval(fx);
  const store = memoryStore(fx.state);
  const t = setup({ config: ONE_AT_A_TIME, linear: fx.linear, store });
  t.gh.open(fx.part.key, 7);
  qa.state = "In Progress";
  const read = t.gh.github.findPrForIssue.bind(t.gh.github);
  let fail = true;
  t.gh.github.findPrForIssue = async (key) => {
    if (fail) {
      fail = false;
      throw new Error("read ECONNRESET");
    }
    return read(key);
  };

  await t.loop.tick();

  assert.deepEqual(t.gh.reviews, [], "nothing is posted while the head is unknown");
  assert.equal(qa.state, "In Progress", "the QA ticket waits");
  assert.deepEqual(store.state.qaFailures, { [fx.parent.id]: 1 }, "the count is unchanged");
  assert.ok(store.state.pendingQa?.[qa.id], "the record is kept for the next tick");

  await t.loop.tick();

  assert.equal(t.gh.reviews.length, 1, "the unchanged head posts on the retry");
  assert.equal(store.state.pendingQa, undefined, "the record is settled");
  assert.deepEqual(store.state.qaFailures, {}, "the approval clears the count");
});

test("an approved head is skipped and a new head gets a review (MET-224)", async () => {
  const fx = reviewFixture({ withQa: false });
  const state = fx.state;
  state.reviewerHeads = {
    [fx.part.id]: {
      sha: "sha7",
      verdict: "approved",
      findings: [],
      at: "2026-11-27T10:00:00.000Z",
    },
  };
  const t = setup({ config: ONE_AT_A_TIME, linear: fx.linear, store: memoryStore(state) });
  const pr = t.gh.open(fx.part.key, 7);

  assert.deepEqual((await t.loop.tick()).dispatched, []);
  assert.equal(t.adapter.runs().length, 0);
  pr.headRefOid = "new-head";
  assert.deepEqual((await t.loop.tick()).dispatched, [fx.part.key]);
  assert.equal(t.wt.checkouts.at(-1)?.sha, "new-head");
  for (let i = 0; i < 100 && t.adapter.pending[0] === undefined; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  t.adapter.pending.at(-1)?.finish(
    "ok",
    undefined,
    JSON.stringify({
      decision: "approve",
      findings: [],
    }),
  );
  await t.loop.idle();
  assert.equal(t.gh.reviews.at(-1)?.commitId, "new-head");
});

test("a review uses the part size's cap and budget (MET-224, D-014)", async () => {
  const fx = reviewFixture({ partSize: "M", withQa: false });
  const t = setup({ config: ONE_AT_A_TIME, linear: fx.linear, store: memoryStore(fx.state) });
  t.gh.open(fx.part.key, 7);

  await t.loop.tick();

  const run = t.adapter.runs()[0];
  assert.equal(run?.maxTurns, 30);
  assert.equal(run?.budgetMs, 120 * 60_000);
  t.adapter.pending[0]?.finish("cancelled");
  await t.loop.idle();
});

test("a failed review post is kept in pendingReview and retried with no failure (MET-224, D-058)", async () => {
  const fx = reviewFixture({ withQa: false });
  const store = memoryStore(fx.state);
  const t = setup({ config: ONE_AT_A_TIME, linear: fx.linear, store });
  t.gh.open(fx.part.key, 7);
  const post = t.gh.github.postReview.bind(t.gh.github);
  let down = true;
  let postsWithSavedVerdict = 0;
  t.gh.github.postReview = async (number, review) => {
    assert.equal(store.state.reviewerHeads?.[fx.part.id]?.sha, "sha7");
    assert.equal(store.state.pendingReview?.[fx.part.id]?.head, "sha7");
    postsWithSavedVerdict += 1;
    if (down) {
      down = false;
      throw new Error("fetch failed");
    }
    return post(number, review);
  };

  await t.loop.tick();
  const blocking: ReviewFinding = {
    file: "src/api.ts",
    line: 12,
    severity: "blocking",
    kind: "code",
    text: "The loop reads the file on every tick.",
  };
  t.adapter.pending[0]?.finish(
    "ok",
    undefined,
    JSON.stringify({ decision: "changes_requested", findings: [blocking] }),
  );
  await t.loop.idle();

  assert.equal(postsWithSavedVerdict, 1, "the verdict was already saved when posting");
  assert.equal(t.gh.reviews.length, 0, "the post failed");
  assert.equal(store.state.reviewerHeads?.[fx.part.id]?.verdict, "changes_requested");
  const pending = store.state.pendingReview?.[fx.part.id];
  assert.equal(pending?.prNumber, 7);
  assert.equal(pending?.head, "sha7");
  assert.match(pending?.body ?? "", /- src\/api\.ts:12 \(blocking, code\)/);
  assert.deepEqual(store.state.attempts, {}, "no failure is counted");
  assert.ok(
    t.logs.some((line) => line.includes("could not post the review on PR #7")),
    t.logs.join("\n"),
  );

  await t.loop.tick();

  assert.equal(t.gh.reviews.length, 1, "the retry posts the kept review");
  assert.equal(t.gh.reviews[0]?.event, "COMMENT");
  assert.equal(t.gh.reviews[0]?.commitId, "sha7");
  assert.equal(store.state.pendingReview?.[fx.part.id], undefined);
  assert.equal(
    t.adapter.runs().filter((task) => task.role === "reviewer").length,
    1,
    "the retry posts the verdict; it does not review again",
  );
  assert.equal(store.state.qaFeedback[fx.part.id]?.source, "review", "the retried settle runs");
  assert.deepEqual(store.state.qaFeedback[fx.part.id]?.failing, [
    "R1 (src/api.ts:12) The loop reads the file on every tick.",
  ]);
  assert.equal(store.state.reviewFailures[fx.part.id], 1);
});

test("a network error while a review settles keeps the record and retries its unfinished writes (MET-230, D-058)", async () => {
  const fx = reviewFixture({ withQa: false });
  const store = memoryStore(fx.state);
  const t = setup({ config: ONE_AT_A_TIME, linear: fx.linear, store });
  t.gh.open(fx.part.key, 7);
  const moveTo = fx.linear.moveTo.bind(fx.linear);
  let down = true;
  fx.linear.moveTo = async (id, state) => {
    if (down && id === fx.part.id && state === "Ready") {
      down = false;
      throw new Error("fetch failed");
    }
    return moveTo(id, state);
  };

  await t.loop.tick();
  const blocking: ReviewFinding = {
    file: "src/api.ts",
    line: 12,
    severity: "blocking",
    kind: "code",
    text: "The loop reads the file on every tick.",
  };
  t.adapter.pending[0]?.finish(
    "ok",
    undefined,
    JSON.stringify({ decision: "changes_requested", findings: [blocking] }),
  );
  await t.loop.idle();

  const pending = store.state.pendingReview?.[fx.part.id];
  assert.ok(pending, "the unsettled record stays");
  assert.equal(fx.part.state, "In Review", "the part is not sent back yet");
  assert.equal(
    store.state.qaFeedback[fx.part.id],
    undefined,
    "no feedback until the move succeeds",
  );
  assert.equal(store.state.reviewFailures[fx.part.id], undefined, "no failure is counted");
  assert.deepEqual(
    store.state.pendingReviewSettle?.[fx.part.id]?.done,
    [`comment on ${fx.part.key}`],
    "the done comment is kept; the failed move is not",
  );
  assert.equal(
    t.linear.comments.filter((comment) => comment.key === fx.part.key).length,
    1,
    "the comment went out once",
  );

  await t.loop.tick();

  assert.equal(
    store.state.pendingReview?.[fx.part.id],
    undefined,
    "the record goes once every step is done",
  );
  assert.ok(
    t.linear.moves.some((move) => move.key === fx.part.key && move.state === "Ready"),
    "the part is sent back",
  );
  assert.deepEqual(store.state.qaFeedback[fx.part.id]?.failing, [
    "R1 (src/api.ts:12) The loop reads the file on every tick.",
  ]);
  assert.equal(store.state.reviewFailures[fx.part.id], 1);
  assert.equal(
    t.linear.comments.filter((comment) => comment.key === fx.part.key).length,
    1,
    "the done comment is not posted again",
  );
  t.adapter.pending.at(-1)?.finish("cancelled");
  await t.loop.idle();
});

test("a part whose Ready move landed before a timeout waits for its review settlement (MET-230)", async () => {
  const fx = reviewFixture({ withQa: false });
  fx.part.description += "\n\n**Verify**\n- `pnpm test` → exit 0";
  fx.state.sessions = {
    [fx.part.id]: {
      harness: "claude-code",
      sessionId: "sess-1",
      worktree: `/wt/${fx.part.key}`,
      branch: fx.part.key.toLowerCase(),
      at: "2026-11-27T10:00:00.000Z",
    },
  };
  const adapter = fakeAdapter({ canResume: true });
  const store = memoryStore(fx.state);
  const t = setup({ config: ONE_AT_A_TIME, adapter, linear: fx.linear, store });
  t.gh.open(fx.part.key, 7);
  await t.loop.tick();

  const moveTo = fx.linear.moveTo.bind(fx.linear);
  let timeouts = 2;
  fx.linear.moveTo = async (id, state) => {
    if (id === fx.part.id && state === "Ready" && timeouts > 0) {
      timeouts -= 1;
      await moveTo(id, state);
      throw new Error("fetch failed");
    }
    return moveTo(id, state);
  };

  const blocking: ReviewFinding = {
    file: "src/api.ts",
    line: 12,
    severity: "blocking",
    kind: "code",
    text: "The loop reads the file on every tick.",
  };
  t.adapter.pending[0]?.finish(
    "ok",
    undefined,
    JSON.stringify({ decision: "changes_requested", findings: [blocking] }),
  );
  await t.loop.idle();

  assert.equal(fx.part.state, "Ready", "the move landed before the timeout");
  assert.ok(store.state.pendingReview?.[fx.part.id], "the settlement stays pending");
  assert.equal(store.state.qaFeedback[fx.part.id], undefined, "the findings are not saved yet");
  assert.deepEqual(store.state.pendingReviewSettle?.[fx.part.id]?.done, [
    `comment on ${fx.part.key}`,
  ]);

  const blocked = await t.loop.tick();
  assert.deepEqual(blocked.dispatched, [], "the builder waits for the settlement");
  assert.equal(
    t.adapter
      .runs()
      .filter((run) => run.role !== "reviewer" && !run.id.includes("-review-decision-")).length,
    0,
    "no builder run starts without the findings",
  );
  assert.ok(
    store.state.pendingReview?.[fx.part.id],
    "the second timeout keeps the settlement pending",
  );

  const report = await t.loop.tick();
  assert.deepEqual(report.dispatched, [fx.part.key], "the builder runs after the settle");
  const run = t.adapter.runs().at(-1);
  assert.equal(run?.resumeSessionId, "sess-1", "the builder resumes with the findings");
  assert.match(run?.prompt ?? "", /R1 \(src\/api\.ts:12\)/);
  t.adapter.pending.at(-1)?.finish("ok");
  await t.loop.idle();
});

test("a pending review written without a verdict recovers it from reviewerHeads (MET-230)", async () => {
  const fx = reviewFixture({ withQa: false });
  const blocking: ReviewFinding = {
    file: "src/api.ts",
    line: 12,
    severity: "blocking",
    kind: "code",
    text: "The loop reads the file on every tick.",
  };
  fx.state.reviewerHeads = {
    [fx.part.id]: {
      sha: "sha7",
      verdict: "changes_requested",
      findings: [blocking],
      at: "2026-11-27T10:00:00.000Z",
    },
  };
  fx.state.pendingReview = {
    [fx.part.id]: {
      partId: fx.part.id,
      partKey: fx.part.key,
      parentId: fx.parent.id,
      prNumber: 7,
      prUrl: "https://github.test/o/r/pull/7",
      head: "sha7",
      body: "**harnessd review**: changes requested.",
      posted: true,
    },
  };
  const store = memoryStore(fx.state);
  const t = setup({ config: ONE_AT_A_TIME, linear: fx.linear, store });
  t.gh.open(fx.part.key, 7);

  await t.loop.tick();

  assert.equal(store.state.pendingReview, undefined);
  assert.ok(
    t.linear.moves.some((move) => move.key === fx.part.key && move.state === "Ready"),
    "the recovered verdict sends the part back",
  );
  assert.deepEqual(store.state.qaFeedback[fx.part.id]?.failing, [
    "R1 (src/api.ts:12) The loop reads the file on every tick.",
  ]);
  assert.equal(store.state.reviewFailures[fx.part.id], 1, "the send-back counts one review round");
  assert.ok(
    !t.logs.some((line) => line.includes("review failed")),
    "a recovered verdict is never a run failure",
  );
  assert.match(
    t.linear.comments.find((comment) => comment.key === fx.part.key)?.body ?? "",
    /R1 \(src\/api\.ts:12\)/,
  );
  t.adapter.pending.at(-1)?.finish("cancelled");
  await t.loop.idle();
});

test("a pending review with no matching recorded head is dropped with one line (MET-230)", async () => {
  const fx = reviewFixture({ withQa: false });
  fx.state.reviewerHeads = {
    [fx.part.id]: {
      sha: "sha7",
      verdict: "changes_requested",
      findings: [],
      at: "2026-11-27T10:00:00.000Z",
    },
  };
  fx.state.pendingReview = {
    [fx.part.id]: {
      partId: fx.part.id,
      partKey: fx.part.key,
      parentId: fx.parent.id,
      prNumber: 7,
      prUrl: "https://github.test/o/r/pull/7",
      head: "sha6",
      body: "**harnessd review**: changes requested.",
      posted: true,
    },
  };
  const store = memoryStore(fx.state);
  const t = setup({ config: ONE_AT_A_TIME, linear: fx.linear, store });
  t.gh.open(fx.part.key, 7);

  await t.loop.tick();

  assert.equal(store.state.pendingReview, undefined, "the record is dropped");
  assert.equal(fx.part.state, "In Review", "nothing is settled from a missing verdict");
  assert.equal(store.state.reviewFailures[fx.part.id], undefined, "no failure is counted");
  assert.equal(
    t.logs.filter((line) => line.includes("dropped the pending review")).length,
    1,
    "one log line",
  );
  t.adapter.pending[0]?.finish("cancelled");
  await t.loop.idle();
});

test("an unposted legacy review is validated before its comment is posted (MET-230)", async () => {
  const fx = reviewFixture({ withQa: false });
  fx.state.reviewerHeads = {
    [fx.part.id]: {
      sha: "sha7",
      verdict: "changes_requested",
      findings: [],
      at: "2026-11-27T10:00:00.000Z",
    },
  };
  fx.state.pendingReview = {
    [fx.part.id]: {
      partId: fx.part.id,
      partKey: fx.part.key,
      parentId: fx.parent.id,
      prNumber: 7,
      prUrl: "https://github.test/o/r/pull/7",
      head: "sha6",
      body: "**harnessd review**: changes requested.",
    },
  };
  const store = memoryStore(fx.state);
  const t = setup({ config: ONE_AT_A_TIME, linear: fx.linear, store });
  t.gh.open(fx.part.key, 7);

  await t.loop.tick();

  assert.equal(t.gh.reviews.length, 0, "the stale verdict is never published");
  assert.equal(store.state.pendingReview, undefined, "the unmatched record is dropped");
  assert.equal(fx.part.state, "In Review", "nothing is settled from it");
  assert.equal(
    t.logs.filter((line) => line.includes("dropped the pending review")).length,
    1,
    "one log line",
  );
});

test("a timed-out part move in a not-judged escalation is retried to Needs input (MET-230)", async () => {
  const fx = reviewFixture({ withQa: false });
  const store = memoryStore(fx.state);
  const t = setup({ config: ONE_AT_A_TIME, linear: fx.linear, store });
  t.gh.open(fx.part.key, 7);

  await t.loop.tick();
  t.adapter.pending[0]?.finish("timeout", "budget of 1000ms exceeded");
  await t.loop.idle();
  assert.equal(fx.part.state, "In Review", "the first timeout re-queues the same head");

  const moveTo = fx.linear.moveTo.bind(fx.linear);
  let down = true;
  fx.linear.moveTo = async (id, state) => {
    if (down && id === fx.part.id && state === "Needs input") {
      down = false;
      // The response times out before the move takes effect.
      throw new Error("fetch failed");
    }
    return moveTo(id, state);
  };

  assert.deepEqual((await t.loop.tick()).dispatched, [fx.part.key], "the same head reviews again");
  t.adapter.pending.at(-1)?.finish("timeout", "budget of 1000ms exceeded");
  await t.loop.idle();

  assert.equal(fx.parent.state, "Needs input");
  assert.equal(fx.part.state, "In Review", "the part move did not land");
  assert.equal(store.state.reviewFailures[fx.part.id], undefined, "no review failure counted");
  const pending = store.state.pendingReviewSettle?.[fx.part.id];
  assert.ok(pending, "the unfinished escalation is saved");
  assert.deepEqual(pending?.done, [
    `comment on ${fx.parent.key}`,
    `move ${fx.parent.key} to Needs input`,
  ]);
  assert.equal(
    t.pings.filter((ping) => ping.includes("review not judged twice")).length,
    0,
    "the notice waits for the part move",
  );

  await t.loop.tick();

  assert.equal(fx.part.state, "Needs input", "the next tick finishes the part move");
  assert.equal(
    store.state.pendingReviewSettle?.[fx.part.id],
    undefined,
    "the record goes once every step is done",
  );
  assert.equal(
    t.pings.filter((ping) => ping.includes("review not judged twice")).length,
    1,
    "the notice goes out after the retried move",
  );
});

test("a restart finishes a not-judged escalation saved before its writes (MET-232)", async () => {
  const root = await mkdtemp(join(tmpdir(), "harnessd-resettle-"));
  roots.push(root);
  const fx = reviewFixture({ withQa: false });
  const store = createFileLoopStore(root);
  await store.save(fx.state);
  const first = setup({ config: ONE_AT_A_TIME, linear: fx.linear, store });
  first.gh.open(fx.part.key, 7);

  await first.loop.tick();
  first.adapter.pending[0]?.finish("timeout", "budget of 1000ms exceeded");
  await first.loop.idle();
  assert.equal(fx.part.state, "In Review", "the first timeout re-queues the same head");

  // The second not-judged run on the same head escalates. The parent comment lands, then the
  // parent move times out, so the saved record holds the decision and one done step.
  const moveTo = fx.linear.moveTo.bind(fx.linear);
  let down = true;
  fx.linear.moveTo = async (id, state) => {
    if (down && id === fx.parent.id && state === "Needs input") {
      down = false;
      throw new Error("fetch failed");
    }
    return moveTo(id, state);
  };

  assert.deepEqual(
    (await first.loop.tick()).dispatched,
    [fx.part.key],
    "the same head reviews again",
  );
  first.adapter.pending.at(-1)?.finish("timeout", "budget of 1000ms exceeded");
  await first.loop.idle();

  const saved = await store.load();
  const pending = saved.pendingReviewSettle?.[fx.part.id];
  assert.ok(pending, "the unfinished escalation is saved");
  assert.deepEqual(pending.escalation, { reasons: ["timed out", "timed out"] });
  assert.deepEqual(
    pending.done,
    [`comment on ${fx.parent.key}`],
    "the comment is the only done step",
  );
  assert.equal(fx.parent.state, "In Progress", "the parent move did not land");
  assert.equal(fx.part.state, "In Review", "the part move did not run");

  // The daemon restarts: the in-memory count is empty and a new loop reads loop.json.
  resetReviewNotJudged();
  const second = setup({ config: ONE_AT_A_TIME, linear: fx.linear, store });
  await second.loop.tick();

  assert.equal(fx.parent.state, "Needs input");
  assert.equal(fx.part.state, "Needs input");
  assert.equal(
    fx.linear.comments.filter((comment) => comment.key === fx.parent.key).length,
    1,
    "the parent comment is posted once",
  );
  assert.equal(
    second.pings.filter((ping) => ping.includes("review not judged twice")).length,
    1,
    "the notice is sent once after the restart",
  );
  assert.equal((await store.load()).pendingReviewSettle, undefined, "the record goes when done");
});

test("a restart replays a saved not-judged escalation with no writes done (MET-232)", async () => {
  const root = await mkdtemp(join(tmpdir(), "harnessd-resettle-"));
  roots.push(root);
  const fx = reviewFixture({ withQa: false });
  fx.state.pendingReviewSettle = {
    [fx.part.id]: {
      partId: fx.part.id,
      partKey: fx.part.key,
      parentId: fx.parent.id,
      prNumber: 7,
      prUrl: "https://github.test/o/r/pull/7",
      head: "sha7",
      notJudged: "timeout",
      escalation: { reasons: ["timed out", "timed out"] },
      done: [],
    },
  };
  const store = createFileLoopStore(root);
  await store.save(fx.state);
  const t = setup({ config: ONE_AT_A_TIME, linear: fx.linear, store });
  t.gh.open(fx.part.key, 7);

  await t.loop.tick();

  assert.equal(fx.parent.state, "Needs input");
  assert.equal(fx.part.state, "Needs input");
  assert.equal(
    fx.linear.comments.filter((comment) => comment.key === fx.parent.key).length,
    1,
    "the saved escalation posts the parent comment once",
  );
  assert.equal(
    t.pings.filter((ping) => ping.includes("review not judged twice")).length,
    1,
    "the saved escalation sends one notice",
  );
  assert.equal(
    (await store.load()).pendingReviewSettle,
    undefined,
    "the replayed record is dropped",
  );
});

test("a restart replays a saved review decision with no second coordinator run and one notice (MET-243)", async () => {
  const root = await mkdtemp(join(tmpdir(), "harnessd-redecision-"));
  roots.push(root);
  const fx = reviewFixture({ withQa: false });
  const decision = {
    decision: "escalate" as const,
    trigger: "money" as const,
    question: "May the fix spend the paid seat?",
    options: ["Spend it", "Re-plan with the free seat"],
    recommendation: "Re-plan with the free seat.",
  };
  const store = createFileLoopStore(root);
  await store.save(fx.state);
  const started = setup({
    config: ONE_AT_A_TIME,
    adapter: fakeAdapter({ reviewDecision: JSON.stringify(decision) }),
    linear: fx.linear,
    store,
  });
  started.gh.open(fx.part.key, 7);
  await started.loop.tick();

  // The escalation's parent comment lands, then the parent move times out, so the record holds
  // the saved decision and one done step.
  const moveTo = fx.linear.moveTo.bind(fx.linear);
  let down = true;
  fx.linear.moveTo = async (id, state) => {
    if (down && id === fx.parent.id && state === "Needs input") {
      down = false;
      throw new Error("fetch failed");
    }
    return moveTo(id, state);
  };
  const blocking: ReviewFinding = {
    file: "src/api.ts",
    line: 12,
    severity: "blocking",
    kind: "code",
    text: "The loop reads the file on every tick.",
  };
  started.adapter.pending[0]?.finish(
    "ok",
    undefined,
    JSON.stringify({ decision: "changes_requested", findings: [blocking] }),
  );
  await started.loop.idle();

  const saved = await store.load();
  assert.deepEqual(saved.pendingReviewSettle?.[fx.part.id]?.decision, decision, "durable");
  assert.equal(fx.parent.state, "In Progress", "the parent move did not land");
  assert.equal(fx.part.state, "In Review", "the part stays In Review until the settle");

  // The daemon restarts: a new loop and a new adapter read loop.json.
  const next = fakeAdapter();
  const second = setup({ config: ONE_AT_A_TIME, adapter: next, linear: fx.linear, store });
  second.gh.open(fx.part.key, 7);
  await second.loop.tick();

  assert.equal(fx.parent.state, "Needs input");
  assert.equal(fx.part.state, "Needs input");
  assert.equal(
    next.tasks.filter((task) => task.id.includes("-review-decision-r")).length,
    0,
    "the saved decision is replayed with no second coordinator run",
  );
  assert.equal(
    fx.linear.comments.filter((comment) => comment.key === fx.parent.key).length,
    1,
    "the parent comment is posted once",
  );
  assert.equal(
    second.pings.filter((ping) => ping.includes("needs a human (money)")).length,
    1,
    "the notice is sent once",
  );
  assert.equal(
    (await store.load()).pendingReviewSettle,
    undefined,
    "the replayed record is dropped",
  );
  assert.equal((await store.load()).pendingReview, undefined, "the PR record is dropped");
});

test("a retried review decision waits for a free run slot (MET-243)", async () => {
  const fx = reviewFixture({ withQa: false });
  const blocking: ReviewFinding = {
    file: "src/api.ts",
    line: 12,
    severity: "blocking",
    kind: "code",
    text: "The loop reads the file on every tick.",
  };
  fx.state.pendingReviewSettle = {
    [fx.part.id]: {
      partId: fx.part.id,
      partKey: fx.part.key,
      parentId: fx.parent.id,
      prNumber: 7,
      prUrl: "https://github.test/o/r/pull/7",
      head: "sha7",
      verdict: "changes_requested",
      findings: [blocking],
      done: [],
    },
  };
  // A run this process cannot retire still owns the only slot: its issue is gone, so the
  // re-queue move fails and the entry stays.
  fx.state.inFlight = [
    {
      issueId: "gone-1",
      issueKey: "MET-999",
      role: "backend",
      agent: "backend",
      worktree: "",
      branch: "met-999",
      startedAt: "2026-11-27T10:00:00.000Z",
      pid: 1,
    },
  ];
  const config = mergeLayers([
    {
      scope: "workspace",
      dir: "/repo/.harnessd",
      settings: { limits: { max_concurrent: 1 } },
      agents: {},
      rules: [],
      skills: [],
      mcp: {},
      skillSettings: {},
    },
  ]);
  const store = memoryStore(fx.state);
  const t = setup({ config, linear: fx.linear, store });

  await t.loop.tick();

  const waiting = store.state.pendingReviewSettle?.[fx.part.id];
  assert.ok(waiting, "the settlement stays pending");
  assert.equal(waiting?.decision, undefined, "no decision is saved without a slot");
  assert.equal(
    t.adapter.tasks.filter((task) => task.id.includes("-review-decision-r")).length,
    0,
    "no coordinator run starts while every slot is busy",
  );
  assert.deepEqual(t.linear.comments, [], "no write goes out");
  assert.deepEqual(t.linear.moves, [], "no issue moves");
  assert.ok(
    t.logs.some((line) => line.includes("no run slot for the review decision")),
    t.logs.join("\n"),
  );

  // A restart with the slot free runs the decision and settles the round.
  store.state.inFlight = [];
  const next = fakeAdapter();
  const second = setup({ config, adapter: next, linear: fx.linear, store });
  await second.loop.tick();

  assert.ok(
    second.linear.moves.some((move) => move.key === fx.part.key && move.state === "Ready"),
    "the freed slot lets the round settle",
  );
  assert.deepEqual(store.state.reviewFailures, { [fx.part.id]: 1 });
  assert.equal(
    next.tasks.filter((task) => task.id.includes("-review-decision-r")).length,
    1,
    "the coordinator runs once a slot is free",
  );
  next.pending.at(-1)?.finish("cancelled");
  await second.loop.idle();
});

test("no coordinator harness keeps the review round pending with no writes (MET-243)", async () => {
  const fx = reviewFixture({ withQa: false });
  const blocking: ReviewFinding = {
    file: "src/api.ts",
    line: 12,
    severity: "blocking",
    kind: "code",
    text: "The loop reads the file on every tick.",
  };
  fx.state.pendingReviewSettle = {
    [fx.part.id]: {
      partId: fx.part.id,
      partKey: fx.part.key,
      parentId: fx.parent.id,
      prNumber: 7,
      prUrl: "https://github.test/o/r/pull/7",
      head: "sha7",
      verdict: "changes_requested",
      findings: [blocking],
      done: [],
    },
  };
  const store = memoryStore(fx.state);
  const t = setup({ config: ONE_AT_A_TIME, linear: fx.linear, store, extra: { adapters: {} } });

  await t.loop.tick();

  assert.equal(fx.part.state, "In Review", "the round waits, nothing is sent back");
  assert.ok(store.state.pendingReviewSettle?.[fx.part.id], "the settlement stays pending");
  assert.equal(
    store.state.pendingReviewSettle?.[fx.part.id]?.decision,
    undefined,
    "no fallback decision is saved",
  );
  assert.deepEqual(t.linear.comments, [], "no comment goes out");
  assert.deepEqual(t.linear.moves, [], "no issue moves");
  assert.deepEqual(t.pings, [], "no notice goes out");

  // The next run has the harness back: the saved round is decided and settled once.
  const next = fakeAdapter();
  const secondSetup = setup({ config: ONE_AT_A_TIME, adapter: next, linear: fx.linear, store });
  await secondSetup.loop.tick();

  assert.ok(
    secondSetup.linear.moves.some((move) => move.key === fx.part.key && move.state === "Ready"),
    "the round settles once a coordinator can run",
  );
  assert.equal(
    store.state.pendingReviewSettle?.[fx.part.id],
    undefined,
    "the record goes when the settle finishes",
  );
  assert.match(
    fx.linear.comments.filter((comment) => comment.key === fx.parent.key).at(-1)?.body ?? "",
    /: fix/,
  );
  next.pending.at(-1)?.finish("cancelled");
  await secondSetup.loop.idle();
});

test("an upgrade finishes a legacy escalation without posting its comment twice (MET-243)", async () => {
  const fx = reviewFixture({ withQa: false });
  const blocking: ReviewFinding = {
    file: "src/shape.ts",
    line: 4,
    severity: "blocking",
    kind: "design",
    text: "This belongs in the review module, not the loop.",
  };
  const legacyComment = "**harnessd review**: the review found 1 blocking design finding.";
  // The old daemon posted the escalation comment, then its parent move timed out.
  await fx.linear.comment(fx.parent.id, legacyComment);
  fx.state.reviewerHeads = {
    [fx.part.id]: {
      sha: "sha7",
      verdict: "changes_requested",
      findings: [blocking],
      at: "2026-11-27T10:00:00.000Z",
    },
  };
  fx.state.pendingReview = {
    [fx.part.id]: {
      partId: fx.part.id,
      partKey: fx.part.key,
      parentId: fx.parent.id,
      prNumber: 7,
      prUrl: "https://github.test/o/r/pull/7",
      head: "sha7",
      body: "**harnessd review**: changes requested.",
      verdict: "changes_requested",
      findings: [blocking],
      posted: true,
      done: [`comment on ${fx.parent.key}`],
    },
  };
  const store = memoryStore(fx.state);
  const t = setup({ config: ONE_AT_A_TIME, linear: fx.linear, store });

  await t.loop.tick();

  assert.equal(fx.parent.state, "Needs input", "the legacy escalation finishes");
  assert.equal(fx.part.state, "Needs input");
  assert.equal(
    fx.linear.comments.filter((comment) => comment.key === fx.parent.key).length,
    1,
    "the parent comment is not posted twice",
  );
  assert.equal(
    t.pings.filter((ping) => ping.includes("review needs input after the upgrade")).length,
    1,
    "the remaining notice is sent once",
  );
  assert.equal(
    t.adapter.tasks.filter((task) => task.id.includes("-review-decision-r")).length,
    0,
    "no coordinator runs for a legacy escalation",
  );
  assert.equal(store.state.pendingReview, undefined, "the legacy record is dropped");
  assert.equal(store.state.pendingReviewSettle, undefined, "the settle record is dropped");
});

test("an upgrade keeps a legacy send-back's completed steps and posts no comment twice (MET-243)", async () => {
  const fx = reviewFixture({ withQa: false });
  const blocking: ReviewFinding = {
    file: "src/api.ts",
    line: 12,
    severity: "blocking",
    kind: "code",
    text: "The loop reads the file on every tick.",
  };
  const legacyComment = "**harnessd review**: changes requested on PR #7.";
  // The old daemon posted the part comment, then its Ready move timed out.
  await fx.linear.comment(fx.part.id, legacyComment);
  fx.state.reviewerHeads = {
    [fx.part.id]: {
      sha: "sha7",
      verdict: "changes_requested",
      findings: [blocking],
      at: "2026-11-27T10:00:00.000Z",
    },
  };
  fx.state.pendingReview = {
    [fx.part.id]: {
      partId: fx.part.id,
      partKey: fx.part.key,
      parentId: fx.parent.id,
      prNumber: 7,
      prUrl: "https://github.test/o/r/pull/7",
      head: "sha7",
      body: "**harnessd review**: changes requested.",
      verdict: "changes_requested",
      findings: [blocking],
      posted: true,
      done: [`comment on ${fx.part.key}`],
    },
  };
  const store = memoryStore(fx.state);
  const t = setup({ config: ONE_AT_A_TIME, linear: fx.linear, store });

  await t.loop.tick();

  assert.ok(
    t.linear.moves.some((move) => move.key === fx.part.key && move.state === "Ready"),
    "the send-back finishes",
  );
  assert.equal(
    fx.linear.comments.filter((comment) => comment.key === fx.part.key).length,
    1,
    "the completed part comment is not posted again",
  );
  assert.equal(store.state.reviewFailures[fx.part.id], 1, "the round counts once");
  assert.equal(store.state.qaFeedback[fx.part.id]?.source, "review");
  t.adapter.pending.at(-1)?.finish("cancelled");
  await t.loop.idle();
});

test("an upgrade finishes a legacy send-back as fix even when the coordinator would escalate (MET-243)", async () => {
  const fx = reviewFixture({ withQa: false });
  const blocking: ReviewFinding = {
    file: "src/api.ts",
    line: 12,
    severity: "blocking",
    kind: "code",
    text: "The loop reads the file on every tick.",
  };
  await fx.linear.comment(fx.part.id, "**harnessd review**: changes requested on PR #7.");
  fx.state.reviewerHeads = {
    [fx.part.id]: {
      sha: "sha7",
      verdict: "changes_requested",
      findings: [blocking],
      at: "2026-11-27T10:00:00.000Z",
    },
  };
  fx.state.pendingReview = {
    [fx.part.id]: {
      partId: fx.part.id,
      partKey: fx.part.key,
      parentId: fx.parent.id,
      prNumber: 7,
      prUrl: "https://github.test/o/r/pull/7",
      head: "sha7",
      body: "**harnessd review**: changes requested.",
      verdict: "changes_requested",
      findings: [blocking],
      posted: true,
      done: [`comment on ${fx.part.key}`],
    },
  };
  const adapter = fakeAdapter({
    reviewDecision: JSON.stringify({
      decision: "escalate",
      trigger: "money",
      question: "May it spend the paid seat?",
      options: ["Spend it", "Re-plan"],
      recommendation: "Re-plan.",
    }),
  });
  const store = memoryStore(fx.state);
  const t = setup({ config: ONE_AT_A_TIME, adapter, linear: fx.linear, store });

  await t.loop.tick();

  assert.ok(
    t.linear.moves.some((move) => move.key === fx.part.key && move.state === "Ready"),
    "the promised Ready move still happens",
  );
  assert.ok(
    !t.linear.moves.some((move) => move.state === "Needs input"),
    "an escalate reply cannot move a started legacy send-back",
  );
  assert.equal(
    t.adapter.tasks.filter((task) => task.id.includes("-review-decision-r")).length,
    0,
    "no coordinator run answers a legacy send-back",
  );
  assert.match(
    fx.linear.comments.filter((comment) => comment.key === fx.parent.key).at(-1)?.body ?? "",
    /: fix/,
    "the parent comment records a fix round",
  );
  assert.equal(store.state.qaFeedback[fx.part.id]?.source, "review");
  assert.equal(store.state.pendingReview, undefined);
  assert.equal(store.state.pendingReviewSettle, undefined);
  t.adapter.pending.at(-1)?.finish("cancelled");
  await t.loop.idle();
});

test("an upgrade finishes a legacy send-back's Ready move with no coordinator harness (MET-243)", async () => {
  const fx = reviewFixture({ withQa: false });
  const blocking: ReviewFinding = {
    file: "src/api.ts",
    line: 12,
    severity: "blocking",
    kind: "code",
    text: "The loop reads the file on every tick.",
  };
  await fx.linear.comment(fx.part.id, "**harnessd review**: changes requested on PR #7.");
  fx.state.reviewerHeads = {
    [fx.part.id]: {
      sha: "sha7",
      verdict: "changes_requested",
      findings: [blocking],
      at: "2026-11-27T10:00:00.000Z",
    },
  };
  fx.state.pendingReview = {
    [fx.part.id]: {
      partId: fx.part.id,
      partKey: fx.part.key,
      parentId: fx.parent.id,
      prNumber: 7,
      prUrl: "https://github.test/o/r/pull/7",
      head: "sha7",
      body: "**harnessd review**: changes requested.",
      verdict: "changes_requested",
      findings: [blocking],
      posted: true,
      done: [`comment on ${fx.part.key}`],
    },
  };
  const store = memoryStore(fx.state);
  const t = setup({ config: ONE_AT_A_TIME, linear: fx.linear, store, extra: { adapters: {} } });

  await t.loop.tick();

  assert.ok(
    t.linear.moves.some((move) => move.key === fx.part.key && move.state === "Ready"),
    "the Ready move finishes with no coordinator harness",
  );
  assert.equal(
    fx.linear.comments.filter((comment) => comment.key === fx.part.key).length,
    1,
    "the completed part comment is not posted again",
  );
  assert.equal(store.state.reviewFailures[fx.part.id], 1, "the round counts once");
  assert.equal(store.state.qaFeedback[fx.part.id]?.source, "review");
  assert.equal(store.state.pendingReview, undefined);
  assert.equal(store.state.pendingReviewSettle, undefined);
});

test("a failed save blocks the escalation writes and the retry decides again (MET-232)", async () => {
  const fx = reviewFixture({ withQa: false });
  const memory = memoryStore(fx.state);
  let failEscalationSave = false;
  const store: LoopStore = {
    load: () => memory.load(),
    async save(next) {
      if (failEscalationSave && next.pendingReviewSettle?.[fx.part.id]?.escalation !== undefined) {
        failEscalationSave = false;
        throw new Error("state write failed");
      }
      await memory.save(next);
    },
  };
  const t = setup({ config: ONE_AT_A_TIME, linear: fx.linear, store });
  t.gh.open(fx.part.key, 7);

  await t.loop.tick();
  t.adapter.pending[0]?.finish("timeout", "budget of 1000ms exceeded");
  await t.loop.idle();
  assert.equal(fx.part.state, "In Review", "the first timeout re-queues the same head");

  failEscalationSave = true;
  assert.deepEqual((await t.loop.tick()).dispatched, [fx.part.key], "the same head reviews again");
  t.adapter.pending.at(-1)?.finish("timeout", "budget of 1000ms exceeded");
  await t.loop.idle();

  assert.equal(fx.parent.state, "In Progress", "the failed save blocks the parent move");
  assert.equal(fx.part.state, "In Review", "the failed save blocks the part move");
  assert.equal(fx.linear.comments.length, 0, "no comment goes out before the decision is durable");
  assert.equal(t.pings.length, 0, "no notice goes out");
  const saved = await store.load();
  assert.equal(saved.pendingReviewSettle?.[fx.part.id]?.escalation, undefined, "not durable");
  assert.equal(saved.pendingReviewSettle?.[fx.part.id]?.notJudged, "timeout", "the record waits");

  await t.loop.tick();

  assert.equal(fx.parent.state, "Needs input", "the retry escalates after the save succeeds");
  assert.equal(fx.part.state, "Needs input");
  assert.equal(
    fx.linear.comments.filter((comment) => comment.key === fx.parent.key).length,
    1,
    "the parent comment is posted once",
  );
  assert.equal(
    t.pings.filter((ping) => ping.includes("review not judged twice")).length,
    1,
    "the notice is sent once",
  );
  assert.equal((await store.load()).pendingReviewSettle, undefined, "the record goes when done");
});

test("a blocking code finding sends the part back and the next run resumes the builder (MET-225, D-046)", async () => {
  const fx = reviewFixture({ withQa: false });
  fx.part.description += "\n\n**Verify**\n- `pnpm test` → exit 0";
  const state = fx.state;
  state.sessions = {
    [fx.part.id]: {
      harness: "claude-code",
      sessionId: "sess-1",
      worktree: `/wt/${fx.part.key}`,
      branch: fx.part.key.toLowerCase(),
      at: "2026-11-27T10:00:00.000Z",
    },
  };
  const adapter = fakeAdapter({ canResume: true });
  const store = memoryStore(state);
  const t = setup({ config: ONE_AT_A_TIME, adapter, linear: fx.linear, store });
  t.gh.open(fx.part.key, 7);
  await t.loop.tick();

  const blocking: ReviewFinding = {
    file: "src/api.ts",
    line: 12,
    severity: "blocking",
    kind: "code",
    text: "The loop reads the file on every tick.",
  };
  t.adapter.pending[0]?.finish(
    "ok",
    undefined,
    JSON.stringify({ decision: "changes_requested", findings: [blocking] }),
  );
  await t.loop.idle();

  assert.equal(fx.part.state, "Ready", "a blocking code finding sends the part back");
  assert.deepEqual(store.state.reviewFailures, { [fx.part.id]: 1 });
  assert.deepEqual(store.state.qaFeedback[fx.part.id], {
    source: "review",
    prUrl: "https://github.test/o/r/pull/7",
    reviewUrl: "https://github.test/o/r/pull/7#review-1",
    failing: ["R1 (src/api.ts:12) The loop reads the file on every tick."],
    hints: [{ id: "R1", hint: "Fix R1." }],
  });
  assert.match(
    t.linear.comments.at(-1)?.body ?? "",
    /- R1 \(src\/api\.ts:12\) The loop reads the file on every tick\./,
  );

  assert.deepEqual((await t.loop.tick()).dispatched, [fx.part.key], "the builder runs next");
  const run = t.adapter.runs().at(-1);
  assert.equal(run?.id, `${fx.part.key}-1`);
  assert.equal(run?.resumeSessionId, "sess-1", "the builder's own session resumes");
  assert.match(run?.prompt ?? "", /R1 \(src\/api\.ts:12\)/);
  assert.match(run?.prompt ?? "", /Fix only these findings/);
  assert.match(run?.prompt ?? "", /Run each command before you finish:\n- `pnpm test` → exit 0/);
  assert.match(run?.prompt ?? "", /Do not commit, push or open a PR/);
  t.adapter.pending.at(-1)?.finish("ok");
  await t.loop.idle();
});

test("a re-review checks only the saved findings and sends back only the open one (MET-234, D-061)", async () => {
  const root = await mkdtemp(join(tmpdir(), "harnessd-rereview-"));
  roots.push(root);
  const repo = join(root, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo], { timeout: TEST_GIT_TIMEOUT_MS });
  await writeFile(join(repo, "README.md"), "hi\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  const branch = "met-234-api";
  git(repo, "checkout", "-q", "-b", branch);
  await writeFile(join(repo, "api.ts"), "export const cache = [];\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "round 1");
  const sha7 = git(repo, "rev-parse", "HEAD");
  await writeFile(join(repo, "api.ts"), "export const cache = new Map();\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "round 2");
  const sha8 = git(repo, "rev-parse", "HEAD");
  const worktrees = createGitWorktrees({ repoDir: repo, root: join(root, "worktrees") });

  const linear = new FakeLinear();
  const parent = linear.add({ title: "P", state: "In Progress", description: BODY("M") });
  const part = linear.add({
    title: "API",
    parentId: parent.id,
    state: "In Review",
    description: [
      partMarker("backend"),
      "",
      "**Goal**",
      "Ship the API.",
      "",
      "**Done when**",
      "- [ ] Works",
      "",
      "**Size**: S",
    ].join("\n"),
  });
  const state = emptyLoopState();
  state.splits = {
    [parent.id]: {
      key: parent.key,
      parts: [part.id],
      qa: "qa-1",
      at: "2026-11-23T10:00:00.000Z",
    },
  };
  state.shipped = {
    [part.id]: {
      key: part.key,
      branch,
      prUrl: "https://github.test/o/r/pull/7",
      at: "2026-11-23T10:01:00.000Z",
    },
  };
  const blocking: ReviewFinding = {
    file: "api.ts",
    line: 1,
    severity: "blocking",
    kind: "code",
    text: "The cache grows without a limit.",
  };
  state.reviewerHeads = {
    [part.id]: {
      sha: sha7,
      verdict: "changes_requested",
      findings: [blocking],
      at: "2026-11-27T10:00:00.000Z",
    },
  };
  state.reviewFailures = { [part.id]: 1 };
  const config = mergeLayers([
    {
      scope: "workspace",
      dir: "/repo/.harnessd",
      settings: { limits: { max_concurrent: 1, qa_max_failures: 3 } },
      agents: {},
      rules: [],
      skills: [],
      mcp: {},
      skillSettings: {},
    },
  ]);
  const store = memoryStore(state);
  const t = setup({ config, linear, worktrees, store });
  const opened = t.gh.open(part.key, 7, branch);
  opened.headRefOid = sha8;

  assert.deepEqual((await t.loop.tick()).dispatched, [part.key]);
  let pending = t.adapter.pending[0];
  for (let i = 0; i < 200 && pending === undefined; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    pending = t.adapter.pending[0];
  }
  assert.ok(pending, "the re-review run started");
  const run = pending.task;
  assert.match(run.prompt, /## Delta since the last review/, "the re-review prompt");
  assert.match(run.prompt, /R1 \(api\.ts:1\) The cache grows without a limit\./);
  assert.match(
    run.prompt,
    /Raise a new blocking finding only for code in the delta that breaks a named Done-when item/,
  );
  assert.doesNotMatch(run.prompt, /src\/x\.ts/, "the full PR diff is left out");
  assert.doesNotMatch(run.prompt, /## Senior-dev rubric/, "the rubric is left out");

  pending.finish(
    "ok",
    undefined,
    JSON.stringify({
      decision: "changes_requested",
      saved: [{ id: "R1", fixed: false, evidence: "The cache is still unbounded." }],
      findings: [],
    }),
  );
  await t.loop.idle();

  assert.equal(part.state, "Ready", "the part is sent back");
  assert.equal(store.state.reviewFailures[part.id], 2, "the re-review counts one failure");
  assert.deepEqual(store.state.qaFeedback[part.id]?.failing, [
    "R1 (api.ts:1) The cache grows without a limit. (not fixed: The cache is still unbounded.)",
  ]);
  assert.equal(store.state.reviewerHeads?.[part.id]?.sha, sha8, "the new head is saved");
  assert.deepEqual(store.state.reviewerHeads?.[part.id]?.findings, [
    { ...blocking, evidence: "The cache is still unbounded." },
  ]);
  assert.match(
    t.gh.reviews.at(-1)?.body ?? "",
    /R1 \(api\.ts:1\): not fixed: The cache is still unbounded\./,
  );
});

test("a re-review with no readable delta falls back to the full review (MET-234, D-061)", async () => {
  const fx = reviewFixture({ withQa: false });
  const blocking: ReviewFinding = {
    file: "src/api.ts",
    line: 12,
    severity: "blocking",
    kind: "code",
    text: "The loop reads the file on every tick.",
  };
  fx.state.reviewerHeads = {
    [fx.part.id]: {
      sha: "sha7",
      verdict: "changes_requested",
      findings: [blocking],
      at: "2026-11-27T10:00:00.000Z",
    },
  };
  fx.state.reviewFailures = { [fx.part.id]: 1 };
  const t = setup({ config: ONE_AT_A_TIME, linear: fx.linear, store: memoryStore(fx.state) });
  const opened = t.gh.open(fx.part.key, 7);
  opened.headRefOid = "sha8";

  assert.deepEqual((await t.loop.tick()).dispatched, [fx.part.key]);
  const pending = await nextRun(t.adapter);
  assert.match(pending.task.prompt, /## Diff/, "the full review keeps the full diff");
  assert.match(pending.task.prompt, /## Earlier blocking findings \(1\)/);
  assert.match(pending.task.prompt, /src\/api\.ts:12/, "the earlier finding is listed");
  assert.ok(
    t.logs.includes(`${fx.part.key}: no review delta, full review`),
    "the fallback is logged once",
  );

  pending.finish("ok", undefined, JSON.stringify({ decision: "approve", findings: [] }));
  await t.loop.idle();
  assert.equal(t.gh.reviews.at(-1)?.commitId, "sha8");
});

test("an escalated review's moved head gets a full first review, not a delta (MET-234, D-061)", async () => {
  const root = await mkdtemp(join(tmpdir(), "harnessd-rereview-escalated-"));
  roots.push(root);
  const repo = join(root, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo], { timeout: TEST_GIT_TIMEOUT_MS });
  await writeFile(join(repo, "README.md"), "hi\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  const branch = "met-234-escalated";
  git(repo, "checkout", "-q", "-b", branch);
  await writeFile(join(repo, "api.ts"), "export const cache = [];\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "round 1");
  const sha7 = git(repo, "rev-parse", "HEAD");
  await writeFile(join(repo, "api.ts"), "export const cache = new Map();\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "round 2");
  const sha8 = git(repo, "rev-parse", "HEAD");
  const worktrees = createGitWorktrees({ repoDir: repo, root: join(root, "worktrees") });

  const linear = new FakeLinear();
  const parent = linear.add({ title: "P", state: "In Progress", description: BODY("M") });
  const part = linear.add({
    title: "API",
    parentId: parent.id,
    state: "In Review",
    description: [
      partMarker("backend"),
      "",
      "**Goal**",
      "Ship the API.",
      "",
      "**Done when**",
      "- [ ] Works",
      "",
      "**Size**: S",
    ].join("\n"),
  });
  const state = emptyLoopState();
  state.splits = {
    [parent.id]: {
      key: parent.key,
      parts: [part.id],
      qa: "qa-1",
      at: "2026-11-23T10:00:00.000Z",
    },
  };
  state.shipped = {
    [part.id]: {
      key: part.key,
      branch,
      prUrl: "https://github.test/o/r/pull/7",
      at: "2026-11-23T10:01:00.000Z",
    },
  };
  const blocking: ReviewFinding = {
    file: "api.ts",
    line: 1,
    severity: "blocking",
    kind: "code",
    text: "The cache grows without a limit.",
  };
  state.reviewerHeads = {
    [part.id]: {
      sha: sha7,
      verdict: "changes_requested",
      findings: [blocking],
      at: "2026-11-27T10:00:00.000Z",
    },
  };
  // The escalation deleted the failure count; a human moved the part back to In Review.
  const config = mergeLayers([
    {
      scope: "workspace",
      dir: "/repo/.harnessd",
      settings: { limits: { max_concurrent: 1 } },
      agents: {},
      rules: [],
      skills: [],
      mcp: {},
      skillSettings: {},
    },
  ]);
  const t = setup({ config, linear, worktrees, store: memoryStore(state) });
  const opened = t.gh.open(part.key, 7, branch);
  opened.headRefOid = sha8;

  assert.deepEqual((await t.loop.tick()).dispatched, [part.key]);
  let pending = t.adapter.pending[0];
  for (let i = 0; i < 200 && pending === undefined; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    pending = t.adapter.pending[0];
  }
  assert.ok(pending, "the review run started");
  assert.match(pending.task.prompt, /## Diff/, "the full diff is used");
  assert.match(pending.task.prompt, /src\/x\.ts/, "the full PR diff, not the old delta");
  assert.doesNotMatch(pending.task.prompt, /## Delta since the last review/);
  assert.doesNotMatch(
    pending.task.prompt,
    /## Earlier blocking findings/,
    "the escalated head is not passed as since",
  );

  pending.finish("ok", undefined, JSON.stringify({ decision: "approve", findings: [] }));
  await t.loop.idle();
});

test("the review after a fix round is still a re-review (MET-243, D-061)", async () => {
  const root = await mkdtemp(join(tmpdir(), "harnessd-rereview-fix-"));
  roots.push(root);
  const repo = join(root, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo], { timeout: TEST_GIT_TIMEOUT_MS });
  await writeFile(join(repo, "README.md"), "hi\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  const branch = "met-243-api";
  git(repo, "checkout", "-q", "-b", branch);
  await writeFile(join(repo, "api.ts"), "export const cache = [];\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "round 1");
  const sha7 = git(repo, "rev-parse", "HEAD");
  await writeFile(join(repo, "api.ts"), "export const cache = new Map();\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "round 2");
  const sha8 = git(repo, "rev-parse", "HEAD");
  const worktrees = createGitWorktrees({ repoDir: repo, root: join(root, "worktrees") });

  const linear = new FakeLinear();
  const parent = linear.add({ title: "P", state: "In Progress", description: BODY("M") });
  const part = linear.add({
    title: "API",
    parentId: parent.id,
    state: "In Review",
    description: [
      partMarker("backend"),
      "",
      "**Goal**",
      "Ship the API.",
      "",
      "**Done when**",
      "- [ ] Works",
      "",
      "**Size**: S",
    ].join("\n"),
  });
  const state = emptyLoopState();
  state.splits = {
    [parent.id]: {
      key: parent.key,
      parts: [part.id],
      qa: "qa-1",
      at: "2026-11-23T10:00:00.000Z",
    },
  };
  state.shipped = {
    [part.id]: {
      key: part.key,
      branch,
      prUrl: "https://github.test/o/r/pull/7",
      at: "2026-11-23T10:01:00.000Z",
    },
  };
  const blocking: ReviewFinding = {
    file: "api.ts",
    line: 1,
    severity: "blocking",
    kind: "code",
    text: "The cache grows without a limit.",
  };
  // What a fix send-back leaves: the saved finding at the old head, one counted failure and
  // the builder's new head (MET-243).
  state.reviewerHeads = {
    [part.id]: {
      sha: sha7,
      verdict: "changes_requested",
      findings: [blocking],
      at: "2026-11-27T10:00:00.000Z",
    },
  };
  state.reviewFailures = { [part.id]: 1 };
  const config = mergeLayers([
    {
      scope: "workspace",
      dir: "/repo/.harnessd",
      settings: { limits: { max_concurrent: 1 } },
      agents: {},
      rules: [],
      skills: [],
      mcp: {},
      skillSettings: {},
    },
  ]);
  const t = setup({ config, linear, worktrees, store: memoryStore(state) });
  const opened = t.gh.open(part.key, 7, branch);
  opened.headRefOid = sha8;

  assert.deepEqual((await t.loop.tick()).dispatched, [part.key]);
  let pending = t.adapter.pending[0];
  for (let i = 0; i < 200 && pending === undefined; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    pending = t.adapter.pending[0];
  }
  assert.ok(pending, "the review run started");
  assert.match(pending.task.prompt, /## Delta since the last review/, "still a re-review");
  assert.match(pending.task.prompt, /## Saved findings \(1\)/);
  assert.match(pending.task.prompt, /R1 \(api\.ts:1\) The cache grows without a limit\./);
  assert.doesNotMatch(pending.task.prompt, /## Senior-dev rubric/);

  pending.finish("cancelled");
  await t.loop.idle();
});

test("a nit never sends a part back (MET-225)", async () => {
  const fx = reviewFixture({ withQa: false });
  const store = memoryStore(fx.state);
  const t = setup({ config: ONE_AT_A_TIME, linear: fx.linear, store });
  t.gh.open(fx.part.key, 7);
  await t.loop.tick();

  const nit: ReviewFinding = {
    file: "src/api.ts",
    line: 9,
    severity: "nit",
    kind: "design",
    text: "The name hides the seam.",
  };
  t.adapter.pending[0]?.finish(
    "ok",
    undefined,
    JSON.stringify({ decision: "approve", findings: [nit] }),
  );
  await t.loop.idle();

  assert.equal(fx.part.state, "In Review", "an approve with a nit leaves the part alone");
  assert.equal(store.state.qaFeedback[fx.part.id], undefined);
  assert.equal(store.state.reviewFailures[fx.part.id], undefined);
  assert.deepEqual((await t.loop.tick()).dispatched, [], "no builder run starts");
});

test("a blocking design finding is sent back as a fix with the coordinator's hint (MET-243, D-059)", async () => {
  const fx = reviewFixture({ withQa: false });
  fx.part.description += "\n\n**Verify**\n- `pnpm test` → exit 0";
  fx.state.sessions = {
    [fx.part.id]: {
      harness: "claude-code",
      sessionId: "sess-1",
      worktree: `/wt/${fx.part.key}`,
      branch: fx.part.key.toLowerCase(),
      at: "2026-11-27T10:00:00.000Z",
    },
  };
  const adapter = fakeAdapter({
    canResume: true,
    reviewDecision: JSON.stringify({
      decision: "fix",
      findings: [{ id: "R1", hint: "Move the design into the review module." }],
    }),
  });
  const store = memoryStore(fx.state);
  const t = setup({ config: ONE_AT_A_TIME, adapter, linear: fx.linear, store });
  t.gh.open(fx.part.key, 7);
  await t.loop.tick();

  const design: ReviewFinding = {
    file: "src/shape.ts",
    line: 4,
    severity: "blocking",
    kind: "design",
    text: "This belongs in the review module, not the loop.",
  };
  t.adapter.pending[0]?.finish(
    "ok",
    undefined,
    JSON.stringify({ decision: "changes_requested", findings: [design] }),
  );
  await t.loop.idle();

  assert.equal(fx.part.state, "Ready", "the coordinator's fix sends the part back");
  assert.equal(store.state.reviewFailures[fx.part.id], 1);
  assert.deepEqual(store.state.qaFeedback[fx.part.id], {
    source: "review",
    prUrl: "https://github.test/o/r/pull/7",
    reviewUrl: "https://github.test/o/r/pull/7#review-1",
    failing: ["R1 (src/shape.ts:4) This belongs in the review module, not the loop."],
    hints: [{ id: "R1", hint: "Move the design into the review module." }],
  });
  const parentComment = t.linear.comments.filter((c) => c.key === fx.parent.key).at(-1)?.body ?? "";
  assert.match(parentComment, /round 1 of 6 on .* PR #7: fix/);
  assert.match(parentComment, /R1 \(src\/shape\.ts:4\) This belongs in the review module/);
  assert.match(parentComment, /hint: Move the design into the review module\./);

  assert.deepEqual((await t.loop.tick()).dispatched, [fx.part.key], "the builder resumes next");
  const run = t.adapter.runs().at(-1);
  assert.equal(run?.resumeSessionId, "sess-1", "the builder's own session resumes");
  assert.match(run?.prompt ?? "", /R1 \(src\/shape\.ts:4\)/);
  assert.match(run?.prompt ?? "", /hint: Move the design into the review module\./);
  t.adapter.pending.at(-1)?.finish("ok");
  await t.loop.idle();
});

test("review round 6 at limits.max_review_rounds escalates with no coordinator run (MET-244, D-062)", async () => {
  const fx = reviewFixture({ withQa: false });
  fx.state.reviewFailures = { [fx.part.id]: 5 };
  fx.state.qaFeedback = {
    [fx.part.id]: { source: "review", failing: ["R1 (src/old.ts:1) Still open."] },
  };
  const adapter = fakeAdapter({
    reviewDecision: JSON.stringify({
      decision: "fix",
      findings: [{ id: "R1", hint: "This must not run at the cap." }],
    }),
  });
  const store = memoryStore(fx.state);
  const t = setup({ config: ONE_AT_A_TIME, adapter, linear: fx.linear, store });
  t.gh.open(fx.part.key, 7);
  await t.loop.tick();

  const blocking: ReviewFinding = {
    file: "src/api.ts",
    line: 12,
    severity: "blocking",
    kind: "code",
    text: "The loop reads the file on every tick.",
  };
  t.adapter.pending[0]?.finish(
    "ok",
    undefined,
    JSON.stringify({ decision: "changes_requested", findings: [blocking] }),
  );
  await t.loop.idle();

  assert.equal(fx.part.state, "Needs input");
  assert.equal(fx.parent.state, "Needs input");
  assert.equal(store.state.reviewFailures[fx.part.id], undefined, "the count is cleared");
  assert.equal(store.state.qaFeedback[fx.part.id], undefined, "the review feedback is cleared");
  assert.equal(
    t.adapter.tasks.filter((task) => task.id.includes("-review-decision-r")).length,
    0,
    "no coordinator run starts at the round cap",
  );
  const parentComment = t.linear.comments.filter((c) => c.key === fx.parent.key).at(-1)?.body ?? "";
  assert.match(
    parentComment,
    /round 6 of 6 on .* \[PR #7\]\(https:\/\/github\.test\/o\/r\/pull\/7\): review round cap reached/,
  );
  assert.match(parentComment, /`limits\.max_review_rounds` \(6\)/);
  assert.match(parentComment, /R1 \(src\/api\.ts:12\) The loop reads the file on every tick\./);
  assert.equal(
    t.pings.filter((ping) => ping.includes("needs input (review round cap reached)")).length,
    1,
    "one notice with the cap reason",
  );
});

test("a D-011 trigger escalates with the question, options and recommendation on the parent (MET-243)", async () => {
  const fx = reviewFixture({ withQa: false });
  const adapter = fakeAdapter({
    reviewDecision: JSON.stringify({
      decision: "escalate",
      trigger: "public_api_data_model_or_protected_path",
      question: "May the part change the public API of the review module?",
      options: ["Change the public API", "Keep it internal and re-plan"],
      recommendation: "Keep it internal and re-plan the part.",
    }),
  });
  const store = memoryStore(fx.state);
  const t = setup({ config: ONE_AT_A_TIME, adapter, linear: fx.linear, store });
  t.gh.open(fx.part.key, 7);
  await t.loop.tick();

  const design: ReviewFinding = {
    file: "src/shape.ts",
    line: 4,
    severity: "blocking",
    kind: "design",
    text: "This belongs in the review module, not the loop.",
  };
  t.adapter.pending[0]?.finish(
    "ok",
    undefined,
    JSON.stringify({ decision: "changes_requested", findings: [design] }),
  );
  await t.loop.idle();

  assert.equal(fx.part.state, "Needs input");
  assert.equal(fx.parent.state, "Needs input");
  assert.equal(store.state.qaFeedback[fx.part.id], undefined, "nothing goes to the builder");
  assert.equal(store.state.reviewFailures[fx.part.id], undefined, "the escalation clears it");
  const comments = t.linear.comments.filter((c) => c.key === fx.parent.key);
  assert.equal(comments.length, 1, "one parent comment");
  const body = comments[0]?.body ?? "";
  assert.match(body, /escalate \(`public_api_data_model_or_protected_path`\)/);
  assert.match(body, /Trigger: changes a public API, the data model or a protected path/);
  assert.match(body, /Question: May the part change the public API of the review module\?/);
  assert.match(body, /- Change the public API\n- Keep it internal and re-plan/);
  assert.match(body, /Recommendation: Keep it internal and re-plan the part\./);
  assert.equal(
    t.pings.filter((ping) =>
      ping.includes("needs a human (public_api_data_model_or_protected_path)"),
    ).length,
    1,
    "one notice",
  );
});

test("an escalation without a D-011 trigger is sent back as fix (MET-243)", async () => {
  const fx = reviewFixture({ withQa: false });
  const adapter = fakeAdapter({
    reviewDecision: JSON.stringify({ decision: "escalate" }),
  });
  const store = memoryStore(fx.state);
  const t = setup({ config: ONE_AT_A_TIME, adapter, linear: fx.linear, store });
  t.gh.open(fx.part.key, 7);
  await t.loop.tick();

  const blocking: ReviewFinding = {
    file: "src/api.ts",
    line: 12,
    severity: "blocking",
    kind: "code",
    text: "The loop reads the file on every tick.",
  };
  t.adapter.pending[0]?.finish(
    "ok",
    undefined,
    JSON.stringify({ decision: "changes_requested", findings: [blocking] }),
  );
  await t.loop.idle();

  assert.equal(fx.part.state, "Ready", "no trigger means a fix send-back");
  assert.equal(store.state.reviewFailures[fx.part.id], 1);
  assert.ok(
    t.logs.some((line) => line.includes("escalation without a D-011 trigger, sent back as fix")),
    t.logs.join("\n"),
  );
});

test("an invalid coordinator reply is sent back as fix (MET-243)", async () => {
  const fx = reviewFixture({ withQa: false });
  const adapter = fakeAdapter({ reviewDecision: "not a decision" });
  const store = memoryStore(fx.state);
  const t = setup({ config: ONE_AT_A_TIME, adapter, linear: fx.linear, store });
  t.gh.open(fx.part.key, 7);
  await t.loop.tick();

  const blocking: ReviewFinding = {
    file: "src/api.ts",
    line: 12,
    severity: "blocking",
    kind: "code",
    text: "The loop reads the file on every tick.",
  };
  t.adapter.pending[0]?.finish(
    "ok",
    undefined,
    JSON.stringify({ decision: "changes_requested", findings: [blocking] }),
  );
  await t.loop.idle();

  assert.equal(fx.part.state, "Ready", "an unusable reply is still a fix send-back");
  assert.equal(store.state.reviewFailures[fx.part.id], 1);
  assert.equal(store.state.qaFeedback[fx.part.id]?.hints, undefined, "no hints");
  assert.ok(
    t.logs.some((line) => line.includes("review decision failed")),
    t.logs.join("\n"),
  );
});

test("a second failed review asks the coordinator again instead of Needs input (MET-243, D-014)", async () => {
  const fx = reviewFixture({ withQa: false });
  const state = fx.state;
  state.reviewFailures = { [fx.part.id]: 1 };
  const store = memoryStore(state);
  const t = setup({ config: ONE_AT_A_TIME, linear: fx.linear, store });
  t.gh.open(fx.part.key, 7);
  await t.loop.tick();

  const blocking: ReviewFinding = {
    file: "src/api.ts",
    line: 12,
    severity: "blocking",
    kind: "code",
    text: "The loop reads the file on every tick.",
  };
  t.adapter.pending[0]?.finish(
    "ok",
    undefined,
    JSON.stringify({ decision: "changes_requested", findings: [blocking] }),
  );
  await t.loop.idle();

  assert.equal(fx.part.state, "Ready", "the second failure is sent back, not escalated");
  assert.equal(fx.parent.state, "In Progress");
  assert.equal(store.state.reviewFailures[fx.part.id], 2, "the count goes up");
  assert.match(
    t.linear.comments.filter((c) => c.key === fx.parent.key).at(-1)?.body ?? "",
    /round 2 of 6 on .* PR #7: fix/,
  );
});

test("a review run failure that is not a not-judged reason counts one review failure (MET-225, D-014)", async () => {
  const fx = reviewFixture({ withQa: false });
  const store = memoryStore(fx.state);
  const t = setup({ config: ONE_AT_A_TIME, linear: fx.linear, store });
  t.gh.open(fx.part.key, 7);
  await t.loop.tick();

  // Approve with a blocking finding is a schema error, not one of D-052's not-judged cases.
  t.adapter.pending[0]?.finish(
    "ok",
    undefined,
    JSON.stringify({
      decision: "approve",
      findings: [
        {
          file: "src/api.ts",
          line: 12,
          severity: "blocking",
          kind: "code",
          text: "The loop reads the file on every tick.",
        },
      ],
    }),
  );
  await t.loop.idle();

  assert.equal(fx.part.state, "In Review", "the same head is re-queued");
  assert.equal(store.state.reviewerHeads?.[fx.part.id], undefined, "no verdict is recorded");
  assert.deepEqual(store.state.reviewFailures, { [fx.part.id]: 1 });
  assert.deepEqual((await t.loop.tick()).dispatched, [fx.part.key], "the review runs again");
  t.adapter.pending.at(-1)?.finish("cancelled");
  await t.loop.idle();
});

test("a part at Done clears its review failures (MET-225, D-014)", async () => {
  const fx = reviewFixture({ withQa: false });
  fx.state.reviewFailures = { [fx.part.id]: 1 };
  const store = memoryStore(fx.state);
  const t = setup({ config: ONE_AT_A_TIME, linear: fx.linear, store });
  t.gh.open(fx.part.key, 7);
  fx.part.state = "Done";

  await t.loop.tick();

  assert.equal(store.state.reviewFailures[fx.part.id], undefined);
  assert.equal(store.state.shipped?.[fx.part.id], undefined);
});

test("two not-judged reviews on one head go to Needs input with no review failure (MET-225, D-052)", async () => {
  const fx = reviewFixture({ withQa: false });
  const store = memoryStore(fx.state);
  const t = setup({ config: ONE_AT_A_TIME, linear: fx.linear, store });
  t.gh.open(fx.part.key, 7);

  await t.loop.tick();
  t.adapter.pending[0]?.finish("timeout", "budget of 1000ms exceeded");
  await t.loop.idle();

  assert.equal(fx.part.state, "In Review", "the first timeout re-queues the same head");
  assert.equal(store.state.reviewerHeads?.[fx.part.id], undefined);
  assert.equal(store.state.reviewFailures[fx.part.id], undefined, "no review failure counted");
  assert.ok(
    t.logs.includes(`${fx.part.key}: review not judged (timed out), re-queued`),
    t.logs.join("\n"),
  );

  assert.deepEqual((await t.loop.tick()).dispatched, [fx.part.key], "the same head reviews again");
  t.adapter.pending.at(-1)?.finish("timeout", "budget of 1000ms exceeded");
  await t.loop.idle();

  assert.equal(fx.part.state, "Needs input");
  assert.equal(fx.parent.state, "Needs input");
  assert.equal(store.state.reviewFailures[fx.part.id], undefined);
  assert.equal(t.pings.filter((ping) => ping.includes("review not judged twice")).length, 1);
});

test("a new head after a review reads only the sha..head delta (MET-225, D-060)", async () => {
  const root = await mkdtemp(join(tmpdir(), "harnessd-review-delta-"));
  roots.push(root);
  const repo = join(root, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo], { timeout: TEST_GIT_TIMEOUT_MS });
  await writeFile(join(repo, "src.ts"), "export const first = 1;\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "first");
  const base = git(repo, "rev-parse", "HEAD");
  await writeFile(join(repo, "src.ts"), "export const first = 1;\nexport const delta = true;\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "delta");
  const head = git(repo, "rev-parse", "HEAD");

  const fx = reviewFixture({ withQa: false });
  const earlier: ReviewFinding = {
    file: "src/cache.ts",
    line: 42,
    severity: "blocking",
    kind: "code",
    text: "The cache grows without a limit.",
  };
  fx.state.reviewerHeads = {
    [fx.part.id]: {
      sha: base,
      verdict: "approved",
      findings: [earlier],
      at: "2026-11-27T10:00:00.000Z",
    },
  };
  // An approved head that moved gets the delta review (D-060), not a re-review.
  fx.state.reviewFailures = { [fx.part.id]: 1 };
  const worktrees: TaskWorktrees = {
    async create() {
      return { path: join(root, "builder"), branch: "b", resumed: false };
    },
    async checkout() {
      return { path: repo, branch: fx.part.key.toLowerCase(), resumed: false };
    },
    async remove() {
      return { removed: true };
    },
    async recover() {},
  };
  const t = setup({
    config: ONE_AT_A_TIME,
    linear: fx.linear,
    store: memoryStore(fx.state),
    worktrees,
  });
  const pr = t.gh.open(fx.part.key, 7);
  pr.headRefOid = head;

  assert.deepEqual((await t.loop.tick()).dispatched, [fx.part.key]);
  for (let i = 0; i < 100 && t.adapter.pending[0] === undefined; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const run = t.adapter.pending[0]?.task;
  assert.ok(run, "the review starts");
  assert.match(run.prompt, /## Delta since the last review/);
  assert.match(run.prompt, /export const delta = true;/);
  assert.doesNotMatch(run.prompt, /diff --git a\/src\/x\.ts/, "the full PR diff is left out");
  assert.match(run.prompt, /src\/cache\.ts:42/, "earlier blocking findings are listed");
  t.adapter.pending[0]?.finish("cancelled");
  await t.loop.idle();
});

test("a recorded sha that is not an ancestor falls back to the full PR diff (MET-225)", async () => {
  const root = await mkdtemp(join(tmpdir(), "harnessd-review-fallback-"));
  roots.push(root);
  const repo = join(root, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo], { timeout: TEST_GIT_TIMEOUT_MS });
  await writeFile(join(repo, "src.ts"), "export const head = true;\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "head");
  const head = git(repo, "rev-parse", "HEAD");

  const fx = reviewFixture({ withQa: false });
  const earlier: ReviewFinding = {
    file: "src/cache.ts",
    line: 42,
    severity: "blocking",
    kind: "code",
    text: "The cache grows without a limit.",
  };
  fx.state.reviewerHeads = {
    [fx.part.id]: {
      sha: "not-in-this-repo",
      verdict: "approved",
      findings: [earlier],
      at: "2026-11-27T10:00:00.000Z",
    },
  };
  // An approved head that moved still gets the delta attempt and its full-diff fallback.
  fx.state.reviewFailures = { [fx.part.id]: 1 };
  const worktrees: TaskWorktrees = {
    async create() {
      return { path: join(root, "builder"), branch: "b", resumed: false };
    },
    async checkout() {
      return { path: repo, branch: fx.part.key.toLowerCase(), resumed: false };
    },
    async remove() {
      return { removed: true };
    },
    async recover() {},
  };
  const t = setup({
    config: ONE_AT_A_TIME,
    linear: fx.linear,
    store: memoryStore(fx.state),
    worktrees,
  });
  const pr = t.gh.open(fx.part.key, 7);
  pr.headRefOid = head;

  assert.deepEqual((await t.loop.tick()).dispatched, [fx.part.key]);
  for (let i = 0; i < 100 && t.adapter.pending[0] === undefined; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const run = t.adapter.pending[0]?.task;
  assert.ok(run, "the review starts");
  assert.match(run.prompt, /## Diff/);
  assert.doesNotMatch(run.prompt, /## Delta since the last review/);
  assert.match(run.prompt, /diff --git a\/src\/x\.ts/);
  assert.match(run.prompt, /src\/cache\.ts:42/, "earlier blocking findings are still listed");
  t.adapter.pending[0]?.finish("cancelled");
  await t.loop.idle();
});

test("per-part QA reviews only the split record's parts, not an older marked child (MET-217)", async () => {
  const linear = new FakeLinear();
  const parent = linear.add({ title: "P", state: "In Progress", description: BODY("M") });
  const backend = linear.add({
    title: "API",
    parentId: parent.id,
    state: "In Review",
    description: `${partMarker("backend")}\n**Size**: S`,
  });
  const old = linear.add({
    title: "Old API",
    parentId: parent.id,
    state: "In Review",
    description: `${partMarker("backend")}\n**Size**: S`,
  });
  const qa = linear.add({
    title: "QA: P",
    parentId: parent.id,
    description: `${partMarker("qa")}\n**Size**: M`,
  });
  linear.relations.push({ blocker: backend.id, blocked: qa.id });
  const state = emptyLoopState();
  state.splits = {
    [parent.id]: {
      key: parent.key,
      parts: [backend.id],
      qa: qa.id,
      at: "2026-11-23T10:00:00.000Z",
    },
  };
  state.reviewerHeads = {
    [backend.id]: { sha: "sha7", verdict: "approved", findings: [], at: "2026-11-23T10:00:00Z" },
  };
  const t = setup({ linear, store: memoryStore(state) });
  t.gh.open(backend.key, 7);
  t.gh.open(old.key, 8);

  assert.deepEqual((await t.loop.tick()).dispatched, [qa.key]);
  await settle();

  assert.deepEqual(
    t.wt.checkouts.map((c) => [c.title, c.branch]),
    [["pr 7", backend.key.toLowerCase()]],
    "only the record's part is checked out for review",
  );
});

test("a failed QA sends the part back with the review; the second failure escalates once", async () => {
  const t = setup();
  const { parent, backend, qa } = qaFixture(t);
  t.gh.open(backend.key, 7);

  // Round 1: one item fails.
  await t.loop.tick();
  await settle();
  t.adapter.pending[0]?.finish("ok", undefined, verdict(true, false));
  await t.loop.idle();
  assert.equal(t.gh.reviews[0]?.event, "REQUEST_CHANGES");
  assert.match(t.gh.reviews[0]?.body ?? "", /- \[ \] Has tests: evidence 2/);
  assert.equal(backend.state, "Ready");
  assert.equal(qa.state, "Ready");
  assert.match(
    t.linear.comments.find((c) => c.key === backend.key)?.body ?? "",
    /changes requested on \[PR #7\].*review-1.*\n\n- Has tests: evidence 2/s,
  );
  assert.equal(t.memory.state.qaFailures[parent.id], 1);
  assert.deepEqual(t.memory.state.reviewedHeads?.[backend.id], {
    sha: "sha7",
    verdict: "changes_requested",
    cases: [
      {
        id: "C1",
        item: "item 2",
        repro: "pnpm test",
        expected: "it passes",
        actual: "evidence 2",
      },
    ],
  });

  // The part's agent runs again with the review in its prompt, while QA waits.
  const report = await t.loop.tick();
  assert.deepEqual(report.dispatched, [backend.key]);
  const fix = t.adapter.runs().at(-1);
  assert.match(fix?.prompt ?? "", /## QA requested changes/);
  assert.match(
    fix?.prompt ?? "",
    /harnessd pushes your work to the open PR \(https:\/\/github\.test\/o\/r\/pull\/7\) and updates it/,
  );
  t.adapter.pending.at(-1)?.finish("ok");
  await t.loop.idle();
  assert.equal(backend.state, "In Review");
  assert.deepEqual(t.memory.state.qaFeedback, {});
  assert.deepEqual(t.memory.state.reviewedHeads?.[backend.id]?.cases, [
    {
      id: "C1",
      item: "item 2",
      repro: "pnpm test",
      expected: "it passes",
      actual: "evidence 2",
    },
  ]);

  // Round 2: still failing. QA and the parent go to Needs input; nothing goes back.
  assert.deepEqual((await t.loop.tick()).dispatched, [qa.key]);
  await settle();
  assert.match(t.adapter.runs().at(-1)?.id ?? "", /-qa-2-pr7$/);
  t.adapter.pending.at(-1)?.finish("ok", undefined, verdict(false, true));
  await t.loop.idle();
  assert.equal(t.gh.reviews[1]?.event, "REQUEST_CHANGES");
  assert.match(t.gh.reviews[1]?.body ?? "", /round 2 of 2/);
  assert.equal(qa.state, "Needs input");
  assert.equal(parent.state, "Needs input");
  assert.equal(backend.state, "In Review", "not sent back a second time");
  assert.equal(t.linear.comments.filter((c) => c.key === parent.key).length, 1);
  assert.match(t.linear.comments.at(-1)?.body ?? "", /QA failed twice for MET-100/);
  assert.deepEqual(t.pings, [
    `${parent.key} needs input (QA failed twice): ${qa.key} could not approve ${backend.key} PR #7 https://github.test/o/r/pull/7 https://linear.test/${parent.key}`,
  ]);

  const runs = t.adapter.runs().length;
  assert.deepEqual((await t.loop.tick()).dispatched, [], "no more loops");
  assert.equal(t.adapter.runs().length, runs);
  assert.equal(t.pings.length, 1);
});

test("a QA request_changes round sends the part back to its builder and starts no coordinator run", async () => {
  const t = setup();
  const { parent, backend, qa } = qaFixture(t);
  t.gh.open(backend.key, 7);

  // Round 1 fails: the part goes back to its builder, never to the coordinator.
  assert.deepEqual((await t.loop.tick()).dispatched, [qa.key]);
  await settle();
  t.adapter.pending[0]?.finish("ok", undefined, verdict(false, true));
  await t.loop.idle();
  assert.equal(t.memory.state.qaFailures[parent.id], 1);
  assert.equal(backend.state, "Ready");

  const started = t.adapter.tasks.length;
  assert.deepEqual((await t.loop.tick()).dispatched, [backend.key]);
  const next = t.adapter.tasks.slice(started);
  assert.equal(next.length, 1, "only the part's builder starts");
  assert.equal(next[0]?.id, `${backend.key}-1`);
  assert.notEqual(next[0]?.readOnly, true, "the builder keeps full access");
  assert.match(next[0]?.prompt ?? "", /You are backend, the harnessd backend agent\./);
  assert.equal(
    next.filter((task) => /^(grill|plan)-/.test(task.id)).length,
    0,
    "no coordinator run starts on a send-back",
  );
  assert.equal(t.adapter.pending.at(-1)?.cwd, `/wt/${backend.key}`);
  await t.loop.pause();
});

test("a QA failure at qa_max_failures starts no builder or coordinator run", async () => {
  const t = setup();
  const { parent, backend, qa } = qaFixture(t);
  // One more failure reaches the default limit of 2 (D-014).
  t.memory.state.qaFailures[parent.id] = 1;
  t.gh.open(backend.key, 7);

  assert.deepEqual((await t.loop.tick()).dispatched, [qa.key]);
  await settle();
  t.adapter.pending[0]?.finish("ok", undefined, verdict(false, true));
  await t.loop.idle();

  assert.equal(qa.state, "Needs input");
  assert.equal(parent.state, "Needs input");
  assert.equal(backend.state, "In Review", "nothing is sent back at the limit");
  assert.deepEqual(t.memory.state.qaFailures, {}, "the count is cleared on escalation");
  assert.equal(t.adapter.tasks.filter((task) => /^(grill|plan)-/.test(task.id)).length, 0);

  const started = t.adapter.tasks.length;
  assert.deepEqual((await t.loop.tick()).dispatched, []);
  assert.equal(t.adapter.tasks.length, started, "no builder or coordinator run starts");
});

test("a re-QA approves on the saved cases, writes no cases and goes to merges (D-056)", async () => {
  const t = setup();
  const { backend, qa } = qaFixture(t);
  t.gh.open(backend.key, 7);
  t.memory.state.reviewedHeads = {
    [backend.id]: {
      sha: "sha6",
      verdict: "changes_requested",
      cases: [
        { id: "C1", item: "item 1", repro: "pnpm test", expected: "it passes", actual: "not ok 3" },
      ],
    },
  };

  assert.deepEqual((await t.loop.tick()).dispatched, [qa.key]);
  await settle();
  assert.match(t.adapter.runs().at(-1)?.prompt ?? "", /## Saved cases \(1\)/);
  assert.doesNotMatch(t.adapter.runs().at(-1)?.prompt ?? "", /## Diff/);
  t.adapter.pending.at(-1)?.finish(
    "ok",
    undefined,
    JSON.stringify({
      cases: [{ id: "C1", pass: true, evidence: "pnpm test: ok 3" }],
      verify: { pass: true, evidence: "`pnpm test` exited with code 0" },
    }),
  );
  await t.loop.idle();

  assert.equal(t.gh.reviews.at(-1)?.event, "APPROVE");
  assert.match(
    t.gh.reviews.at(-1)?.body ?? "",
    /approved\. Every saved case passes.*\n\n- \[x\] C1 \(item 1\): pass: pnpm test: ok 3/s,
  );
  assert.deepEqual(t.memory.state.reviewedHeads?.[backend.id], {
    sha: "sha7",
    verdict: "approved",
  });
  assert.deepEqual(
    t.memory.state.merges.map((m) => [m.qaKey, m.prs.map((p) => [p.number, p.sha])]),
    [[qa.key, [[7, "sha7"]]]],
  );
  assert.deepEqual(t.memory.state.qaFailures, {});
});

test("a re-QA send-back keeps only the failing case; the second failed re-QA clears the cases (D-056)", async () => {
  const t = setup();
  const fx = qaFixture(t);
  const { parent, backend, qa } = fx;
  trackShippedPart(t, fx);
  t.gh.open(backend.key, 7);
  const saved = [
    {
      id: "C1",
      item: "item 1",
      repro: "pnpm test -- one",
      expected: "one passes",
      actual: "not ok 1",
    },
    {
      id: "C2",
      item: "item 2",
      repro: "pnpm test -- two",
      expected: "two passes",
      actual: "not ok 2",
    },
  ];
  t.memory.state.reviewedHeads = {
    [backend.id]: { sha: "sha6", verdict: "changes_requested", cases: saved },
  };

  // Re-QA 1: C1 passes, C2 still fails. Only C2 goes back, with its new actual.
  assert.deepEqual((await t.loop.tick()).dispatched, [qa.key]);
  await settle();
  t.adapter.pending.at(-1)?.finish(
    "ok",
    undefined,
    JSON.stringify({
      cases: [
        { id: "C1", pass: true, evidence: "pnpm test -- one: ok 1" },
        { id: "C2", pass: false, evidence: "pnpm test -- two: still not ok 2" },
      ],
      verify: { pass: true, evidence: "`pnpm test` exited with code 0" },
    }),
  );
  await t.loop.idle();
  const stillFailing = {
    id: "C2",
    item: "item 2",
    repro: "pnpm test -- two",
    expected: "two passes",
    actual: "pnpm test -- two: still not ok 2",
  };
  assert.match(t.gh.reviews.at(-1)?.body ?? "", /- \[ \] C2 \(item 2\): fail: /);
  assert.equal(backend.state, "Ready");
  assert.equal(t.memory.state.qaFailures[parent.id], 1);
  assert.deepEqual(t.memory.state.reviewedHeads?.[backend.id], {
    sha: "sha7",
    verdict: "changes_requested",
    cases: [stillFailing],
  });
  assert.deepEqual(t.memory.state.qaFeedback[backend.id]?.cases, [stillFailing]);

  // The builder fixes C2 and pushes a new head; QA runs only in review again.
  assert.deepEqual((await t.loop.tick()).dispatched, [backend.key]);
  t.adapter.pending.at(-1)?.finish("ok");
  await t.loop.idle();
  assert.deepEqual(t.memory.state.qaFeedback, {});
  const reworked = t.gh.prs[backend.key];
  assert.ok(reworked);
  reworked.headRefOid = "sha7-fixed";

  // Re-QA 2 still fails: the second failure sends the parent to Needs input and clears the cases.
  const reviewRunCount = t.adapter.pending.length + 1;
  assert.deepEqual((await t.loop.tick()).dispatched, [backend.key]);
  (await nextRun(t.adapter, reviewRunCount)).finish(
    "ok",
    undefined,
    JSON.stringify({ decision: "approve", findings: [] }),
  );
  await t.loop.idle();
  assert.deepEqual((await t.loop.tick()).dispatched, [qa.key]);
  await settle();
  t.adapter.pending.at(-1)?.finish(
    "ok",
    undefined,
    JSON.stringify({
      cases: [{ id: "C2", pass: false, evidence: "pnpm test -- two: still not ok 2" }],
      verify: { pass: true, evidence: "`pnpm test` exited with code 0" },
    }),
  );
  await t.loop.idle();
  assert.equal(qa.state, "Needs input");
  assert.equal(parent.state, "Needs input");
  assert.equal(backend.state, "In Review", "not sent back a second time");
  assert.deepEqual(t.memory.state.qaFailures, {});
  assert.equal(t.memory.state.reviewedHeads?.[backend.id]?.cases, undefined);
  assert.deepEqual(t.memory.state.qaFeedback, {});
});

// --- a resumed send-back (MET-156) -------------------------------------------

/** A parent with one backend part in Ready, its QA part and a fresh empty state. */
function sendBackFixture() {
  const linear = new FakeLinear();
  const parent = linear.add({ title: "P", state: "In Progress" });
  const backend = linear.add({
    title: "API",
    parentId: parent.id,
    state: "Ready",
    description: `${partMarker("backend")}\n**Size**: S`,
  });
  const qa = linear.add({
    title: "QA: P",
    parentId: parent.id,
    description: `${partMarker("qa")}\n**Size**: M`,
  });
  linear.relations.push({ blocker: backend.id, blocked: qa.id });
  const state = emptyLoopState();
  state.qaFeedback[backend.id] = {
    prUrl: "https://github.test/o/r/pull/7",
    reviewUrl: "https://github.test/o/r/pull/7#review-1",
    failing: ["Has tests: none"],
    testTail: "not ok 3 - avatars",
  };
  return { linear, backend, state };
}

function storedSession(backend: FakeIssue, harness: HarnessId = "claude-code") {
  return {
    harness,
    sessionId: "sess-a",
    worktree: `/wt/${backend.key}`,
    branch: backend.key.toLowerCase(),
    at: "2026-11-19T10:00:00.000Z",
  };
}

test("a part run stores its session, so a later send-back can resume it", async () => {
  const adapter = fakeAdapter({ canResume: true });
  const t = setup({ adapter });
  const parent = t.linear.add({ title: "P", state: "In Progress" });
  const a = part(t, parent.id, "backend", "A");

  assert.deepEqual((await t.loop.tick()).dispatched, [a.key]);
  t.adapter.pending[0]?.finish("ok", undefined, "done", undefined, undefined, 4, "sess-a");
  await t.loop.idle();

  const session = t.memory.state.sessions?.[a.id];
  assert.equal(session?.harness, "claude-code");
  assert.equal(session?.sessionId, "sess-a");
  assert.equal(session?.worktree, `/wt/${a.key}`);
  assert.equal(session?.branch, a.key.toLowerCase());
  assert.equal(typeof session?.at, "string");
});

test("a QA send-back resumes the builder's session with only the failures", async () => {
  const { linear, backend, state } = sendBackFixture();
  state.sessions = { [backend.id]: storedSession(backend) };
  const adapter = fakeAdapter({ canResume: true });
  const t = setup({ linear, adapter, store: memoryStore(state) });

  assert.deepEqual((await t.loop.tick()).dispatched, [backend.key]);
  const fix = t.adapter.runs().at(-1);
  assert.equal(fix?.resumeSessionId, "sess-a");
  assert.match(fix?.prompt ?? "", /## QA send-back/);
  assert.match(fix?.prompt ?? "", /Has tests: none/);
  assert.match(fix?.prompt ?? "", /not ok 3 - avatars/);
  assert.match(fix?.prompt ?? "", /Fix only these items\./);
  assert.match(fix?.prompt ?? "", /Run focused tests\./);
  assert.match(fix?.prompt ?? "", /Do not commit, push or open a PR/);
  assert.doesNotMatch(fix?.prompt ?? "", /## Your instructions/, "the session already holds them");
  assert.doesNotMatch(fix?.prompt ?? "", /## Task /);
  assert.doesNotMatch(fix?.prompt ?? "", /## When you are done/);
  assert.ok(t.logs.includes(`${backend.key}: resuming Claude Code session`));
  await t.loop.pause();
});

test("a send-back with no stored session starts cold and logs why", async () => {
  const { linear, backend, state } = sendBackFixture();
  const adapter = fakeAdapter({ canResume: true });
  const t = setup({ linear, adapter, store: memoryStore(state) });

  assert.deepEqual((await t.loop.tick()).dispatched, [backend.key]);
  const fix = t.adapter.runs().at(-1);
  assert.equal(fix?.resumeSessionId, undefined);
  assert.match(fix?.prompt ?? "", /## QA requested changes/, "the cold run reads the review");
  assert.match(fix?.prompt ?? "", /## Task /, "the cold run reads the brief again");
  assert.doesNotMatch(fix?.prompt ?? "", /## QA send-back/);
  assert.ok(t.logs.includes(`${backend.key}: cold run (no session)`));
  await t.loop.pause();
});

test("a send-back on another harness than the stored session starts cold and logs why", async () => {
  const { linear, backend, state } = sendBackFixture();
  state.sessions = { [backend.id]: storedSession(backend, "claude-code") };
  const config = mergeLayers([
    {
      scope: "workspace",
      dir: "/repo/.harnessd",
      settings: { limits: { max_concurrent: 3 } },
      agents: { backend: { harness: "codex", label: "backend", keyPrefix: "agents.backend" } },
      rules: [],
      skills: [],
      mcp: {},
      skillSettings: {},
    },
  ]);
  const adapter = fakeAdapter({ id: "codex", canResume: true });
  const t = setup({ linear, adapter, store: memoryStore(state), config });

  assert.deepEqual((await t.loop.tick()).dispatched, [backend.key]);
  assert.equal(t.adapter.runs().at(-1)?.resumeSessionId, undefined);
  assert.ok(t.logs.includes(`${backend.key}: cold run (session on Claude Code, run on Codex)`));
  await t.loop.pause();
});

test("a failed resume counts no attempt, drops the session and runs cold next", async () => {
  const { linear, backend, state } = sendBackFixture();
  state.sessions = { [backend.id]: storedSession(backend) };
  const adapter = fakeAdapter({ canResume: true });
  const t = setup({ linear, adapter, store: memoryStore(state) });

  await t.loop.tick();
  assert.equal(t.adapter.runs().at(-1)?.resumeSessionId, "sess-a");
  t.adapter.pending.at(-1)?.finish("error", "session not found");
  await t.loop.idle();

  assert.equal(backend.state, "Ready");
  assert.equal(t.memory.state.attempts[backend.id], undefined, "no attempt is counted");
  assert.equal(t.memory.state.sessions?.[backend.id], undefined, "the session is dropped");
  assert.ok(t.logs.includes(`${backend.key}: resume failed (session not found), cold next`));

  assert.deepEqual((await t.loop.tick()).dispatched, [backend.key]);
  const cold = t.adapter.runs().at(-1);
  assert.equal(cold?.resumeSessionId, undefined);
  assert.match(cold?.prompt ?? "", /## QA requested changes/);
  assert.ok(t.logs.includes(`${backend.key}: cold run (no session)`));
  await t.loop.pause();
});

// --- merge gate (MET-14) ----------------------------------------------------

/** A parent with one backend part whose PR #7 QA has approved at sha7. */
async function approved(t: ReturnType<typeof setup>, trackReview = false) {
  const fx = qaFixture(t);
  if (trackReview) trackShippedPart(t, fx);
  t.gh.open(fx.backend.key, 7);
  await t.loop.tick();
  await settle();
  t.adapter.pending.at(-1)?.finish("ok", undefined, verdict(true, true));
  await t.loop.idle();
  assert.equal(fx.qa.state, "Ready");
  assert.deepEqual(
    t.memory.state.merges.map((m) => [m.qaKey, m.prs.map((p) => [p.number, p.sha])]),
    [[fx.qa.key, [[7, "sha7"]]]],
    "the approval is recorded, pinned to the head QA reviewed",
  );
  return fx;
}

const humanPings = (t: ReturnType<typeof setup>) => t.pings.filter((p) => /needs a human/.test(p));

test("green CI, QA approved, nothing protected: squash-merged at the approved head, then Done", async () => {
  const t = setup();
  const { parent, backend, qa } = await approved(t);
  assert.deepEqual(t.gh.merges, [], "nothing merges in the QA tick itself");

  const report = await t.loop.tick();
  assert.deepEqual(report.merged, [backend.key]);
  assert.deepEqual(t.gh.merges, [{ number: 7, method: "squash", matchHeadCommit: "sha7" }]);
  assert.equal(backend.state, "Done");
  assert.equal(qa.state, "Done");
  assert.equal(parent.state, "Done");
  assert.match(t.linear.comments.at(-1)?.body ?? "", /every part is merged \(\[PR #7\]/);
  assert.deepEqual(t.pings, [
    `${backend.key} merged: PR #7 https://github.test/o/r/pull/7 (${parent.key} https://linear.test/${parent.key})`,
  ]);
  assert.deepEqual(t.memory.state.merges, []);
  assert.deepEqual(t.gh.labels, []);

  await t.loop.tick();
  assert.equal(t.gh.merges.length, 1, "merged once");
});

test("pending CI or no checks yet waits for a later tick", async () => {
  const t = setup();
  const { parent, backend, qa } = await approved(t);
  t.gh.statuses[7] = {
    checks: [
      { name: "CI / test", state: "pass", detail: "SUCCESS" },
      { name: "CI / lint", state: "pending", detail: "IN_PROGRESS" },
    ],
  };
  assert.deepEqual((await t.loop.tick()).merged, []);
  t.gh.statuses[7] = { checks: [] };
  assert.deepEqual((await t.loop.tick()).merged, []);
  t.gh.statuses[7] = { mergeable: "UNKNOWN" };
  assert.deepEqual((await t.loop.tick()).merged, []);
  assert.deepEqual(t.gh.merges, []);
  assert.equal(backend.state, "In Review");
  assert.equal(qa.state, "Ready");
  assert.equal(parent.state, "In Progress");
  assert.ok(t.logs.some((l) => /PR #7 waits \(CI \/ lint pending\)/.test(l)));
  assert.ok(t.logs.some((l) => /PR #7 waits \(no checks yet\)/.test(l)));

  delete t.gh.statuses[7];
  assert.deepEqual((await t.loop.tick()).merged, [backend.key]);
  assert.equal(parent.state, "Done");
});

test("failed CI sends the part back once with the failing checks; the second failure escalates", async () => {
  const t = setup();
  const { parent, backend, qa } = await approved(t, true);
  const failed = {
    checks: [
      {
        name: "CI / test",
        state: "fail" as const,
        detail: "FAILURE",
        url: "https://github.test/run/1",
      },
    ],
  };
  t.gh.statuses[7] = failed;

  // Sent back, and the part's agent starts again in the same tick.
  assert.deepEqual((await t.loop.tick()).dispatched, [backend.key]);
  assert.deepEqual(t.gh.merges, []);
  assert.ok(t.linear.moves.some((m) => m.key === backend.key && m.state === "Ready"));
  assert.equal(qa.state, "Ready");
  assert.equal(t.memory.state.gateFailures[parent.id], 1);
  assert.deepEqual(t.memory.state.merges, []);
  assert.match(
    t.linear.comments.find((c) => c.key === backend.key)?.body ?? "",
    /cannot merge \(round 1 of 2, D-014\).*\n\n- CI: `CI \/ test` failure \(https:\/\/github\.test\/run\/1\)/s,
  );

  // The part's agent gets the failing check and pushes to its open PR.
  const fix = t.adapter.runs().at(-1);
  assert.match(fix?.prompt ?? "", /## QA requested changes/);
  assert.match(fix?.prompt ?? "", /CI: `CI \/ test` failure/);
  assert.match(fix?.prompt ?? "", /harnessd pushes your work to the open PR/);
  t.adapter.pending.at(-1)?.finish("ok");
  await t.loop.idle();

  // The rework pushed to the open PR: a new head, still failing CI.
  const reworked = t.gh.prs[backend.key];
  assert.ok(reworked);
  reworked.headRefOid = "sha7-fixed";
  t.gh.statuses[7] = { ...failed, headRefOid: "sha7-fixed" };

  // The reviewer approves the new head before QA may judge it (MET-226).
  assert.deepEqual((await t.loop.tick()).dispatched, [backend.key], "the delta review comes first");
  await nextRun(t.adapter, 3);
  t.adapter.pending
    .find((pending) => pending.task.role === "reviewer")
    ?.finish("ok", undefined, JSON.stringify({ decision: "approve", findings: [] }));
  await t.loop.idle();

  // QA approves again (a QA approval does not reset the gate count), CI fails again.
  assert.deepEqual((await t.loop.tick()).dispatched, [qa.key]);
  await settle();
  (await nextRun(t.adapter, 4)).finish("ok", undefined, verdict(true, true));
  await t.loop.idle();
  assert.equal(qa.state, "Ready");
  await t.loop.tick();
  assert.equal(qa.state, "Needs input");
  assert.equal(parent.state, "Needs input");
  assert.equal(backend.state, "In Review", "not sent back a second time");
  assert.deepEqual(t.memory.state.gateFailures, {});
  assert.deepEqual(t.pings, [
    `${parent.key} needs input (merge gate failed twice): PR #7 https://github.test/o/r/pull/7 https://linear.test/${parent.key}`,
  ]);
  assert.deepEqual(t.gh.merges, []);
  await t.loop.tick();
  assert.equal(t.pings.length, 1);
});

test("a protected PR gets the needs-human label and one ping, ever; a human merge finishes it", async () => {
  const t = setup();
  const { parent, backend, qa } = await approved(t);
  t.gh.statuses[7] = {
    files: [
      { path: "src/x.ts", additions: 1, deletions: 0 },
      { path: "packages/daemon/src/auth/token.ts", additions: 2, deletions: 0 },
    ],
  };

  await t.loop.tick();
  assert.deepEqual(t.gh.merges, [], "never merged by harnessd");
  assert.deepEqual(t.gh.labels, [{ number: 7, label: "needs-human" }]);
  assert.equal(parent.state, "Needs input");
  assert.equal(backend.state, "In Review");
  assert.equal(qa.state, "Ready");
  assert.match(
    t.linear.comments.find((c) => c.key === parent.key)?.body ?? "",
    /needs a human \(D-013\): touches protected paths.*\n\n- `packages\/daemon\/src\/auth\/token\.ts`/s,
  );
  assert.deepEqual(humanPings(t), [
    `${backend.key} needs a human (touches protected paths): PR #7 https://github.test/o/r/pull/7 (${parent.key} https://linear.test/${parent.key})`,
  ]);
  assert.ok(t.memory.state.humanPings["https://github.test/o/r/pull/7"]);

  await t.loop.tick();
  await t.loop.tick();
  assert.equal(humanPings(t).length, 1, "one ping");
  assert.equal(t.gh.labels.length, 1);
  assert.equal(t.linear.comments.filter((c) => c.key === parent.key).length, 1);

  // A human merges it on GitHub.
  t.gh.statuses[7] = { ...t.gh.statuses[7], state: "MERGED" };
  const report = await t.loop.tick();
  assert.deepEqual(report.merged, [], "harnessd did not merge it");
  assert.deepEqual(t.gh.merges, []);
  assert.equal(backend.state, "Done");
  assert.equal(qa.state, "Done");
  assert.equal(parent.state, "Done");
  assert.equal(humanPings(t).length, 1);
});

test("a ping already recorded in loop.json is not sent again after a restart", async () => {
  const t = setup();
  await approved(t);
  t.gh.statuses[7] = {
    files: [{ path: ".github/workflows/release.yml", additions: 1, deletions: 0 }],
  };
  await t.loop.tick();
  assert.equal(humanPings(t).length, 1);

  const restarted = setup({ linear: t.linear, store: t.memory });
  restarted.gh.open(t.linear.byKey("MET-101").key, 7);
  restarted.gh.statuses[7] = t.gh.statuses[7];
  // Lose the PR's needs-human mark, as if the process stopped right after the ping.
  for (const m of t.memory.state.merges) for (const p of m.prs) delete p.needsHuman;
  await restarted.loop.tick();
  assert.deepEqual(humanPings(restarted), [], "the ping went out once, before the restart");
  assert.deepEqual(restarted.gh.merges, []);
});

test("no merge while paused, even when the pause lands between the CI check and the merge", async () => {
  let paused = false;
  let pauseAfterView = false;
  const t = setup({ extra: { paused: () => paused || (pauseAfterView && t.gh.views.length > 0) } });
  const { backend } = await approved(t);
  // The QA run reads the PR's checks; from here the gate's own views are what matter.
  t.gh.views.length = 0;

  paused = true;
  assert.equal((await t.loop.tick()).paused, true);
  assert.deepEqual(t.gh.views, [], "the gate does not even look while paused");

  paused = false;
  pauseAfterView = true;
  const report = await t.loop.tick();
  assert.equal(report.paused, true);
  assert.deepEqual(t.gh.views, [7]);
  assert.deepEqual(t.gh.merges, []);
  assert.equal(backend.state, "In Review");
  assert.equal(t.memory.state.merges.length, 1, "the approval waits for resume");

  pauseAfterView = false;
  assert.deepEqual((await t.loop.tick()).merged, [backend.key]);
});

test("a head that moved after QA approved is never merged: the delta review then QA run on the new head", async () => {
  const t = setup();
  const { backend, qa } = await approved(t, true);
  t.gh.statuses[7] = { headRefOid: "sha7-pushed-later" };
  const pr = t.gh.prs[backend.key];
  assert.ok(pr);
  pr.headRefOid = "sha7-pushed-later";

  const report = await t.loop.tick();
  assert.deepEqual(t.gh.merges, []);
  assert.deepEqual(
    report.dispatched,
    [backend.key],
    "the delta review runs before QA on the new head",
  );
  assert.match(
    t.linear.comments.find((c) => c.key === qa.key && /moved from/.test(c.body))?.body ?? "",
    /moved from `sha7` to `sha7-pu` after QA approved it/,
  );
  assert.deepEqual(t.memory.state.qaFailures, {}, "no QA failure counted");
  assert.equal(qa.state, "Ready", "QA waits for the review approval");

  await nextRun(t.adapter, 2);
  t.adapter.pending
    .find((pending) => pending.task.role === "reviewer")
    ?.finish("ok", undefined, JSON.stringify({ decision: "approve", findings: [] }));
  await t.loop.idle();
  assert.equal(t.memory.state.reviewerHeads?.[backend.id]?.sha, "sha7-pushed-later");

  assert.deepEqual((await t.loop.tick()).dispatched, [qa.key], "QA runs after the delta review");
  await nextRun(t.adapter, 3);
  assert.equal(t.wt.checkouts.at(-1)?.sha, "sha7-pushed-later");
  (await nextRun(t.adapter, 3)).finish("ok", undefined, verdict(true, true));
  await t.loop.idle();

  assert.deepEqual((await t.loop.tick()).merged, [backend.key]);
  assert.deepEqual(t.gh.merges, [
    { number: 7, method: "squash", matchHeadCommit: "sha7-pushed-later" },
  ]);
});

test("a refused merge waits for a human; the merge method and label come from [merge]", async () => {
  const config = mergeLayers([
    {
      scope: "workspace",
      dir: "/repo/.harnessd",
      settings: { merge: { method: "rebase", label: "hold" } },
      agents: {},
      rules: [],
      skills: [],
      mcp: {},
      skillSettings: {},
    },
  ]);
  const t = setup({ config });
  const { parent, backend } = await approved(t);
  t.gh.github.mergePr = async (number, input) => {
    t.gh.merges.push({ number, ...input });
    throw new Error("gh pr merge exited with code 1: base branch policy prohibits the merge");
  };
  await t.loop.tick();
  assert.deepEqual(t.gh.merges, [{ number: 7, method: "rebase", matchHeadCommit: "sha7" }]);
  assert.deepEqual(t.gh.labels, [{ number: 7, label: "hold" }]);
  assert.equal(parent.state, "Needs input");
  assert.equal(backend.state, "In Review");
  assert.deepEqual(humanPings(t), [
    `${backend.key} needs a human (GitHub refused the merge): PR #7 https://github.test/o/r/pull/7 (${parent.key} https://linear.test/${parent.key})`,
  ]);
  await t.loop.tick();
  assert.equal(t.gh.merges.length, 1, "not retried");
});

test("an escalated grill skips the issue: no plan, no sub-issues", async () => {
  const adapter = fakeAdapter({
    grillReply: JSON.stringify({
      calls: [],
      escalation: { trigger: "money", question: "Which plan do we buy?", why: "It costs money." },
    }),
  });
  const t = setup({ adapter });
  const issue = t.linear.add({ title: "Buy a plan", description: BODY("S") });
  const report = await t.loop.tick();
  assert.deepEqual(report.escalated, [issue.key]);
  assert.equal(issue.state, "Needs input");
  assert.equal(t.linear.children(issue).length, 0);
  assert.deepEqual(
    t.adapter.tasks.map((x) => x.id.split("-")[0]),
    ["grill"],
  );
});

test("while paused nothing is grilled or dispatched", async () => {
  let paused = true;
  const t = setup({ extra: { paused: () => paused } });
  t.linear.add({ title: "Waiting", description: BODY("S") });
  const report = await t.loop.tick();
  assert.equal(report.paused, true);
  assert.equal(t.adapter.tasks.length, 0);
  paused = false;
  assert.equal((await t.loop.tick()).paused, false);
  assert.ok(t.adapter.tasks.length > 0);
});

test("start ticks now and on every interval; stop cancels the timer", async () => {
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const clock = {
    now: () => new Date("2026-11-19T10:00:00.000Z"),
    setInterval(fn: () => void, ms: number) {
      const timer = { fn, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearInterval(handle: unknown) {
      (handle as { cleared: boolean }).cleared = true;
    },
  };
  const t = setup({ extra: { clock, intervalMs: 1000 } });
  t.loop.start();
  t.loop.start();
  assert.equal(timers.length, 1, "start is idempotent");
  assert.equal(timers[0]?.ms, 1000);
  await t.loop.idle();
  assert.equal(t.memory.state.lastPollAt, "2026-11-19T10:00:00.000Z");
  timers[0]?.fn();
  await t.loop.idle();
  t.loop.stop();
  assert.equal(timers[0]?.cleared, true);
});

// --- restart, with real git worktrees and the file store --------------------

/** A git call that hangs fails the test in 30 s instead of stalling the whole file. */
const TEST_GIT_TIMEOUT_MS = 30_000;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    encoding: "utf8",
    timeout: TEST_GIT_TIMEOUT_MS,
  }).trim();
}

test("a restart re-queues runs left in loop.json, cleans their worktrees and counts no attempt", async () => {
  const root = await mkdtemp(join(tmpdir(), "harnessd-loop-"));
  roots.push(root);
  const repo = join(root, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo], { timeout: TEST_GIT_TIMEOUT_MS });
  await writeFile(join(repo, "README.md"), "hi\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  const worktrees = createGitWorktrees({ repoDir: repo, root: join(root, "worktrees") });

  const linear = new FakeLinear();
  const parent = linear.add({ title: "P", state: "In Progress" });
  const part = linear.add({
    title: "Survives restarts",
    parentId: parent.id,
    description: `${partMarker("backend")}\n**Size**: S`,
  });

  const first = setup({ linear, worktrees, store: createFileLoopStore(repo) });
  assert.deepEqual((await first.loop.tick()).dispatched, [part.key]);
  const wtPath = first.adapter.pending[0]?.cwd ?? "";
  assert.ok(existsSync(join(wtPath, "README.md")), "the run got a real worktree");
  const saved = JSON.parse(await readFile(join(repo, ".harnessd/state/loop.json"), "utf8"));
  assert.equal(saved.inFlight[0].issueKey, part.key);
  assert.equal(saved.inFlight[0].worktree, wtPath);
  assert.equal(await readFile(join(repo, ".harnessd/state/.gitignore"), "utf8"), "*\n");
  // A first failure was recorded earlier; a restart must not add to it.
  saved.attempts[part.id] = 1;
  await writeFile(join(repo, ".harnessd/state/loop.json"), JSON.stringify(saved));

  // The daemon dies; a new one starts from the same loop.json.
  const second = setup({ linear, worktrees, store: createFileLoopStore(repo) });
  const report = await second.loop.tick();
  assert.deepEqual(report.requeued, [part.key]);
  assert.deepEqual(
    linear.moves.filter((m) => m.key === part.key).map((m) => m.state),
    ["In Progress", "Ready", "In Progress"],
  );
  assert.deepEqual(report.dispatched, [part.key], "picked straight back up");
  assert.equal(second.adapter.runs()[0]?.id, `${part.key}-2`, "attempt count unchanged");
  assert.equal(second.adapter.pending[0]?.cwd, wtPath, "same branch and path");
  assert.equal(git(wtPath, "branch", "--show-current"), saved.inFlight[0].branch);

  second.adapter.pending[0]?.finish("ok");
  await second.loop.idle();
  assert.equal(part.state, "In Review");
  assert.equal(existsSync(wtPath), false, "worktree removed after the run");
  const final = JSON.parse(await readFile(join(repo, ".harnessd/state/loop.json"), "utf8"));
  assert.deepEqual(final.inFlight, []);
  assert.deepEqual(final.attempts, {});
});

test("a restart keeps a dirty worktree instead of removing it, then resumes it", async () => {
  const root = await mkdtemp(join(tmpdir(), "harnessd-requeue-keep-"));
  roots.push(root);
  const repo = join(root, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo], { timeout: TEST_GIT_TIMEOUT_MS });
  await writeFile(join(repo, "README.md"), "hi\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  const worktrees = createGitWorktrees({ repoDir: repo, root: join(root, "worktrees") });

  const linear = new FakeLinear();
  const parent = linear.add({ title: "P", state: "In Progress" });
  const part = linear.add({
    title: "Crashes with work",
    parentId: parent.id,
    description: `${partMarker("backend")}\n**Size**: S`,
  });
  const first = setup({ linear, worktrees, store: createFileLoopStore(repo) });
  await first.loop.tick();
  const wtPath = first.adapter.pending[0]?.cwd ?? "";
  await writeFile(join(wtPath, "wip.txt"), "not shipped\n");

  // The daemon dies; a new one starts from the same loop.json.
  const second = setup({ linear, worktrees, store: createFileLoopStore(repo) });
  const report = await second.loop.tick();
  assert.deepEqual(report.requeued, [part.key]);
  assert.deepEqual(report.dispatched, [part.key]);
  assert.equal(second.adapter.pending[0]?.cwd, wtPath, "the same worktree is reused");
  assert.ok(existsSync(join(wtPath, "wip.txt")), "the uncommitted work survived");
  assert.ok(second.adapter.pending[0]?.task.prompt.endsWith(RESUMED_RUN_NOTE));
  assert.ok(
    linear.comments.some(
      (c) =>
        c.key === part.key &&
        c.body === `**harnessd**: worktree kept at ${wtPath}: uncommitted changes.`,
    ),
  );
});

test("a worktree with unshipped work is kept, commented on and recorded in interrupted", async () => {
  const root = await mkdtemp(join(tmpdir(), "harnessd-keep-"));
  roots.push(root);
  const repo = join(root, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo], { timeout: TEST_GIT_TIMEOUT_MS });
  await writeFile(join(repo, "README.md"), "hi\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  const worktrees = createGitWorktrees({ repoDir: repo, root: join(root, "worktrees") });

  const linear = new FakeLinear();
  const parent = linear.add({ title: "P", state: "In Progress" });
  const part = linear.add({
    title: "Keeps shipped work",
    parentId: parent.id,
    description: `${partMarker("backend")}\n**Size**: S`,
  });
  const t = setup({ linear, worktrees, store: createFileLoopStore(repo) });
  assert.deepEqual((await t.loop.tick()).dispatched, [part.key]);
  const wtPath = t.adapter.pending[0]?.cwd ?? "";
  await writeFile(join(wtPath, "wip.txt"), "not shipped\n");

  t.adapter.pending[0]?.finish("ok");
  await t.loop.idle();

  assert.ok(existsSync(join(wtPath, "wip.txt")));
  assert.ok(
    t.linear.comments.some(
      (c) =>
        c.key === part.key &&
        c.body === `**harnessd**: worktree kept at ${wtPath}: uncommitted changes.`,
    ),
  );
  const saved = JSON.parse(await readFile(join(repo, ".harnessd/state/loop.json"), "utf8"));
  assert.deepEqual(
    saved.interrupted.map((e: { issueKey: string; reason: string }) => [e.issueKey, e.reason]),
    [[part.key, "uncommitted changes"]],
  );
});

test("a failed, cancelled or limited run keeps its worktree when it holds unshipped work", async () => {
  for (const status of ["error", "cancelled", "limited"] as const) {
    const root = await mkdtemp(join(tmpdir(), `harnessd-keep-${status}-`));
    roots.push(root);
    const repo = join(root, "repo");
    execFileSync("git", ["init", "-q", "-b", "main", repo], { timeout: TEST_GIT_TIMEOUT_MS });
    await writeFile(join(repo, "README.md"), "hi\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "init");
    const worktrees = createGitWorktrees({ repoDir: repo, root: join(root, "worktrees") });

    const linear = new FakeLinear();
    const parent = linear.add({ title: "P", state: "In Progress" });
    const part = linear.add({
      title: "Fails with work",
      parentId: parent.id,
      description: `${partMarker("backend")}\n**Size**: S`,
    });
    const t = setup({ linear, worktrees, store: createFileLoopStore(repo) });
    await t.loop.tick();
    const wtPath = t.adapter.pending[0]?.cwd ?? "";
    await writeFile(join(wtPath, "wip.txt"), "not shipped\n");

    t.adapter.pending[0]?.finish(status, "tests failed");
    await t.loop.idle();

    assert.ok(existsSync(join(wtPath, "wip.txt")), status);
    assert.equal(part.state, "Ready", `${status}: one retry`);
    const saved = JSON.parse(await readFile(join(repo, ".harnessd/state/loop.json"), "utf8"));
    assert.equal(saved.interrupted[0]?.reason, "uncommitted changes", status);
    assert.ok(
      t.linear.comments.some(
        (c) =>
          c.key === part.key &&
          c.body.includes("worktree kept at") &&
          c.body.includes("uncommitted changes"),
      ),
      status,
    );
  }
});

// --- pause (MET-15) ----------------------------------------------------------

function twoParts(linear: FakeLinear): [FakeIssue, FakeIssue] {
  const parent = linear.add({ title: "P", state: "In Progress" });
  const a = linear.add({
    title: "API",
    parentId: parent.id,
    description: `${partMarker("backend")}\n**Size**: S`,
  });
  const b = linear.add({
    title: "UI",
    parentId: parent.id,
    description: `${partMarker("frontend")}\n**Size**: S`,
  });
  return [a, b];
}

function fakeClock() {
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  return {
    timers,
    now: () => new Date("2026-11-19T10:00:00.000Z"),
    setInterval(fn: () => void, ms: number) {
      const timer = { fn, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearInterval(handle: unknown) {
      (handle as { cleared: boolean }).cleared = true;
    },
  };
}

test("pause cancels every run, keeps the worktrees and counts no attempt; resume reuses them", async () => {
  const t = setup();
  const [a, b] = twoParts(t.linear);
  assert.deepEqual((await t.loop.tick()).dispatched, [a.key, b.key]);

  assert.deepEqual(await t.loop.pause(), [a.key, b.key]);
  assert.deepEqual(t.loop.running(), []);
  assert.deepEqual(t.wt.removed, [], "worktrees kept for inspection");
  for (const part of [a, b]) {
    assert.equal(part.state, "Ready");
    assert.ok(
      t.linear.comments.some(
        (c) =>
          c.key === part.key &&
          c.body === `**harnessd**: Paused by harnessd pause; worktree kept at /wt/${part.key}.`,
      ),
    );
  }
  assert.deepEqual(t.memory.state.inFlight, []);
  assert.deepEqual(t.memory.state.attempts, {});
  assert.deepEqual(
    t.memory.state.interrupted.map((e) => [e.issueKey, e.worktree, e.reason]),
    [
      [a.key, `/wt/${a.key}`, "paused"],
      [b.key, `/wt/${b.key}`, "paused"],
    ],
  );

  const paused = await t.loop.tick();
  assert.equal(paused.paused, true);
  assert.deepEqual(paused.dispatched, [], "nothing dispatched while paused");

  t.loop.resume();
  const resumed = await t.loop.tick();
  assert.equal(resumed.paused, false);
  assert.deepEqual(resumed.dispatched, [a.key, b.key]);
  const reruns = t.adapter.runs().slice(2);
  assert.deepEqual(
    reruns.map((r) => r.id),
    [`${a.key}-1`, `${b.key}-1`],
    "no attempt counted",
  );
  assert.ok(reruns.every((r) => r.prompt.endsWith(RESUMED_RUN_NOTE)));
  assert.deepEqual(t.wt.created, [a.key, b.key, a.key, b.key]);
  assert.deepEqual(t.memory.state.interrupted, []);
  for (const run of t.adapter.pending.slice(2)) run.finish("ok");
  await t.loop.idle();
  assert.equal(a.state, "In Review");
});

test("a run that finishes ok while the pause lands is not interrupted", async () => {
  const t = setup();
  const [a, b] = twoParts(t.linear);
  await t.loop.tick();
  const pausing = t.loop.pause();
  t.adapter.pending[0]?.finish("ok");
  await pausing;
  assert.equal(a.state, "In Review");
  assert.deepEqual(t.wt.removed, [`/wt/${a.key}`]);
  assert.equal(b.state, "Ready");
  assert.deepEqual(
    t.memory.state.interrupted.map((e) => e.issueKey),
    [b.key],
  );
});

test("a pause flag written with no daemon stops runs at the next watch check", async () => {
  let flag = false;
  const clock = fakeClock();
  const t = setup({ extra: { clock, paused: () => flag } });
  const [a, b] = twoParts(t.linear);
  await t.loop.tick();
  const watches = clock.timers.filter((x) => !x.cleared);
  assert.equal(watches.length, 1, "one watch while runs are in flight");
  const watch = watches[0];
  assert.ok(watch !== undefined && watch.ms <= 2_000, "re-read at least every 2 s");

  watch.fn();
  await settle();
  assert.equal(t.loop.running().length, 2, "still running while the flag is clear");

  flag = true;
  watch.fn();
  await t.loop.idle();
  assert.deepEqual(t.loop.running(), []);
  assert.equal(a.state, "Ready");
  assert.equal(b.state, "Ready");
  assert.deepEqual(t.wt.removed, []);
  assert.equal(t.memory.state.interrupted.length, 2);
  assert.equal(watch.cleared, true, "no watch once nothing runs");
  assert.equal((await t.loop.tick()).paused, true);
  assert.equal(t.adapter.runs().length, 2);
});

test("pausing during a QA run cancels it: no review, no QA failure, the worktree is kept", async () => {
  const t = setup();
  const { parent, backend, qa } = qaFixture(t);
  t.gh.open(backend.key, 7);
  assert.deepEqual((await t.loop.tick()).dispatched, [qa.key]);
  await settle();
  const path = `/wt/${qa.key}-sha7`;
  assert.equal(t.adapter.pending.length, 1, "the QA agent is running");

  assert.deepEqual(await t.loop.pause(), [qa.key]);
  assert.deepEqual(t.loop.running(), []);
  assert.equal(t.gh.reviews.length, 0, "no review is posted");
  assert.deepEqual(t.memory.state.qaFailures, {}, "no QA failure counted");
  assert.deepEqual(t.memory.state.qaFeedback, {});
  assert.deepEqual(t.wt.removed, [], "the QA worktree is kept");
  assert.equal(qa.state, "Ready");
  assert.equal(backend.state, "In Review", "the part is not sent back");
  assert.equal(parent.state, "In Progress");
  assert.ok(
    t.linear.comments.some(
      (c) =>
        c.key === qa.key &&
        c.body === `**harnessd**: Paused by harnessd pause; worktree kept at ${path}.`,
    ),
  );
  assert.deepEqual(t.memory.state.inFlight, []);
  assert.deepEqual(
    t.memory.state.interrupted.map((e) => [e.issueKey, e.worktree, e.reason]),
    [[qa.key, path, "paused"]],
  );
  assert.equal((await t.loop.tick()).paused, true);
  assert.equal(t.adapter.runs().length, 1, "nothing dispatched while paused");

  // Resume: QA checks the PR out afresh in the same round and approves.
  t.loop.resume();
  assert.deepEqual((await t.loop.tick()).dispatched, [qa.key]);
  await settle();
  assert.deepEqual(t.wt.removed, [path], "the kept worktree is cleared before the new checkout");
  assert.deepEqual(t.memory.state.interrupted, []);
  assert.match(t.adapter.runs().at(-1)?.id ?? "", /-qa-1-pr7$/, "still round 1");
  t.adapter.pending.at(-1)?.finish("ok", undefined, verdict(true, true));
  await t.loop.idle();
  assert.equal(t.gh.reviews.length, 1);
  assert.equal(t.gh.reviews[0]?.event, "APPROVE");
  assert.equal(qa.state, "Ready");
});

test("pausing while QA runs the tests stops them and starts no QA agent", async () => {
  const signals: AbortSignal[] = [];
  const t = setup({
    extra: {
      runCommand: (_command, _cwd, _ms, signal) =>
        new Promise((resolve) => {
          if (signal !== undefined) signals.push(signal);
          signal?.addEventListener("abort", () =>
            resolve({ exitCode: null, timedOut: false, output: "killed" }),
          );
        }),
    },
  });
  const { parent, backend, qa } = qaFixture(t);
  t.gh.open(backend.key, 7);
  await t.loop.tick();
  await settle();
  assert.equal(signals.length, 1, "the setup command is running");

  assert.deepEqual(await t.loop.pause(), [qa.key]);
  assert.equal(signals[0]?.aborted, true);
  assert.equal(signals.length, 1, "the test command never starts");
  assert.equal(t.adapter.runs().length, 0, "no QA agent run");
  assert.equal(t.gh.reviews.length, 0);
  assert.equal(t.memory.state.qaFailures[parent.id], undefined);
  assert.equal(qa.state, "Ready");
  assert.equal(backend.state, "In Review");
  assert.deepEqual(
    t.memory.state.interrupted.map((e) => e.worktree),
    [`/wt/${qa.key}-sha7`],
  );
});

test("a part sent back by QA and then paused resumes with both the review and the resumed note", async () => {
  const state = emptyLoopState();
  const t0 = new FakeLinear();
  const [a] = twoParts(t0);
  state.qaFeedback[a.id] = {
    prUrl: "https://github.test/o/r/pull/7",
    failing: ["Has tests: none"],
  };
  const t = setup({ linear: t0, store: memoryStore(state) });
  await t.loop.tick();
  await t.loop.pause();
  t.loop.resume();
  await t.loop.tick();
  const rerun = t.adapter.runs().find((r, i) => i >= 2 && r.id === `${a.key}-1`);
  assert.match(rerun?.prompt ?? "", /## QA requested changes/);
  assert.match(rerun?.prompt ?? "", /Has tests: none/);
  assert.ok(rerun?.prompt.endsWith(RESUMED_RUN_NOTE));
});

test("a tick that finds the flag set cancels what still runs", async () => {
  let flag = false;
  const t = setup({ extra: { paused: () => flag } });
  const [a] = twoParts(t.linear);
  await t.loop.tick();
  flag = true;
  const report = await t.loop.tick();
  assert.equal(report.paused, true);
  assert.deepEqual(t.loop.running(), []);
  assert.equal(a.state, "Ready");
  assert.deepEqual(t.wt.removed, []);
});

test("a pause cancels grill runs and skips the split", async () => {
  let paused = false;
  const grills: Array<() => void> = [];
  const adapter: HarnessAdapter = {
    id: "claude-code",
    start() {
      let resolve: (r: RunResult) => void = () => {};
      const result = new Promise<RunResult>((r) => {
        resolve = r;
      });
      const cancelled: RunResult = {
        status: "cancelled",
        exitCode: null,
        durationMs: 1,
        tokens: emptyTokenUsage(),
        error: "cancelled",
      };
      grills.push(() => resolve(cancelled));
      const events = (async function* (): AsyncGenerator<AdapterEvent> {
        yield { type: "end", result: await result };
      })();
      return {
        events,
        result,
        cancel: async () => {
          resolve(cancelled);
          await result;
        },
      };
    },
  };
  const t = setup({ extra: { adapters: { "claude-code": adapter }, paused: () => paused } });
  const issue = t.linear.add({ title: "Needs a grill", description: BODY("S") });
  const tick = t.loop.tick();
  while (grills.length === 0) await settle();
  paused = true;
  assert.deepEqual(await t.loop.pause(), []);
  const report = await tick;
  assert.equal(report.paused, true);
  assert.deepEqual(report.split, []);
  assert.equal(t.linear.children(issue).length, 0, "no split from a cancelled run");
  assert.equal(issue.state, "Ready");
});

test("a restart after a pause that was not yet recorded keeps the worktree", async () => {
  const linear = new FakeLinear();
  const [a] = twoParts(linear);
  a.state = "In Progress";
  const store = memoryStore({
    ...emptyLoopState(),
    inFlight: [
      {
        issueId: a.id,
        issueKey: a.key,
        role: "backend",
        agent: "backend",
        worktree: `/wt/${a.key}`,
        branch: a.key.toLowerCase(),
        startedAt: "2026-11-19T09:00:00.000Z",
        pid: 1,
        pausedAt: "2026-11-19T09:30:00.000Z",
      },
    ],
  });
  let paused = true;
  const t = setup({ linear, store, extra: { paused: () => paused } });
  const report = await t.loop.tick();
  assert.deepEqual(report.requeued, [a.key]);
  assert.deepEqual(t.wt.removed, []);
  assert.equal(a.state, "Ready");
  assert.deepEqual(
    store.state.interrupted.map((e) => [e.issueKey, e.interruptedAt]),
    [[a.key, "2026-11-19T09:30:00.000Z"]],
  );
  paused = false;
  assert.ok((await t.loop.tick()).dispatched.includes(a.key));
  assert.ok(t.adapter.runs()[0]?.prompt.endsWith(RESUMED_RUN_NOTE));
});

test("pause stops a real claude run within 10 s; the paused flag and the worktree survive a restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "harnessd-pause-"));
  roots.push(root);
  const repo = join(root, "repo");
  const home = join(root, "home");
  execFileSync("git", ["init", "-q", "-b", "main", repo], { timeout: TEST_GIT_TIMEOUT_MS });
  await writeFile(join(repo, "README.md"), "hi\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  const worktrees = createGitWorktrees({ repoDir: repo, root: join(root, "worktrees") });

  const fake = join(import.meta.dirname, "../../test/fixtures/fake-claude.mjs");
  const record = join(root, "record.json");
  let mode = "hang-stubborn"; // ignores SIGTERM: only the SIGKILL after the grace stops it
  const prompts: string[] = [];
  const adapter: HarnessAdapter = {
    id: "claude-code",
    start(task, cwd) {
      prompts.push(task.prompt);
      return createClaudeCodeAdapter({
        bin: fake,
        killGraceMs: 500,
        env: { FAKE_CLAUDE_MODE: mode, FAKE_CLAUDE_RECORD: record },
      }).start(task, cwd);
    },
  };
  const linear = new FakeLinear();
  const parent = linear.add({ title: "P", state: "In Progress" });
  const part = linear.add({
    title: "Long job",
    parentId: parent.id,
    description: `${partMarker("backend")}\n**Size**: S`,
  });

  const pauseStore = createFilePauseStore(home);
  const make = () =>
    setup({
      linear,
      worktrees,
      store: createFileLoopStore(repo),
      extra: {
        adapters: { "claude-code": adapter },
        paused: async () => (await createFilePauseStore(home).read()).paused,
      },
    });
  const first = make();
  const control = createPauseController({ store: pauseStore, loops: [first.loop] });
  assert.deepEqual((await first.loop.tick()).dispatched, [part.key]);
  while (!existsSync(record) || !(await readFile(record, "utf8")).includes("grandchildPid")) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  const started = Date.now();
  const result = await control.pause("deploy freeze");
  const took = Date.now() - started;
  assert.ok(took < 10_000, `took ${took}ms`);
  assert.equal(result.paused, true);
  assert.equal(result.reason, "deploy freeze");
  assert.equal(result.cancelled, 1);
  assert.deepEqual(first.loop.running(), []);
  const saved = JSON.parse(await readFile(join(repo, ".harnessd/state/loop.json"), "utf8"));
  assert.deepEqual(saved.inFlight, []);
  assert.deepEqual(saved.attempts, {});
  const wtPath: string = saved.interrupted[0].worktree;
  assert.ok(existsSync(join(wtPath, "README.md")), "worktree kept");
  assert.equal(part.state, "Ready");
  assert.match(linear.comments.at(-1)?.body ?? "", /Paused by harnessd pause; worktree kept at /);

  // The daemon stops and a new one starts: still paused, and recovery keeps the worktree.
  const second = make();
  const report = await second.loop.tick();
  assert.equal(report.paused, true);
  assert.deepEqual(report.dispatched, []);
  assert.deepEqual(report.requeued, []);
  assert.ok(existsSync(join(wtPath, "README.md")), "restart recovery kept the worktree");

  await pauseStore.resume();
  mode = "ok";
  assert.deepEqual((await second.loop.tick()).dispatched, [part.key]);
  assert.ok(prompts.at(-1)?.endsWith(RESUMED_RUN_NOTE), "the run picks up the kept worktree");
  await second.loop.idle();
  assert.equal(part.state, "In Review");
  assert.equal(existsSync(wtPath), false, "removed after the resumed run finished");
});

// --- snapshot (MET-18) -----------------------------------------------------

/** Wraps an adapter so each run first reports a tool call and token use. */
function chattyAdapter(inner: ReturnType<typeof fakeAdapter>) {
  const adapter: HarnessAdapter = {
    id: inner.adapter.id,
    start(task, cwd) {
      const run = inner.adapter.start(task, cwd);
      const events: AsyncIterable<AdapterEvent> = {
        async *[Symbol.asyncIterator]() {
          yield { type: "tool", name: "Edit", summary: "src/app.ts" };
          yield {
            type: "usage",
            tokens: { input: 1200, output: 300, cacheRead: 5000, cacheWrite: 0 },
          };
          yield* run.events;
        },
      };
      return { ...run, events };
    },
  };
  return { ...inner, adapter };
}

test("snapshot lists each run with its budget, tokens and latest action", async () => {
  const seen: string[] = [];
  const t = setup({
    adapter: chattyAdapter(fakeAdapter()),
    extra: {
      clock: fakeClock(),
      onAgentEvent: (run, event) => {
        if (event.type === "tool") seen.push(`${run.issueKey} ${run.agent}: ${event.summary}`);
      },
    },
  });
  const parent = t.linear.add({ title: "Board", state: "In Progress" });
  const part = t.linear.add({
    title: "Board API",
    parentId: parent.id,
    description: `${partMarker("backend")}\n**Size**: S`,
  });
  assert.deepEqual(t.loop.snapshot().runs, [], "nothing runs before the first tick");

  await t.loop.tick();
  await settle();
  const snap = t.loop.snapshot();
  assert.equal(snap.lastPollAt, "2026-11-19T10:00:00.000Z");
  assert.deepEqual(snap.runs, [
    {
      issueId: part.id,
      issueKey: part.key,
      title: "Board API",
      agent: "backend",
      role: "backend",
      harness: "claude-code",
      startedAt: "2026-11-19T10:00:00.000Z",
      budgetMs: 30 * 60_000,
      tokens: 1500,
      lastAction: "Edit src/app.ts",
      stopping: false,
    },
  ]);
  assert.deepEqual(seen, [`${part.key} backend: src/app.ts`]);

  t.adapter.pending[0]?.finish("ok");
  await t.loop.idle();
  assert.deepEqual(t.loop.snapshot().runs, []);
});

test("snapshot lists the PRs that wait for a human at the merge gate", async () => {
  const t = setup();
  const { parent, backend } = await approved(t);
  assert.deepEqual(t.loop.snapshot().blocked, []);
  t.gh.statuses[7] = { files: [{ path: "src/auth/token.ts", additions: 1, deletions: 0 }] };
  await t.loop.tick();
  assert.deepEqual(t.loop.snapshot().blocked, [
    {
      issueKey: backend.key,
      parentKey: parent.key,
      prUrl: "https://github.test/o/r/pull/7",
      reason: "touches protected paths",
    },
  ]);
  t.gh.statuses[7] = { ...t.gh.statuses[7], state: "MERGED" };
  await t.loop.tick();
  assert.deepEqual(t.loop.snapshot().blocked, [], "a human merged it");
});

// --- what a run sees (MET-55) ----------------------------------------------

test("a run in a repo with no committed skills sees the pack, the memory vault and a clean git status", async () => {
  const root = await mkdtemp(join(tmpdir(), "harnessd-sees-"));
  roots.push(root);
  const origin = join(root, "origin.git");
  const repo = join(root, "repo");
  const home = join(root, "home");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin], {
    timeout: TEST_GIT_TIMEOUT_MS,
  });
  execFileSync("git", ["clone", "-q", origin, repo], { timeout: TEST_GIT_TIMEOUT_MS });
  await writeFile(join(repo, "README.md"), "hi\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  git(repo, "push", "-q", "origin", "main");
  // The workspace layer lives only in the main checkout: nothing harnessd is committed.
  await mkdir(join(repo, ".harnessd"), { recursive: true });
  await writeFile(join(repo, ".harnessd", "AGENTS.md"), "Workspace rules.\n");
  await mkdir(join(home, "skills", "pack-skill"), { recursive: true });
  await writeFile(
    join(home, "skills", "pack-skill", "SKILL.md"),
    "---\nname: pack-skill\ndescription: From the pack.\n---\nDo it well.\n",
  );
  const worktrees = createGitWorktrees({
    repoDir: repo,
    root: join(root, "worktrees"),
    base: "origin/main",
  });

  const fake = join(import.meta.dirname, "../../test/fixtures/fake-claude.mjs");
  const record = join(root, "record.json");
  const adapter = createClaudeCodeAdapter({
    bin: fake,
    env: { FAKE_CLAUDE_MODE: "ok", FAKE_CLAUDE_RECORD: record, FAKE_CLAUDE_INSPECT: "1" },
  });
  const linear = new FakeLinear();
  const parent = linear.add({ title: "P", state: "In Progress" });
  const part = linear.add({
    title: "Uses the pack",
    parentId: parent.id,
    description: `${partMarker("backend")}\n**Size**: S`,
  });
  const t = setup({
    linear,
    worktrees,
    extra: { adapters: { "claude-code": adapter }, repoDir: repo, globalDir: home },
  });
  assert.deepEqual((await t.loop.tick()).dispatched, [part.key]);
  await t.loop.idle();
  assert.equal(part.state, "In Review", t.logs.join("\n"));

  const seen = JSON.parse(await readFile(record, "utf8"));
  assert.deepEqual(seen.inspect.skills, ["pack-skill"], "the pack skill was there at run time");
  assert.deepEqual(seen.inspect.mcp.mcpServers["harnessd-memory"], {
    command: "harnessd",
    args: ["mcp", "memory", "--workspace", repo],
  });
  assert.equal(seen.inspect.gitStatus, "", "no generated path shows in git status");
  const prompt: string = seen.argv[seen.argv.indexOf("-p") + 1];
  assert.ok(prompt.includes(`${join(repo, ".harnessd", "vault")}/`), "the prompt names the vault");
  assert.ok(prompt.includes(`${join(home, "vault")}/`));
  // Nothing shared was changed to hide the files.
  assert.doesNotMatch(await readFile(join(repo, ".git", "config"), "utf8"), /excludesFile/i);
  assert.doesNotMatch(
    await readFile(join(repo, ".git", "info", "exclude"), "utf8").catch(() => ""),
    /harnessd|\.mcp\.json/,
  );
});

test("a sync failure fails the run before the agent starts: one retry, then Needs input", async () => {
  const home = await mkdtemp(join(tmpdir(), "harnessd-syncfail-"));
  roots.push(home);
  // "/repo" has no .harnessd/, so the sync into the worktree fails.
  const t = setup({ extra: { globalDir: home } });
  const parent = t.linear.add({ title: "P", state: "In Progress" });
  const part = t.linear.add({
    title: "Sync breaks",
    parentId: parent.id,
    description: `${partMarker("backend")}\n**Size**: S`,
  });

  // The tick dispatches twice, so the retry comes in the same tick.
  await t.loop.tick();
  await t.loop.idle();
  assert.deepEqual(t.adapter.runs(), [], "the agent never started");
  const bodies = t.linear.comments.filter((c) => c.key === part.key).map((c) => c.body);
  assert.equal(bodies.length, 2);
  assert.match(
    bodies[0] ?? "",
    /failed \(error: harnessd sync into the worktree failed: .*no \.harnessd\/ folder.*\)\. Back to Ready/,
  );
  assert.deepEqual(t.wt.removed, [`/wt/${part.key}`, `/wt/${part.key}`]);
  assert.deepEqual(
    t.linear.moves.filter((m) => m.key === part.key).map((m) => m.state),
    ["In Progress", "Ready", "In Progress", "Needs input"],
  );
  assert.equal(part.state, "Needs input");
  assert.match(t.linear.comments.at(-1)?.body ?? "", /failed twice \(error: harnessd sync/);
});

// --- self-update (MET-63) -----------------------------------------------------

const FROM = "aaaaaaa1111";
const TO = "bbbbbbb2222";

/** A fake updater: `target` is what the next check finds, `result` what an apply returns. */
function fakeUpdater(result: SelfUpdateResult = { status: "applied" }, runningCommit = FROM) {
  const u = {
    target: undefined as SelfUpdateTarget | undefined,
    result,
    checks: 0,
    applied: [] as SelfUpdateTarget[],
    pauses: [] as string[],
    paused: false,
  };
  const selfUpdate: LoopSelfUpdate = {
    updater: {
      runningCommit,
      async checkForUpdate() {
        u.checks++;
        return u.target;
      },
      async applyUpdate(target) {
        u.applied.push(target);
        return u.result;
      },
    },
    async pause(reason) {
      u.paused = true;
      u.pauses.push(reason);
    },
  };
  return { u, extra: { selfUpdate, paused: () => u.paused } };
}

/** A clock the test moves; intervals are real. */
function testClock(start = Date.UTC(2026, 10, 21, 9)) {
  const clock = { at: start, ...systemClock, now: () => new Date(clock.at) };
  return clock;
}

const selfPings = (t: ReturnType<typeof setup>) => t.pings.filter((p) => /self-update/.test(p));

test("a merge with an update pending dispatches nothing until inFlight empties, then updates", async () => {
  const f = fakeUpdater();
  const t = setup({ extra: f.extra });
  const { parent } = await approved(t);
  assert.equal(f.u.checks, 1, "one check at start, no update then");
  assert.deepEqual(f.u.applied, []);

  // Another part runs while CI is still pending on PR #7.
  const other = t.linear.add({
    title: "Other",
    description: `${partMarker("backend-2")}\n**Size**: S`,
  });
  t.gh.statuses[7] = { checks: [{ name: "CI / test", state: "pending", detail: "IN_PROGRESS" }] };
  assert.deepEqual((await t.loop.tick()).dispatched, [other.key]);

  // PR #7 merges; the default branch now has a newer harnessd.
  delete t.gh.statuses[7];
  f.u.target = { from: FROM, to: TO };
  const third = t.linear.add({
    title: "Third",
    description: `${partMarker("backend-3")}\n**Size**: S`,
  });
  const ready = t.linear.add({ title: "New work", description: BODY("S") });
  const tasks = t.adapter.tasks.length;
  const merged = await t.loop.tick();
  assert.equal(merged.merged.length, 1);
  assert.deepEqual(merged.dispatched, []);
  assert.equal(f.u.checks, 3, "the merge tick checked the default branch");
  assert.equal(t.memory.state.selfUpdate?.state, "pending");
  assert.deepEqual(t.memory.state.selfUpdate?.trigger, {
    id: parent.id,
    key: parent.key,
    url: `https://linear.test/${parent.key}`,
  });
  assert.deepEqual(f.u.applied, [], "a run is still in flight");

  // Still waiting: nothing is dispatched, grilled or split.
  assert.deepEqual((await t.loop.tick()).dispatched, []);
  assert.equal(t.adapter.tasks.length, tasks, "no grill, plan or part run");
  assert.equal(third.state, "Ready");
  assert.equal(ready.state, "Ready");
  assert.deepEqual(f.u.applied, []);

  // The run finishes normally; the next tick is the safe point.
  t.adapter.pending.at(-1)?.finish("ok");
  await t.loop.idle();
  assert.equal(other.state, "In Review");
  const safe = await t.loop.tick();
  assert.deepEqual(safe.dispatched, []);
  assert.deepEqual(f.u.applied, [{ from: FROM, to: TO }]);
  assert.equal(t.memory.state.selfUpdate?.state, "applying");
  assert.ok(t.logs.some((l) => l === "self-update: aaaaaaa -> bbbbbbb: built, restarting"));

  // Until the restart lands, this process dispatches nothing.
  assert.deepEqual((await t.loop.tick()).dispatched, []);
  assert.equal(f.u.applied.length, 1);
});

test("a default branch update outside the merge queue waits for the run to finish", async () => {
  const f = fakeUpdater();
  const t = setup({ extra: f.extra });
  const part = t.linear.add({
    title: "Work",
    description: `${partMarker("backend")}\n**Size**: S`,
  });
  assert.deepEqual((await t.loop.tick()).dispatched, [part.key]);

  f.u.target = { from: FROM, to: TO };
  const later = t.linear.add({
    title: "Later",
    description: `${partMarker("frontend")}\n**Size**: S`,
  });
  assert.deepEqual((await t.loop.tick()).dispatched, []);
  assert.equal(t.memory.state.selfUpdate?.state, "pending");
  assert.equal(t.memory.state.selfUpdate?.trigger, undefined);
  assert.equal(later.state, "Ready");
  assert.deepEqual(f.u.applied, []);

  t.adapter.pending.at(-1)?.finish("ok");
  await t.loop.idle();
  await t.loop.tick();
  assert.deepEqual(f.u.applied, [{ from: FROM, to: TO }]);
  assert.equal(later.state, "Ready");
});

/** A QA approval of PR #9 already in loop.json, so a test can merge it at will. */
function seededMerge(t: ReturnType<typeof setup>) {
  const fx = qaFixture(t);
  fx.qa.state = "In Review";
  t.memory.state.reviewerHeads ??= {};
  t.memory.state.reviewerHeads[fx.backend.id] = {
    sha: "sha9",
    verdict: "approved",
    findings: [],
    at: "2026-11-21T08:00:00.000Z",
  };
  t.memory.state.merges.push({
    qaId: fx.qa.id,
    qaKey: fx.qa.key,
    parentId: fx.parent.id,
    parentKey: fx.parent.key,
    parentUrl: `https://linear.test/${fx.parent.key}`,
    approvedAt: "2026-11-21T08:00:00.000Z",
    prs: [
      {
        partId: fx.backend.id,
        partKey: fx.backend.key,
        number: 9,
        url: "https://github.test/o/r/pull/9",
        sha: "sha9",
      },
    ],
  });
  t.gh.statuses[9] = { checks: [{ name: "CI / test", state: "pending", detail: "IN_PROGRESS" }] };
  return fx;
}

test("a run over its size budget while an update waits is stopped, kept and run again after the restart", async () => {
  const clock = testClock();
  const f = fakeUpdater();
  const t = setup({ extra: { ...f.extra, clock } });
  const fx = seededMerge(t);
  const slow = t.linear.add({
    title: "Slow",
    description: `${partMarker("backend-2")}\n**Size**: S`,
  });
  assert.deepEqual((await t.loop.tick()).dispatched, [slow.key]);

  // A human merges PR #9 on GitHub; the default branch has a newer harnessd.
  f.u.target = { from: FROM, to: TO };
  t.gh.statuses[9] = { state: "MERGED" };
  clock.at += 10 * 60_000;
  await t.loop.tick();
  assert.equal(fx.backend.state, "Done");
  assert.equal(t.memory.state.selfUpdate?.state, "pending");
  assert.equal(t.memory.state.selfUpdate?.trigger?.key, fx.parent.key);
  assert.deepEqual(f.u.applied, [], "S budget is 30 min; 10 min in, it waits");
  assert.equal(slow.state, "In Progress");

  clock.at += 25 * 60_000;
  await t.loop.tick();
  assert.equal(slow.state, "Ready", "stopped and re-queued");
  assert.deepEqual(
    t.memory.state.interrupted.map((r) => [r.issueKey, r.reason, r.worktree]),
    [[slow.key, "self-update", `/wt/${slow.key}`]],
  );
  assert.match(
    t.linear.comments.at(-1)?.body ?? "",
    /Stopped over its budget while a self-update waited.*worktree kept/,
  );
  assert.deepEqual(f.u.applied, [{ from: FROM, to: TO }], "then the safe point");
  assert.deepEqual(t.memory.state.attempts, {}, "no attempt counted");

  // The restart: a new process reads the record, logs it and picks the run back up.
  const restarted = setup({
    store: t.memory,
    linear: t.linear,
    adapter: t.adapter,
    extra: { ...fakeUpdater({ status: "applied" }, TO).extra, clock },
  });
  const report = await restarted.loop.tick();
  assert.ok(restarted.logs.includes("self-update: aaaaaaa -> bbbbbbb"));
  assert.equal(t.memory.state.selfUpdate?.state, "done");
  assert.deepEqual(report.dispatched, [slow.key]);
  assert.match(t.adapter.runs().at(-1)?.prompt ?? "", /## Resumed/);
  assert.deepEqual(restarted.loop.snapshot().selfUpdate, {
    from: FROM,
    to: TO,
    at: clock.now().toISOString(),
    state: "done",
  });
});

test("an update waits when a stopped part cannot move back to Ready", async () => {
  const clock = testClock();
  const f = fakeUpdater();
  const t = setup({ extra: { ...f.extra, clock } });
  const slow = t.linear.add({
    title: "Slow",
    description: `${partMarker("backend")}\n**Size**: S`,
  });
  seededMerge(t);
  assert.deepEqual((await t.loop.tick()).dispatched, [slow.key]);
  f.u.target = { from: FROM, to: TO };
  t.gh.statuses[9] = { state: "MERGED" };
  const moveTo = t.linear.moveTo.bind(t.linear);
  t.linear.moveTo = async (id, state) => {
    if (id === slow.id && state === "Ready") throw new Error("Linear unavailable");
    await moveTo(id, state);
  };

  clock.at += 31 * 60_000;
  await t.loop.tick();
  assert.equal(slow.state, "In Progress");
  assert.deepEqual(f.u.applied, []);
  assert.deepEqual(
    t.memory.state.inFlight.map((run) => run.issueKey),
    [slow.key],
  );

  t.linear.moveTo = moveTo;
  const next = await t.loop.tick();
  assert.deepEqual(next.requeued, [slow.key]);
  assert.deepEqual(next.dispatched, []);
  assert.equal(slow.state, "Ready");
  assert.deepEqual(
    t.memory.state.interrupted.map((run) => run.issueKey),
    [slow.key],
  );
  assert.deepEqual(t.memory.state.inFlight, []);
  assert.deepEqual(f.u.applied, [{ from: FROM, to: TO }]);
});

test("a failed build keeps the old build, pauses, comments and moves the trigger to Needs input, once", async () => {
  const f = fakeUpdater({
    status: "failed",
    step: "build",
    error: "> tsc\n\nline 1\nline 2\nline 3\nline 4\nsrc/x.ts(1,1): error TS2322: bad\n",
  });
  const t = setup({ extra: f.extra });
  const fx = seededMerge(t);
  await t.loop.tick();
  f.u.target = { from: FROM, to: TO };
  t.gh.statuses[9] = { state: "MERGED" };
  await t.loop.tick();

  const detail = "build: line 1\nline 2\nline 3\nline 4\nsrc/x.ts(1,1): error TS2322: bad";
  assert.deepEqual(f.u.pauses, [`self-update failed: ${detail}`]);
  assert.equal(t.memory.state.selfUpdate?.state, "failed");
  assert.equal(t.memory.state.selfUpdate?.error, detail);
  assert.ok(t.memory.state.selfUpdateNotices[TO]);
  assert.equal(fx.parent.state, "Needs input");
  const comment = t.linear.comments.filter((c) => c.key === fx.parent.key).at(-1)?.body ?? "";
  assert.match(comment, /update from `aaaaaaa` to `bbbbbbb` failed at build/);
  assert.match(comment, /error TS2322: bad/);
  assert.match(comment, /harnessd resume/);
  assert.deepEqual(selfPings(t), [
    `${fx.parent.key} needs input (self-update failed): aaaaaaa -> bbbbbbb: ${detail.replace(/\n/g, " ")} https://linear.test/${fx.parent.key}`,
  ]);
  const ready = t.linear.add({ title: "Later", description: `${partMarker("x")}\n**Size**: S` });
  assert.equal((await t.loop.tick()).paused, true);
  assert.equal(ready.state, "Ready", "paused: nothing dispatched");

  // `harnessd resume`: the next tick checks again; the same target fails again, quietly.
  const comments = t.linear.comments.length;
  f.u.paused = false;
  await t.loop.tick();
  assert.equal(f.u.checks, 3);
  assert.equal(f.u.applied.length, 2);
  assert.equal(f.u.pauses.length, 2, "paused again");
  assert.equal(selfPings(t).length, 1, "no second notice for the same target");
  assert.equal(t.linear.comments.length, comments);
  assert.equal(ready.state, "Ready");
});

test("a failure at daemon start pauses and sends one notice, with no Linear call", async () => {
  const f = fakeUpdater({ status: "failed", step: "install", error: "ERR_PNPM_OUTDATED_LOCKFILE" });
  f.u.target = { from: FROM, to: TO };
  const t = setup({ extra: f.extra });
  const report = await t.loop.tick();
  assert.equal(report.paused, true);
  assert.deepEqual(f.u.pauses, ["self-update failed: install: ERR_PNPM_OUTDATED_LOCKFILE"]);
  assert.deepEqual(t.linear.comments, []);
  assert.deepEqual(t.linear.moves, []);
  assert.deepEqual(selfPings(t), [
    "harnessd needs input (self-update failed): aaaaaaa -> bbbbbbb: install: ERR_PNPM_OUTDATED_LOCKFILE",
  ]);
});

test("a dirty install clone blocks the update: paused with the reason, nothing discarded", async () => {
  const f = fakeUpdater({ status: "blocked", reason: "the install clone has local changes" });
  f.u.target = { from: FROM, to: TO };
  const t = setup({ extra: f.extra });
  await t.loop.tick();
  assert.deepEqual(f.u.pauses, ["self-update blocked: the install clone has local changes"]);
  assert.equal(t.memory.state.selfUpdate?.state, "blocked");
  assert.equal(t.memory.state.selfUpdate?.error, "the install clone has local changes");
  assert.deepEqual(selfPings(t), [
    "harnessd needs input (self-update blocked): aaaaaaa -> bbbbbbb: the install clone has local changes",
  ]);
  assert.deepEqual(t.loop.snapshot().selfUpdate?.state, "blocked");
});

test("with no selfUpdate option a pending record in loop.json holds nothing", async () => {
  const store = memoryStore({
    ...emptyLoopState(),
    selfUpdate: { from: FROM, to: TO, at: "2026-11-21T08:00:00.000Z", state: "pending" },
  });
  const t = setup({ store });
  const part = t.linear.add({
    title: "Work",
    description: `${partMarker("backend")}\n**Size**: S`,
  });
  assert.deepEqual((await t.loop.tick()).dispatched, [part.key]);
});

test("a pending record with no update left is dropped at start, not applied", async () => {
  const f = fakeUpdater();
  const store = memoryStore({
    ...emptyLoopState(),
    selfUpdate: { from: FROM, to: TO, at: "2026-11-21T08:00:00.000Z", state: "pending" },
  });
  const t = setup({ store, extra: f.extra });
  const part = t.linear.add({
    title: "Work",
    description: `${partMarker("backend")}\n**Size**: S`,
  });
  assert.deepEqual((await t.loop.tick()).dispatched, [part.key]);
  assert.deepEqual(f.u.applied, []);
  assert.equal(store.state.selfUpdate, undefined);
});

test("a failed pause write stops dispatch and raises Needs input until explicit resume", async () => {
  const f = fakeUpdater({ status: "failed", step: "build", error: "boom" });
  const t = setup({
    extra: {
      ...f.extra,
      selfUpdate: {
        ...f.extra.selfUpdate,
        async pause() {
          throw new Error("disk full");
        },
      },
    },
  });
  const fx = seededMerge(t);
  await t.loop.tick();
  f.u.target = { from: FROM, to: TO };
  t.gh.statuses[9] = { state: "MERGED" };
  assert.equal((await t.loop.tick()).paused, true);
  assert.equal(fx.parent.state, "Needs input");
  assert.equal(selfPings(t).length, 1);

  const ready = t.linear.add({
    title: "Later",
    description: `${partMarker("backend")}\n**Size**: S`,
  });
  const paused = await t.loop.tick();
  assert.equal(paused.paused, true);
  assert.deepEqual(paused.dispatched, []);
  assert.equal(ready.state, "Ready");
  assert.equal(f.u.applied.length, 1);

  f.u.target = undefined;
  t.loop.resume();
  assert.deepEqual((await t.loop.tick()).dispatched, [ready.key]);
  assert.equal(f.u.checks, 3);
});

test("a merge in a pass the pause flag stops is checked after resume, with its trigger", async () => {
  const f = fakeUpdater({ status: "blocked", reason: "the install clone has local changes" });
  const t = setup({ extra: f.extra });
  const fx = seededMerge(t);
  // A second approval, read after PR #9 in the same pass.
  const second = seededMerge(t);
  const entry = t.memory.state.merges.at(-1);
  if (entry?.prs[0]) {
    entry.prs[0].number = 10;
    entry.prs[0].url = "https://github.test/o/r/pull/10";
    entry.prs[0].sha = "sha10";
    const reviewer = t.memory.state.reviewerHeads?.[second.backend.id];
    if (reviewer !== undefined) reviewer.sha = "sha10";
  }
  t.gh.statuses[10] = t.gh.statuses[9] ?? {};
  await t.loop.tick();
  assert.equal(second.backend.state, "In Review");
  f.u.target = { from: FROM, to: TO };
  t.gh.statuses[9] = { state: "MERGED" };
  // The flag lands after PR #9 is recorded as merged, before PR #10 is read.
  const extra = t.gh.github.prStatus;
  t.gh.github.prStatus = async (n) => {
    const status = await extra(n);
    f.u.paused = true;
    return status;
  };
  await t.loop.tick();
  assert.equal(fx.backend.state, "Done");
  assert.deepEqual(f.u.applied, []);
  f.u.paused = false;
  await t.loop.tick();
  assert.deepEqual(f.u.applied, [{ from: FROM, to: TO }]);
  assert.equal(fx.parent.state, "Needs input");
});

// --- the ship step (MET-109) -------------------------------------------------

function remoteGit(remote: string, ...args: string[]): string {
  return execFileSync("git", ["--git-dir", remote, ...args], {
    encoding: "utf8",
    timeout: TEST_GIT_TIMEOUT_MS,
  }).trim();
}

/** A repo with a bare origin, its identity set, and a `.harnessd/` for the sync. */
async function shipRepo() {
  const root = await mkdtemp(join(tmpdir(), "harnessd-loop-ship-"));
  roots.push(root);
  const repo = join(root, "repo");
  const remote = join(root, "remote.git");
  execFileSync("git", ["init", "-q", "--bare", remote], { timeout: TEST_GIT_TIMEOUT_MS });
  execFileSync("git", ["init", "-q", "-b", "main", repo], { timeout: TEST_GIT_TIMEOUT_MS });
  git(repo, "config", "user.name", "Test Owner");
  git(repo, "config", "user.email", "owner@example.test");
  await writeFile(join(repo, "README.md"), "hi\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  await mkdir(join(repo, ".harnessd"), { recursive: true });
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "-q", "-u", "origin", "main");
  const globalDir = join(root, "global");
  await mkdir(globalDir, { recursive: true });
  return {
    root,
    repo,
    remote,
    globalDir,
    worktrees: createGitWorktrees({ repoDir: repo, root: join(root, "worktrees") }),
  };
}

function codexConfig() {
  const config = mergeLayers([]);
  const backend = config.agents.backend;
  assert.ok(backend);
  backend.harness = "codex";
  return config;
}

function onePart(linear: FakeLinear) {
  const parent = linear.add({ title: "P", state: "In Progress" });
  return linear.add({
    title: "Ship the run",
    parentId: parent.id,
    description: `${partMarker("backend")}\n**Size**: S`,
  });
}

/** A FakeLinear whose next move to In Review waits until the test releases it. */
class GatedLinear extends FakeLinear {
  gate: Promise<void> | undefined;
  /** Resolves once a held move to In Review is waiting. */
  held: Promise<void> = Promise.resolve();
  #release: () => void = () => {};
  #entered: () => void = () => {};

  holdNextInReview(): void {
    this.gate = new Promise((resolve) => {
      this.#release = resolve;
    });
    this.held = new Promise((resolve) => {
      this.#entered = resolve;
    });
  }

  releaseGate(): void {
    this.#release();
    this.gate = undefined;
  }

  override async moveTo(issueId: string, state: WorkflowStateName): Promise<void> {
    if (state === "In Review" && this.gate !== undefined) {
      this.#entered();
      await this.gate;
    }
    return super.moveTo(issueId, state);
  }
}

test("a Codex part run gets a commit, a push and a PR, then goes to In Review", async () => {
  const r = await shipRepo();
  const linear = new FakeLinear();
  const part = onePart(linear);
  const adapter = fakeAdapter({ id: "codex" });
  const t = setup({
    linear,
    adapter,
    config: codexConfig(),
    worktrees: r.worktrees,
    extra: { repoDir: r.repo, globalDir: r.globalDir, ship: shipPart },
  });

  assert.deepEqual((await t.loop.tick()).dispatched, [part.key]);
  const worktree = t.adapter.pending[0]?.cwd ?? "";
  await writeFile(join(worktree, "ship.ts"), "export const shipped = true;\n");
  const localHead = git(worktree, "rev-parse", "HEAD");
  t.adapter.pending[0]?.finish("ok", undefined, "Add the ship step.\n\nChecked with pnpm test.");
  await t.loop.idle();

  assert.equal(part.state, "In Review");
  assert.equal(t.gh.createdPrs.length, 1);
  const created = t.gh.createdPrs[0];
  assert.ok(created);
  assert.equal(created.title, `${part.key}: Ship the run`);
  assert.equal(created.base, "main");
  assert.match(created.body, /Add the ship step\./);
  assert.match(created.body, new RegExp(`Issue: https://linear.test/${part.key}`));
  assert.equal(
    remoteGit(r.remote, "log", "-1", "--format=%s", created.head),
    `${part.key}: Ship the run`,
  );
  assert.notEqual(
    remoteGit(r.remote, "rev-parse", created.head),
    localHead,
    "the daemon committed",
  );
});

test("a part Linear moved to In Progress after its PR opened goes back to In Review on the next tick", async () => {
  const t = setup();
  const part = onePart(t.linear);

  await t.loop.tick();
  t.gh.open(part.key, 7);
  t.adapter.pending[0]?.finish("ok");
  await t.loop.idle();
  assert.equal(part.state, "In Review");
  assert.equal(t.memory.state.shipped?.[part.id]?.key, part.key, "the part is recorded as shipped");

  // Linear's GitHub link moves the issue when the PR opens, a second after the ship step.
  part.state = "In Progress";
  await t.loop.tick();

  assert.equal(part.state, "In Review");
  const line = `${part.key}: Linear moved it to In Progress after its PR opened; back to In Review`;
  assert.deepEqual(
    t.logs.filter((l) => l === line),
    [line],
    "one line, once",
  );
  assert.ok(t.memory.state.shipped?.[part.id], "the record stays for the next check");
});

test("a part with an in-flight run is never moved back to In Review", async () => {
  const linear = new GatedLinear();
  const t = setup({ linear });
  const part = onePart(linear);

  await t.loop.tick();
  t.gh.open(part.key, 7);
  // The run's own move to In Review waits, so the run stays in flight.
  linear.holdNextInReview();
  t.adapter.pending[0]?.finish("ok");
  await linear.held;
  assert.deepEqual(t.loop.running(), [part.key]);
  assert.deepEqual(
    t.memory.state.inFlight.map((e) => e.issueKey),
    [part.key],
  );
  assert.equal(part.state, "In Progress");

  await t.loop.tick();
  assert.equal(part.state, "In Progress", "the run is not moved");
  assert.ok(!t.logs.some((l) => l.includes("after its PR opened")));

  linear.releaseGate();
  await t.loop.idle();
  assert.equal(part.state, "In Review");
});

test("a shipped part in In Progress whose PR is no longer open is not moved", async () => {
  const t = setup();
  const part = onePart(t.linear);
  await t.loop.tick();
  t.gh.open(part.key, 7);
  t.adapter.pending[0]?.finish("ok");
  await t.loop.idle();
  assert.equal(part.state, "In Review");

  // The PR is closed without a merge, and Linear moves the part to In Progress.
  delete t.gh.prs[part.key];
  part.state = "In Progress";
  await t.loop.tick();

  assert.equal(part.state, "In Progress", "no open PR, no move");
  assert.equal(t.memory.state.shipped?.[part.id], undefined, "the record is dropped");
  assert.ok(!t.logs.some((l) => l.includes("after its PR opened")));
});

test("a shipped part a human moved to Ready drops its record and is not moved", async () => {
  const t = setup();
  const part = onePart(t.linear);
  t.gh.open(part.key, 7);
  await t.loop.tick();
  t.adapter.pending[0]?.finish("ok");
  await t.loop.idle();
  assert.equal(part.state, "In Review");

  // A human moves it back for a rerun; a blocker keeps dispatch off it this tick.
  part.state = "Ready";
  const blocker = t.linear.add({ title: "Blocker", state: "In Progress" });
  t.linear.relations.push({ blocker: blocker.id, blocked: part.id });
  const moves = t.linear.moves.length;
  await t.loop.tick();

  assert.equal(part.state, "Ready");
  assert.deepEqual(t.linear.moves.slice(moves), [], "the loop does not move it");
  assert.equal(t.memory.state.shipped?.[part.id], undefined, "the record is dropped");
  assert.ok(!t.logs.some((l) => l.includes("after its PR opened")));
});

// --- the startup orphan sweep (MET-214) ------------------------------------

/** A split parent with its part and QA sub-issues, as a restart finds them in `loop.json`. */
function orphanFixture(linear: FakeLinear, states: { part?: string; qa?: string } = {}) {
  const parent = linear.add({ title: "Orphaned parent", state: "In Progress" });
  const part = linear.add({
    title: "The part",
    parentId: parent.id,
    state: states.part ?? "In Review",
    description: `${partMarker("backend")}\n**Size**: S`,
  });
  const qa = linear.add({
    title: `QA: ${parent.title}`,
    parentId: parent.id,
    state: states.qa ?? "In Progress",
  });
  linear.relations.push({ blocker: part.id, blocked: qa.id });
  const state = emptyLoopState();
  state.splits = {
    [parent.id]: { key: parent.key, parts: [part.id], qa: qa.id, at: "2026-11-23T00:00:00.000Z" },
  };
  return { parent, part, qa, state };
}

test("an orphaned QA ticket in In Progress goes back to Ready on the first tick (MET-214)", async () => {
  const linear = new FakeLinear();
  const { parent, part, qa, state } = orphanFixture(linear);
  const t = setup({ linear, store: memoryStore(state) });

  await t.loop.tick();

  assert.equal(qa.state, "Ready");
  assert.equal(part.state, "In Review", "the part is not touched");
  assert.equal(parent.state, "In Progress", "a split parent is never moved");
  const line = `${qa.key}: In Progress with no run after restart, back to Ready`;
  assert.deepEqual(
    t.logs.filter((l) => l === line),
    [line],
    "one line, once",
  );
  assert.deepEqual(
    t.linear.moves.filter((m) => m.key === qa.key),
    [{ key: qa.key, state: "Ready" }],
  );

  // The sweep is a first-tick check: a ticket left In Progress later is not moved.
  qa.state = "In Progress";
  await t.loop.tick();
  assert.equal(qa.state, "In Progress", "the sweep does not run again");
  assert.equal(t.logs.filter((l) => l === line).length, 1);
});

test("an orphaned part ticket in In Progress goes back to Ready too (MET-214)", async () => {
  const linear = new FakeLinear();
  const { part, qa, state } = orphanFixture(linear, { part: "In Progress", qa: "In Review" });
  const blocker = linear.add({ title: "Other work", state: "In Progress" });
  linear.relations.push({ blocker: blocker.id, blocked: part.id });
  const t = setup({ linear, store: memoryStore(state) });

  await t.loop.tick();

  assert.equal(part.state, "Ready");
  assert.equal(qa.state, "In Review", "the QA ticket is not touched");
  const line = `${part.key}: In Progress with no run after restart, back to Ready`;
  assert.deepEqual(
    t.logs.filter((l) => l === line),
    [line],
    "one line, once",
  );
});

test("a ticket with an in-flight entry or a pending QA verdict is not swept (MET-214)", async () => {
  const linear = new FakeLinear();
  const { qa, state } = orphanFixture(linear);
  state.inFlight.push({
    issueId: qa.id,
    issueKey: qa.key,
    role: "qa",
    agent: "qa",
    worktree: "",
    branch: "met-orphan-qa",
    startedAt: "2026-11-23T00:00:00.000Z",
    pid: 1,
  });
  const moveTo = linear.moveTo.bind(linear);
  let moves = 0;
  linear.moveTo = async (id, name) => {
    if (id === qa.id && name === "Ready") {
      moves += 1;
      throw new Error("fetch failed");
    }
    return moveTo(id, name);
  };
  const t = setup({ linear, store: memoryStore(state) });

  await t.loop.tick();

  assert.equal(qa.state, "In Progress", "the re-queue failed, and the sweep skips the run");
  assert.equal(moves, 1, "only the re-queue tried to move it");
  assert.ok(!t.logs.some((l) => l.includes("no run after restart")));

  // A verdict waiting in `pendingQa` keeps its QA ticket in place until it settles (D-058).
  const verdict = new FakeLinear();
  const pending = orphanFixture(verdict);
  pending.state.pendingQa = {
    [pending.qa.id]: {
      parentId: pending.parent.id,
      qaKey: pending.qa.key,
      reviews: [
        {
          partId: pending.part.id,
          partKey: pending.part.key,
          decision: "approve",
          failing: [],
          prNumber: 7,
          head: "sha7",
          event: "APPROVE",
          body: "Looks good.",
          done: false,
        },
      ],
      done: [],
    },
  };
  const gh = fakeGitHub();
  // The saved head is still the PR's head, so the retry tries the post and only the
  // network error keeps the record waiting (MET-233).
  gh.open(pending.part.key, 7);
  const down: GitHub = {
    ...gh.github,
    async postReview() {
      throw new Error("read ECONNRESET");
    },
  };
  const waitingStore = memoryStore(pending.state);
  const waiting = setup({
    linear: verdict,
    store: waitingStore,
    extra: { github: down },
  });

  await waiting.loop.tick();

  assert.equal(pending.qa.state, "In Progress", "the verdict is still waiting");
  assert.ok(waitingStore.state.pendingQa?.[pending.qa.id]);
  assert.ok(!waiting.logs.some((l) => l.includes("no run after restart")));
});

test("a part with a shipped record is not swept while the state repair cannot read its PR (MET-214)", async () => {
  const linear = new FakeLinear();
  const { part, qa, state } = orphanFixture(linear, { part: "In Progress", qa: "In Review" });
  state.shipped = {
    [part.id]: {
      key: part.key,
      branch: "met-orphan-the-part",
      prUrl: "https://github.test/o/r/pull/7",
      at: "2026-11-23T00:00:00.000Z",
    },
  };
  const gh = fakeGitHub();
  const github: GitHub = {
    ...gh.github,
    async findPrByHead() {
      throw new Error("fetch failed");
    },
  };
  const store = memoryStore(state);
  const t = setup({ linear, store, extra: { github } });

  await t.loop.tick();

  assert.equal(part.state, "In Progress", "the shipped record keeps it out of the sweep");
  assert.ok(store.state.shipped?.[part.id], "the record stays for the next state check");
  assert.equal(qa.state, "In Review");
  assert.ok(!t.logs.some((l) => l.includes("no run after restart")));
});

test("a failed orphan move is logged and retried on the next tick until it succeeds (MET-214)", async () => {
  const linear = new FakeLinear();
  const { qa, state } = orphanFixture(linear);
  const moveTo = linear.moveTo.bind(linear);
  let down = true;
  linear.moveTo = async (id, name) => {
    if (down && id === qa.id && name === "Ready") throw new Error("fetch failed");
    return moveTo(id, name);
  };
  const t = setup({ linear, store: memoryStore(state) });

  await t.loop.tick();

  assert.equal(qa.state, "In Progress");
  assert.ok(t.logs.includes(`could not move ${qa.key} to Ready: fetch failed`));
  assert.ok(!t.logs.some((l) => l.includes("no run after restart")));

  down = false;
  await t.loop.tick();

  assert.equal(qa.state, "Ready");
  const line = `${qa.key}: In Progress with no run after restart, back to Ready`;
  assert.deepEqual(
    t.logs.filter((l) => l === line),
    [line],
    "logged once, when the move succeeds",
  );
});

test("a run with no changes fails as no changes and does not go to In Review", async () => {
  const r = await shipRepo();
  const linear = new FakeLinear();
  const part = onePart(linear);
  const adapter = fakeAdapter({ id: "codex" });
  const t = setup({
    linear,
    adapter,
    config: codexConfig(),
    worktrees: r.worktrees,
    extra: { repoDir: r.repo, globalDir: r.globalDir, ship: shipPart },
  });

  await t.loop.tick();
  t.adapter.pending[0]?.finish("ok", undefined, "Nothing changed.");
  await t.loop.idle();

  assert.equal(part.state, "Ready");
  assert.ok(!t.linear.moves.some((m) => m.key === part.key && m.state === "In Review"));
  assert.equal(t.gh.createdPrs.length, 0);
  assert.match(t.linear.comments.at(-1)?.body ?? "", /no changes/);
});

test("a rejected push fails as push failed and does not go to In Review", async () => {
  const r = await shipRepo();
  const hook = join(r.remote, "hooks", "pre-receive");
  await mkdir(join(r.remote, "hooks"), { recursive: true });
  await writeFile(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const linear = new FakeLinear();
  const part = onePart(linear);
  const adapter = fakeAdapter({ id: "codex" });
  const t = setup({
    linear,
    adapter,
    config: codexConfig(),
    worktrees: r.worktrees,
    extra: { repoDir: r.repo, globalDir: r.globalDir, ship: shipPart },
  });

  await t.loop.tick();
  const worktree = t.adapter.pending[0]?.cwd ?? "";
  await writeFile(join(worktree, "ship.ts"), "export const shipped = true;\n");
  t.adapter.pending[0]?.finish("ok", undefined, "Add it.");
  await t.loop.idle();

  assert.equal(part.state, "Ready");
  assert.equal(t.gh.createdPrs.length, 0);
  assert.match(t.linear.comments.at(-1)?.body ?? "", /push failed: /);
});

test("an open PR is pushed to and not created twice", async () => {
  const r = await shipRepo();
  const linear = new FakeLinear();
  const part = onePart(linear);
  const adapter = fakeAdapter({ id: "codex" });
  const t = setup({
    linear,
    adapter,
    config: codexConfig(),
    worktrees: r.worktrees,
    extra: { repoDir: r.repo, globalDir: r.globalDir, ship: shipPart },
  });
  const branch = `${part.key.toLowerCase()}-ship-the-run`;
  t.gh.open(part.key, 7, branch);

  await t.loop.tick();
  const worktree = t.adapter.pending[0]?.cwd ?? "";
  await writeFile(join(worktree, "ship.ts"), "export const shipped = true;\n");
  const localHead = git(worktree, "rev-parse", "HEAD");
  t.adapter.pending[0]?.finish("ok", undefined, "Add it.");
  await t.loop.idle();

  assert.equal(part.state, "In Review");
  assert.equal(t.gh.createdPrs.length, 0);
  assert.notEqual(remoteGit(r.remote, "rev-parse", branch), localHead);
});

test("a self-update waits for the ship step to finish", async () => {
  const f = fakeUpdater();
  let release: (result: ShipResult) => void = () => {};
  const held = new Promise<ShipResult>((resolve) => {
    release = resolve;
  });
  let enterShip: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    enterShip = resolve;
  });
  const ship: ShipRun = async () => {
    enterShip();
    return held;
  };
  const t = setup({ extra: { ...f.extra, ship } });
  await approved(t);

  const part = t.linear.add({
    title: "Ship the run",
    description: `${partMarker("backend")}\n**Size**: S`,
  });
  // Keep the approved PR from merging in the dispatch tick.
  t.gh.statuses[7] = { checks: [{ name: "CI / test", state: "pending", detail: "IN_PROGRESS" }] };
  assert.deepEqual((await t.loop.tick()).dispatched, [part.key]);

  // A merge to the default branch now asks for an update while the part runs.
  f.u.target = { from: FROM, to: TO };
  t.gh.statuses[7] = { state: "MERGED" };
  await t.loop.tick();
  assert.equal(t.memory.state.selfUpdate?.state, "pending");
  assert.deepEqual(f.u.applied, [], "the part is in flight");

  t.adapter.pending.at(-1)?.finish("ok", undefined, "Add it.");
  await started; // the ship step is waiting on the push and the PR

  // A tick during the ship must not restart the daemon.
  await t.loop.tick();
  assert.deepEqual(f.u.applied, [], "the run is still shipping");
  assert.deepEqual(
    t.memory.state.inFlight.map((e) => e.issueKey),
    [part.key],
    "the run stays in flight until its work is recorded",
  );

  // The ship returns: the run is recorded, then the next tick is the safe point.
  release({ ok: true, committed: true, prUrl: "https://github.test/pr", created: true });
  await t.loop.idle();
  assert.equal(part.state, "In Review");
  assert.deepEqual(t.memory.state.inFlight, []);
  await t.loop.tick();
  assert.deepEqual(f.u.applied, [{ from: FROM, to: TO }]);
});

test("a synced file stays out of the daemon's commit", async () => {
  const r = await shipRepo();
  const linear = new FakeLinear();
  onePart(linear);
  const adapter = fakeAdapter({ id: "codex" });
  const t = setup({
    linear,
    adapter,
    config: codexConfig(),
    worktrees: r.worktrees,
    extra: { repoDir: r.repo, globalDir: r.globalDir, ship: shipPart },
  });

  await t.loop.tick();
  const worktree = t.adapter.pending[0]?.cwd ?? "";
  assert.ok(existsSync(join(worktree, "AGENTS.md")), "the sync wrote the generated file");
  await writeFile(join(worktree, "ship.ts"), "export const shipped = true;\n");
  t.adapter.pending[0]?.finish("ok", undefined, "Add it.");
  await t.loop.idle();

  const created = t.gh.createdPrs[0];
  assert.ok(created);
  const tree = remoteGit(r.remote, "ls-tree", "-r", "--name-only", created.head);
  assert.match(tree, /ship\.ts/);
  assert.doesNotMatch(tree, /AGENTS\.md/);
});

test("QA, grill and plan runs never ship", async () => {
  const shipped: ShipInput[] = [];
  const spy: ShipRun = async (input) => {
    shipped.push(input);
    return { ok: true, committed: false, prUrl: "https://github.test/pr", created: false };
  };

  const splitAdapter = fakeAdapter({ plans: { "MET-100": plan(["backend", "S", "API"]) } });
  const split = setup({ adapter: splitAdapter, extra: { ship: spy } });
  split.linear.add({ title: "Feature", labels: ["ui"], description: BODY("M") });
  await split.loop.tick();
  assert.deepEqual(shipped, [], "grill and plan runs do not ship");

  const qa = setup({ extra: { ship: spy } });
  const { backend, qa: qaIssue } = qaFixture(qa);
  qa.gh.open(backend.key, 7);
  assert.deepEqual((await qa.loop.tick()).dispatched, [qaIssue.key]);
  await settle();
  qa.adapter.pending[0]?.finish("ok", undefined, verdict(true, true));
  await qa.loop.idle();
  assert.deepEqual(shipped, [], "a QA run does not ship");
});

// --- token spend (D-040) ----------------------------------------------------

test("the default max_concurrent is 1", async () => {
  assert.equal(mergeLayers([]).limits.max_concurrent, 1);
  const t = setup({ config: mergeLayers([]) });
  const parent = t.linear.add({ title: "P", state: "In Progress" });
  for (const role of ["backend", "frontend"]) {
    t.linear.add({
      title: role,
      parentId: parent.id,
      description: `${partMarker(role)}\n**Size**: S`,
    });
  }
  const report = await t.loop.tick();
  assert.deepEqual(report.dispatched, [t.linear.byKey("MET-101").key]);
  assert.equal(t.loop.running().length, 1);
});

test("a plan with no reason is rejected twice and goes to Needs input", async () => {
  const adapter = fakeAdapter({
    plans: { "MET-100": planWithoutReason(["backend", "S", "API"], ["frontend", "S", "UI"]) },
  });
  const t = setup({ adapter });
  const parent = t.linear.add({ title: "Big", labels: ["ui"], description: BODY("M") });

  const report = await t.loop.tick();

  assert.deepEqual(report.escalated, [parent.key]);
  assert.deepEqual(t.linear.children(parent), [], "no sub-issue");
  assert.equal(parent.state, "Needs input");
  const comment = t.linear.comments.find((c) => c.key === parent.key && /split/.test(c.body));
  assert.match(comment?.body ?? "", /- reason: expected a non-empty string/);
  assert.equal(
    t.adapter.tasks.filter((task) => task.id.startsWith("plan-")).length,
    2,
    "the plan ran twice",
  );
  assert.equal(t.pings.length, 1);
});

test("part 2 waits while part 1 is In Review, and starts after part 1 is merged", async () => {
  const t = setup();
  const parent = t.linear.add({ title: "P", state: "In Progress" });
  const first = t.linear.add({
    title: "First",
    parentId: parent.id,
    state: "In Review",
    description: `${partMarker("backend")}\n**Size**: S`,
  });
  const second = t.linear.add({
    title: "Second",
    parentId: parent.id,
    description: `${partMarker("frontend")}\n**Size**: S`,
  });
  t.linear.relations.push({ blocker: first.id, blocked: second.id });

  assert.deepEqual((await t.loop.tick()).dispatched, []);
  assert.equal(second.state, "Ready");

  first.state = "Done";
  assert.deepEqual((await t.loop.tick()).dispatched, [second.key]);
  assert.equal(second.state, "In Progress");
});

test("an approved part with an unchanged head gets no second QA run; a new head runs QA once", async () => {
  const t = setup();
  const fx = qaFixture(t);
  const { parent, backend, qa } = fx;
  trackShippedPart(t, fx);
  t.gh.open(backend.key, 7);
  await t.loop.tick();
  await settle();
  t.adapter.pending.at(-1)?.finish("ok", undefined, verdict(true, true));
  await t.loop.idle();
  assert.deepEqual(t.memory.state.reviewedHeads?.[backend.id], {
    sha: "sha7",
    verdict: "approved",
  });

  // Keep the merge gate waiting so the part stays In Review.
  t.gh.statuses[7] = { checks: [{ name: "CI / test", state: "pending", detail: "IN_PROGRESS" }] };
  const qaRuns = () => t.adapter.runs().filter((r) => r.id.includes("-qa-")).length;
  assert.equal(qaRuns(), 1);
  await t.loop.tick();
  await t.loop.tick();
  assert.equal(qaRuns(), 1, "the approved head is not reviewed again");
  assert.equal(parent.state, "In Progress");

  // A new head is reviewed exactly once.
  const pr = t.gh.prs[backend.key];
  assert.ok(pr);
  pr.headRefOid = "sha7-pushed-later";
  t.gh.statuses[7] = { headRefOid: "sha7-pushed-later", checks: [] };
  const reviewRunCount = t.adapter.pending.length + 1;
  assert.deepEqual((await t.loop.tick()).dispatched, [backend.key]);
  (await nextRun(t.adapter, reviewRunCount)).finish(
    "ok",
    undefined,
    JSON.stringify({ decision: "approve", findings: [] }),
  );
  await t.loop.idle();
  assert.deepEqual((await t.loop.tick()).dispatched, [qa.key]);
  await settle();
  t.adapter.pending.at(-1)?.finish("ok", undefined, verdict(true, true));
  await t.loop.idle();
  assert.equal(qaRuns(), 2);
  assert.deepEqual(t.memory.state.reviewedHeads?.[backend.id], {
    sha: "sha7-pushed-later",
    verdict: "approved",
  });
  await t.loop.tick();
  assert.equal(qaRuns(), 2, "the new head is reviewed once");
});

test("a run's usage adds to the parent sum, logs a line and survives a reload", async () => {
  const t = setup();
  const parent = t.linear.add({ title: "P", state: "In Progress" });
  t.linear.add({
    title: "API",
    parentId: parent.id,
    description: `${partMarker("backend")}\n**Size**: S`,
  });

  await t.loop.tick();
  t.adapter.pending[0]?.finish(
    "ok",
    undefined,
    "Done.",
    undefined,
    {
      input: 100,
      output: 20,
      cacheRead: 30,
      cacheWrite: 5,
    },
    4,
  );
  await t.loop.idle();

  assert.deepEqual(t.memory.state.usage?.[parent.id], { input: 100, cached: 35, output: 20 });
  assert.ok(
    t.logs.some((l) => l.includes("used 100 input, 35 cached, 20 output tokens in 4 turns")),
    t.logs.join("\n"),
  );

  const reloaded = parseLoopState(JSON.stringify(t.memory.state));
  assert.deepEqual(reloaded.usage?.[parent.id], { input: 100, cached: 35, output: 20 });
});

test("the run log line keeps its old form when the harness reports no turns", async () => {
  const t = setup();
  const parent = t.linear.add({ title: "P", state: "In Progress" });
  t.linear.add({
    title: "API",
    parentId: parent.id,
    description: `${partMarker("backend")}\n**Size**: S`,
  });

  await t.loop.tick();
  t.adapter.pending[0]?.finish("ok", undefined, "Done.");
  await t.loop.idle();

  const line = t.logs.find((l) => l.includes("used 0 input, 0 cached, 0 output tokens"));
  assert.ok(line, t.logs.join("\n"));
  assert.doesNotMatch(line ?? "", /turns/);
});

test("a run with unknown usage logs it and adds nothing to the parent sum", async () => {
  const t = setup();
  const parent = t.linear.add({ title: "P", state: "In Progress" });
  const part = t.linear.add({
    title: "API",
    parentId: parent.id,
    description: `${partMarker("backend")}\n**Size**: S`,
  });

  await t.loop.tick();
  t.adapter.pending[0]?.finish(
    "ok",
    undefined,
    "Done.",
    undefined,
    emptyTokenUsage(),
    8,
    undefined,
    undefined,
    true,
  );
  await t.loop.idle();

  assert.equal(t.memory.state.usage?.[parent.id], undefined, "unknown usage adds nothing");
  assert.ok(t.logs.includes(`${part.key}: backend usage unknown in 8 turns`), t.logs.join("\n"));
});

test("a Codex run with real usage logs it and grows the parent's weighted budget", async () => {
  const adapter = fakeAdapter({ id: "codex" });
  const t = setup({ adapter, config: BACKEND_ON_CODEX });
  const parent = t.linear.add({ title: "P", state: "In Progress" });
  const part = t.linear.add({
    title: "API",
    parentId: parent.id,
    description: `${partMarker("backend")}\n**Size**: S`,
  });

  await t.loop.tick();
  t.adapter.pending[0]?.finish(
    "ok",
    undefined,
    "Done.",
    undefined,
    { input: 11_591, output: 39, cacheRead: 27_904, cacheWrite: 0 },
    8,
  );
  await t.loop.idle();

  const sum = t.memory.state.usage?.[parent.id];
  assert.deepEqual(sum, { input: 11_591, cached: 27_904, output: 39 });
  assert.equal(weightedTokens(sum ?? { input: 0, cached: 0, output: 0 }, 0.1), 14_420);
  assert.ok(
    t.logs.includes(
      `${part.key}: backend used 11591 input, 27904 cached, 39 output tokens in 8 turns`,
    ),
    t.logs.join("\n"),
  );
});

test("at or over the token budget nothing starts and the parent goes to Needs input", async () => {
  const config = mergeLayers([
    {
      scope: "workspace",
      dir: "/repo/.harnessd",
      settings: { limits: { token_budget: { S: 100, M: 100 } } },
      agents: {},
      rules: [],
      skills: [],
      mcp: {},
      skillSettings: {},
    },
  ]);
  const linear = new FakeLinear();
  const parent = linear.add({ title: "P", state: "In Progress", description: BODY("M") });
  linear.add({
    title: "API",
    parentId: parent.id,
    description: `${partMarker("backend")}\n**Size**: S`,
  });
  const store = memoryStore({
    ...emptyLoopState(),
    usage: { [parent.id]: { input: 100, cached: 0, output: 0 } },
  });
  const t = setup({ config, linear, store });

  const report = await t.loop.tick();

  assert.deepEqual(report.dispatched, []);
  assert.equal(t.adapter.runs().length, 0, "no run starts");
  assert.equal(parent.state, "Needs input");
  assert.match(
    t.linear.comments.find((c) => c.key === parent.key)?.body ?? "",
    /used 100 of its 100 weighted tokens \(100 input \+ 0 cached × 0\.1 → 0 weighted \+ 0 output\)/,
  );
  assert.equal(t.pings.length, 1);
  assert.deepEqual(
    { ...store.state.usageBaseline?.[parent.id], at: "t" },
    { input: 100, cached: 0, output: 0, at: "t" },
  );

  // The parent is already Needs input: a later tick does not spam the human.
  await t.loop.tick();
  assert.equal(t.pings.length, 1);
});

test("a second budget escalation counts from its own point after the human moves it back", async () => {
  const config = mergeLayers([
    {
      scope: "workspace",
      dir: "/repo/.harnessd",
      settings: { limits: { token_budget: { S: 100, M: 100 } } },
      agents: {},
      rules: [],
      skills: [],
      mcp: {},
      skillSettings: {},
    },
  ]);
  const linear = new FakeLinear();
  const parent = linear.add({ title: "P", state: "In Progress", description: BODY("M") });
  const part = linear.add({
    title: "API",
    parentId: parent.id,
    description: `${partMarker("backend")}\n**Size**: S`,
  });
  const qa = linear.add({
    title: "QA",
    parentId: parent.id,
    description: `${partMarker("qa")}\n**Size**: M`,
  });
  const store = memoryStore({
    ...emptyLoopState(),
    usage: { [parent.id]: { input: 100, cached: 0, output: 0 } },
    // A parent the loop already split: a Ready move finishes its split without a grill.
    splits: {
      [parent.id]: { key: parent.key, parts: [part.id], qa: qa.id, at: "2026-11-20T10:00:00.000Z" },
    },
  });
  const t = setup({ config, linear, store });

  await t.loop.tick();
  assert.equal(parent.state, "Needs input");
  assert.deepEqual(
    { ...store.state.usageBaseline?.[parent.id], at: "t" },
    { input: 100, cached: 0, output: 0, at: "t" },
  );

  // A human moves it back, more rounds spend past the budget, and the daemon restarts.
  parent.state = "Ready";
  store.state.usage = { [parent.id]: { input: 210, cached: 0, output: 0 } };
  const t2 = setup({ config, linear, store });
  await t2.loop.tick();
  assert.equal(parent.state, "Needs input");
  assert.equal(t2.pings.length, 1);
  assert.match(
    t2.linear.comments.findLast((c) => c.key === parent.key)?.body ?? "",
    /used 110 of its 100 weighted tokens/,
  );
  // The baseline is the cumulative sum, so the count restarts from here.
  assert.deepEqual(
    { ...store.state.usageBaseline?.[parent.id], at: "t" },
    { input: 210, cached: 0, output: 0, at: "t" },
  );

  // A new Ready move starts a fresh count: the part runs instead of escalating again.
  parent.state = "Ready";
  const report = await t2.loop.tick();
  assert.deepEqual(report.dispatched, [part.key]);
  assert.equal(parent.state, "In Progress");
  assert.equal(t2.pings.length, 1);
});

test("the budget weighs cached tokens, so the parent escalates once at the weighted sum", async () => {
  const config = mergeLayers([
    {
      scope: "workspace",
      dir: "/repo/.harnessd",
      settings: { limits: { token_budget: { S: 200, M: 200 } } },
      agents: {},
      rules: [],
      skills: [],
      mcp: {},
      skillSettings: {},
    },
  ]);
  const linear = new FakeLinear();
  const parent = linear.add({ title: "P", state: "In Progress", description: BODY("M") });
  linear.add({
    title: "API",
    parentId: parent.id,
    description: `${partMarker("backend")}\n**Size**: S`,
  });
  // 50 input + 50 output + 1000 cached × 0.1 = 200 weighted: exactly the budget.
  const store = memoryStore({
    ...emptyLoopState(),
    usage: { [parent.id]: { input: 50, cached: 1000, output: 50 } },
  });
  const t = setup({ config, linear, store });

  await t.loop.tick();
  assert.equal(parent.state, "Needs input");
  assert.equal(t.adapter.runs().length, 0, "no run starts");
  assert.equal(t.pings.length, 1);
  const body = t.linear.comments.find((c) => c.key === parent.key)?.body ?? "";
  assert.match(body, /used 200 of its 200 weighted tokens/);
  assert.match(body, /50 input \+ 1000 cached × 0\.1 → 100 weighted \+ 50 output/);

  // A second tick does not escalate again.
  await t.loop.tick();
  assert.equal(t.pings.length, 1);
});

test("the MET-128 build, a rework, one QA round and grill plus plan stay under the M default", async () => {
  const { limits } = mergeLayers([]);
  // The recorded MET-128 run, on 2026-11-22.
  const build = { input: 186_944, output: 57_383, cacheRead: 12_257_280, cacheWrite: 0 };
  // A representative QA round: one PR diff plus a few file reads. The headroom below
  // (about 2.2M tokens) is what keeps this test about the small build, not this guess.
  const qa = { input: 300_000, output: 20_000, cacheRead: 150_000, cacheWrite: 0 };
  const buildSum = tokenSumOf(build);
  const qaSum = tokenSumOf(qa);
  // Raw input, cached and output of the grill and plan for the same ticket.
  const grillPlan = { input: 540_000, cached: 0, output: 0 };

  assert.equal(weightedTokens(buildSum, limits.cached_token_weight), 1_470_055);
  const total =
    weightedTokens(buildSum, limits.cached_token_weight) * 2 +
    weightedTokens(qaSum, limits.cached_token_weight) +
    weightedTokens(grillPlan, limits.cached_token_weight);
  assert.ok(total < tokenBudgetFor("M", limits), `${total} of ${limits.token_budget.M}`);
  // At the old full count, one build alone was over the M default.
  assert.ok(weightedTokens(buildSum, 1) > limits.token_budget.M);

  // A parent that already spent exactly that still starts its next part under the default.
  const linear = new FakeLinear();
  const parent = linear.add({ title: "P", state: "In Progress", description: BODY("M") });
  const part = linear.add({
    title: "API",
    parentId: parent.id,
    description: `${partMarker("backend")}\n**Size**: S`,
  });
  const raw = {
    input: build.input * 2 + qa.input + grillPlan.input,
    cached: buildSum.cached * 2 + qaSum.cached + grillPlan.cached,
    output: build.output * 2 + qa.output + grillPlan.output,
  };
  assert.equal(weightedTokens(raw, limits.cached_token_weight), total);
  const store = memoryStore({ ...emptyLoopState(), usage: { [parent.id]: raw } });
  const t = setup({ linear, store });

  assert.deepEqual((await t.loop.tick()).dispatched, [part.key]);
  assert.equal(parent.state, "In Progress");
  assert.equal(t.adapter.runs().length, 1);
});
