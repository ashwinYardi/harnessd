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
import type { CreateSubIssueInput, ListReadyOptions } from "../linear/client.ts";
import { parseLinkedIssue, type RawIssue } from "../linear/parse.ts";
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
} from "./loop.ts";
import { formatNotice } from "./notifier.ts";
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

// --- fake Linear -----------------------------------------------------------

interface FakeIssue {
  id: string;
  key: string;
  title: string;
  description: string;
  state: string;
  labels: string[];
  priority: Priority;
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
    return {
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
  }

  #linked(issue: FakeIssue): LinkedIssue {
    return parseLinkedIssue(this.raw(issue));
  }

  #ready(): LinkedIssue[] {
    return [...this.issues.values()]
      .filter((i) => i.state === "Ready")
      .map((i) => this.#linked(i))
      .sort((a, b) => a.priority - b.priority || a.key.localeCompare(b.key));
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
}

// --- fake adapter ----------------------------------------------------------

interface PendingRun {
  task: Task;
  cwd: string;
  finish(
    status?: RunResult["status"],
    error?: string,
    text?: string,
    resetAt?: string,
    tokens?: RunResult["tokens"],
  ): void;
}

/**
 * Answers grill runs with `grillReply`, plan runs with `plans[key]` (or "not json"),
 * and keeps every other run open until the test finishes it.
 */
