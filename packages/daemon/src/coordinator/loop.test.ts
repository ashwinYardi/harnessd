import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  type AdapterEvent,
  type DecisionNote,
  emptyTokenUsage,
  type HarnessAdapter,
  type LinkedIssue,
  type MergedConfig,
  type Priority,
  type RunResult,
  type Task,
  type WorkflowStateName,
} from "@harnessd/shared";
import { mergeLayers } from "../config/merge.ts";
import type { GitHub, PullRequest, ReviewInput } from "../github/client.ts";
import type { CreateSubIssueInput, ListReadyOptions } from "../linear/client.ts";
import { parseLinkedIssue, type RawIssue } from "../linear/parse.ts";
import { createGitWorktrees, type TaskWorktrees, type Worktree } from "../worktrees/index.ts";
import { type CoordinatorLoopOptions, createCoordinatorLoop, type LoopLinear } from "./loop.ts";
import { partMarker, readPartMarker } from "./split.ts";
import { createFileLoopStore, emptyLoopState, type LoopState, type LoopStore } from "./state.ts";

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
  finish(status?: RunResult["status"], error?: string, text?: string): void;
}

/**
 * Answers grill runs with `grillReply`, plan runs with `plans[key]` (or "not json"),
 * and keeps every other run open until the test finishes it.
 */
function fakeAdapter(
  options: { grillReply?: string; plans?: Record<string, string>; id?: string } = {},
) {
  const tasks: Task[] = [];
  const pending: PendingRun[] = [];
  const adapter: HarnessAdapter = {
    id: "claude-code",
    start(task, cwd) {
      tasks.push(task);
      const result = (status: RunResult["status"], text?: string, error?: string): RunResult => {
        const r: RunResult = { status, exitCode: 0, durationMs: 1, tokens: emptyTokenUsage() };
        if (text !== undefined) r.finalText = text;
        if (error !== undefined) r.error = error;
        return r;
      };
      let resolve: (r: RunResult) => void = () => {};
      let promise: Promise<RunResult>;
      if (task.id.startsWith("grill-")) {
        promise = Promise.resolve(
          result("ok", options.grillReply ?? '{"calls":[],"escalation":null}'),
        );
      } else if (task.id.startsWith("plan-")) {
        const key = task.id.slice("plan-".length);
        promise = Promise.resolve(result("ok", options.plans?.[key] ?? "not json"));
      } else {
        promise = new Promise((r) => {
          resolve = r;
        });
        pending.push({
          task,
          cwd,
          finish: (status = "ok", error, text) => resolve(result(status, text, error)),
        });
      }
      const events = (async function* (): AsyncGenerator<AdapterEvent> {
        yield { type: "end", result: await promise };
      })();
      return { events, result: promise, cancel: async () => {} };
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
    },
    async recover() {},
  };
  return { worktrees, created, removed, checkouts };
}