function fakeAdapter(
  options: {
    grillReply?: string;
    plans?: Record<string, string>;
    id?: HarnessId;
    /** Grill and plan runs end with this status instead of `ok`. */
    grillStatus?: RunResult["status"];
    planStatus?: RunResult["status"];
  } = {},
) {
  const tasks: Task[] = [];
  const pending: PendingRun[] = [];
  const adapter: HarnessAdapter = {
    id: options.id ?? "claude-code",
    start(task, cwd) {
      tasks.push(task);
      const result = (
        status: RunResult["status"],
        text?: string,
        error?: string,
        resetAt?: string,
        tokens?: RunResult["tokens"],
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
        const key = task.id.slice("plan-".length);
        promise = Promise.resolve(
          result(options.planStatus ?? "ok", options.plans?.[key] ?? "not json"),
        );
      } else {
        promise = new Promise((r) => {
          resolve = r;
        });
        pending.push({
          task,
          cwd,
          finish: (status = "ok", error, text, resetAt, tokens) =>
            resolve(result(status, text, error, resetAt, tokens)),
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

function plan(...parts: Array<[string, string, string]>): string {
  return JSON.stringify({
    parts: parts.map(([role, size, title]) => ({ role, size, title, prompt: `Do ${title}.` })),
    ...(parts.length > 1 ? { reason: "The work does not fit one M part." } : {}),
  });
}

/** A multi-part plan with no reason: invalid, so the loop must use the one-part fallback. */
function planWithoutReason(...parts: Array<[string, string, string]>): string {
  return JSON.stringify({
    parts: parts.map(([role, size, title]) => ({ role, size, title, prompt: `Do ${title}.` })),
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

/** Lets every pending promise chain run (the fakes do no I/O). */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
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
    assert.match(child.description, /- \[ \] Works/);
  }
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
  assert.match(splitComment?.body ?? "", /Reason for more than one part: The work does not fit/);

  // The grill ran first and its comment came before the split comment.
  assert.ok(t.adapter.tasks[0]?.id.startsWith("grill-"));
  assert.ok(t.adapter.tasks[1]?.id.startsWith("plan-"));
  assert.ok(t.linear.comments[0]?.body.startsWith("**Coordinator grill**"));

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

test("an unusable plan falls back to one part: frontend for ui, at the issue size", async () => {
  const t = setup();
  const ui = t.linear.add({ title: "Board shows agents", labels: ["ui"], description: BODY("S") });
  const api = t.linear.add({ title: "Board API", labels: ["infra"], description: BODY("M") });

  await t.loop.tick();

  assert.deepEqual(t.linear.children(ui).map(roleOf), ["frontend", "qa"]);
  assert.deepEqual(t.linear.children(api).map(roleOf), ["backend", "qa"]);
  const [uiPart] = t.linear.children(ui) as [FakeIssue];
  assert.equal(uiPart.title, ui.title);
  assert.match(uiPart.description, /\*\*Size\*\*: S/);
  assert.match(
    t.linear.comments.find((c) => c.key === ui.key && c.body.includes("split"))?.body ?? "",
    /one-part fallback/,
  );
  assert.ok(t.logs.some((l) => l.includes("plan fallback: not JSON")));
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

test("an L issue is never run: L parts or an L fallback go to Needs input", async () => {
  const adapter = fakeAdapter({
    plans: {
      "MET-100": plan(["backend", "L", "Everything"]),
      "MET-102": plan(["backend", "M", "Half"], ["backend", "S", "Other half"]),
    },
  });
  const t = setup({ adapter });
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
  assert.match(comment(invalid.key), /plan reply was unusable/);
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

test("a limited run holds its harness until the reset while another harness keeps working", async () => {
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
  assert.deepEqual(
    t.logs.filter((l) => /limited until/.test(l)),
    [limitHoldLine("claude-code", resetAt)],
  );

  // Claude Code is held: the backend part waits, a new Codex part still starts.
  codex.pending[0]?.finish("ok");
  const ui2 = part(t, parent.id, "frontend", "UI 2");
  time.advance(30 * MINUTE);
  assert.deepEqual((await t.loop.tick()).dispatched, [ui2.key]);
  assert.equal(claude.runs().length, 1);
  assert.equal(
    t.logs.filter((l) => /limited until/.test(l)).length,
    1,
    "logged once, not per tick",
  );

  // The reset passes: the hold ends, once, and the part runs again.
  time.advance(30 * MINUTE);
  assert.deepEqual((await t.loop.tick()).dispatched, [a.key]);
  assert.deepEqual(t.memory.state.limits, {});
  assert.deepEqual(
    t.logs.filter((l) => /available again/.test(l)),
    [limitAvailableLine("claude-code")],
  );
  claude.pending.at(-1)?.finish("ok");
  codex.pending.at(-1)?.finish("ok");
  await t.loop.idle();
  assert.equal(a.state, "In Review");
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
  assert.deepEqual((await t.loop.tick()).dispatched, [first.key]);

  const { backend, qa } = qaFixture(t);
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
  assert.ok(t.logs.includes(`${a.key}: backend on Codex while Claude Code is limited`));
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
  return { parent, backend, qa };
}

const verdict = (...pass: boolean[]) =>
  JSON.stringify({
    items: pass.map((p, i) => ({ text: `item ${i + 1}`, pass: p, evidence: `evidence ${i + 1}` })),
    testsPassed: true,
  });

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
  assert.match(run?.prompt ?? "", /Open a file only to check a line the diff touches/);
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
  assert.deepEqual(
    t.memory.state.merges.map((m) => [m.qaKey, m.prs.map((p) => [p.number, p.sha])]),
    [[qa.key, [[7, "sha7"]]]],
    "one merge entry with one PR",
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

// --- merge gate (MET-14) ----------------------------------------------------

/** A parent with one backend part whose PR #7 QA has approved at sha7. */
async function approved(t: ReturnType<typeof setup>) {
  const fx = qaFixture(t);
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
  const { parent, backend, qa } = await approved(t);
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

  // QA approves again (a QA approval does not reset the gate count), CI fails again.
  assert.deepEqual((await t.loop.tick()).dispatched, [qa.key]);
  await settle();
  t.adapter.pending.at(-1)?.finish("ok", undefined, verdict(true, true));
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

test("a head that moved after QA approved is never merged: QA runs again on the new head", async () => {
  const t = setup();
  const { backend, qa } = await approved(t);
  t.gh.statuses[7] = { headRefOid: "sha7-pushed-later" };
  const pr = t.gh.prs[backend.key];
  assert.ok(pr);
  pr.headRefOid = "sha7-pushed-later";

  const report = await t.loop.tick();
  assert.deepEqual(t.gh.merges, []);
  assert.deepEqual(report.dispatched, [qa.key], "QA is back in Ready and runs again at once");
  assert.match(
    t.linear.comments.find((c) => c.key === qa.key && /moved from/.test(c.body))?.body ?? "",
    /moved from `sha7` to `sha7-pu` after QA approved it/,
  );
  assert.deepEqual(t.memory.state.qaFailures, {}, "no QA failure counted");
  await settle();
  assert.equal(t.wt.checkouts.at(-1)?.sha, "sha7-pushed-later");
  t.adapter.pending.at(-1)?.finish("ok", undefined, verdict(true, true));
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

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    encoding: "utf8",
  }).trim();
}

test("a restart re-queues runs left in loop.json, cleans their worktrees and counts no attempt", async () => {
  const root = await mkdtemp(join(tmpdir(), "harnessd-loop-"));
  roots.push(root);
  const repo = join(root, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
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
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
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
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
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
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
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
  assert.equal(t.linear.children(issue).length, 0, "no fallback split from a cancelled run");
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
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
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
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  execFileSync("git", ["clone", "-q", origin, repo]);
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
  return execFileSync("git", ["--git-dir", remote, ...args], { encoding: "utf8" }).trim();
}

/** A repo with a bare origin, its identity set, and a `.harnessd/` for the sync. */
async function shipRepo() {
  const root = await mkdtemp(join(tmpdir(), "harnessd-loop-ship-"));
  roots.push(root);
  const repo = join(root, "repo");
  const remote = join(root, "remote.git");
  execFileSync("git", ["init", "-q", "--bare", remote]);
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
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

test("a plan with two parts and no reason falls back to one part", async () => {
  const adapter = fakeAdapter({
    plans: { "MET-100": planWithoutReason(["backend", "S", "API"], ["frontend", "S", "UI"]) },
  });
  const t = setup({ adapter });
  const parent = t.linear.add({ title: "Big", labels: ["ui"], description: BODY("M") });

  await t.loop.tick();

  assert.deepEqual(t.linear.children(parent).map(roleOf), ["frontend", "qa"]);
  const comment = t.linear.comments.find((c) => c.key === parent.key && /split/.test(c.body));
  assert.match(comment?.body ?? "", /one-part fallback/);
  assert.match(t.logs.join("\n"), /plan fallback: reason: a plan with more than one part/);
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
  const { parent, backend, qa } = qaFixture(t);
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
  t.adapter.pending[0]?.finish("ok", undefined, "Done.", undefined, {
    input: 100,
    output: 20,
    cacheRead: 30,
    cacheWrite: 5,
  });
  await t.loop.idle();

  assert.deepEqual(t.memory.state.usage?.[parent.id], { input: 100, cached: 35, output: 20 });
  assert.ok(
    t.logs.some((l) => l.includes("used 100 input, 35 cached, 20 output tokens")),
    t.logs.join("\n"),
  );

  const reloaded = parseLoopState(JSON.stringify(t.memory.state));
  assert.deepEqual(reloaded.usage?.[parent.id], { input: 100, cached: 35, output: 20 });
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
    /used 100 of its 100 tokens/,
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