function fakeGitHub() {
  const prs: Record<string, PullRequest> = {};
  const reviews: Array<ReviewInput & { number: number }> = [];
  const github: GitHub = {
    async findPrForIssue(key) {
      return prs[key];
    },
    async prFiles() {
      return [{ path: "src/x.ts", additions: 3, deletions: 1 }];
    },
    async postReview(number, review) {
      reviews.push({ number, ...review });
      return `https://github.test/o/r/pull/${number}#review-${reviews.length}`;
    },
  };
  const open = (key: string, number: number): PullRequest => {
    const pr: PullRequest = {
      number,
      title: `${key}: work`,
      url: `https://github.test/o/r/pull/${number}`,
      headRefName: key.toLowerCase(),
      headRefOid: `sha${number}`,
      baseRefName: "main",
      isDraft: false,
    };
    prs[key] = pr;
    return pr;
  };
  return { github, prs, reviews, open };
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
  const loop = createCoordinatorLoop({
    config: options.config ?? mergeLayers([]),
    linear,
    adapters: { "claude-code": adapter.adapter },
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
      async notify(text) {
        pings.push(text);
      },
    },
    log: (line) => logs.push(line),
    pid: 4242,
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
  ]);
  assert.equal(parent.state, "In Progress");
  assert.equal(report.split[0], parent.key);
  const splitComment = t.linear.comments.find((c) => c.body.startsWith("**Coordinator split**"));
  assert.match(splitComment?.body ?? "", new RegExp(`${qa.key} qa \\(M\\): blocked by`));

  // The grill ran first and its comment came before the split comment.
  assert.ok(t.adapter.tasks[0]?.id.startsWith("grill-"));
  assert.ok(t.adapter.tasks[1]?.id.startsWith("plan-"));
  assert.ok(t.linear.comments[0]?.body.startsWith("**Coordinator grill**"));

  // Both parts run right away with their size budgets; QA waits.
  assert.deepEqual(report.dispatched, [backend.key, frontend.key]);
  const runs = t.adapter.runs();
  assert.deepEqual(
    runs.map((r) => [r.id, r.budgetMs]),
    [
      [`${backend.key}-1`, 30 * 60_000],
      [`${frontend.key}-1`, 120 * 60_000],
    ],
  );
  assert.match(runs[0]?.prompt ?? "", /You are backend, the harnessd backend agent\./);
  assert.match(runs[0]?.prompt ?? "", new RegExp(`gh pr create --title "${backend.key}: `));
  assert.equal(t.adapter.pending[0]?.cwd, `/wt/${backend.key}`);
  assert.equal(backend.state, "In Progress");
  assert.equal(qa.state, "Ready");
  assert.deepEqual(t.loop.running(), [backend.key, frontend.key]);
  assert.equal(t.memory.state.inFlight.length, 2);
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
  const tasks = t.adapter.tasks.length;
  const report = await t.loop.tick();
  assert.deepEqual(report.split, [parent.key]);
  assert.deepEqual(t.linear.created, created, "no duplicate sub-issues");
  assert.equal(t.linear.relations.length, 2, "the missing relation is added back");
  assert.equal(t.adapter.tasks.length, tasks, "no second grill or plan");
  assert.equal(t.linear.comments.length, comments, "nothing new to report");
  assert.equal(parent.state, "In Progress");
});

test("at most 3 agents run at once; a finished run frees a slot", async () => {
  const t = setup();
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
  assert.equal(t.adapter.runs().length, 2);
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
    `${part.key} needs input (run failed): the backend run failed twice (timeout: over budget)`,
  ]);
  assert.equal(t.memory.state.attempts[part.id], undefined);

  await t.loop.tick();
  assert.equal(t.adapter.runs().length, 2, "Needs input is not picked up again");
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

test("QA waits for every part, checks the PR out at its head, tests it and approves", async () => {
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

  assert.deepEqual((await t.loop.tick()).dispatched, []);
  frontend.state = "Done";
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
  assert.equal(
    t.memory.state.inFlight[0]?.worktree,
    path,
    "the worktree is recorded for a restart",
  );

  t.adapter.pending[0]?.finish("ok", undefined, verdict(true, true));
  await t.loop.idle();
  assert.equal(t.gh.reviews.length, 1, "the Done part is not reviewed");
  assert.equal(t.gh.reviews[0]?.event, "APPROVE");
  assert.equal(t.gh.reviews[0]?.commitId, "sha7");
  assert.deepEqual(t.wt.removed, [path]);
  assert.equal(qa.state, "In Review");
  assert.equal(backend.state, "In Review");
  assert.match(t.linear.comments.at(-1)?.body ?? "", /approved.*\n\n.*PR #7.*review-1/s);
  assert.deepEqual(t.memory.state.inFlight, []);
  assert.deepEqual(t.memory.state.qaFailures, {});
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
    /Your PR is already open \(https:\/\/github\.test\/o\/r\/pull\/7\)/,
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
    `${parent.key} needs input (QA failed twice): ${qa.key} could not approve ${backend.key} https://linear.test/${parent.key}`,
  ]);

  const runs = t.adapter.runs().length;
  assert.deepEqual((await t.loop.tick()).dispatched, [], "no more loops");
  assert.equal(t.adapter.runs().length, runs);
  assert.equal(t.pings.length, 1);
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
