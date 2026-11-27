import assert from "node:assert/strict";
import { delimiter } from "node:path";
import { test } from "node:test";
import {
  type AdapterEvent,
  type AdapterRun,
  emptyTokenUsage,
  type HarnessAdapter,
  type Issue,
  type LinkedIssue,
  type QaConfig,
  type ResolvedAgentConfig,
  type RunResult,
  type Task,
  type WorkflowStateName,
} from "@harnessd/shared";
import type { GitHub, PullRequest, PullRequestStatus, ReviewInput } from "../github/client.ts";
import type { Worktree } from "../worktrees/index.ts";
import { formatNotice, type Notifier } from "./notifier.ts";
import {
  buildQaPrompt,
  type CommandResult,
  type CommandRunner,
  decideReview,
  MAX_TEST_TAIL,
  type ParsedQaVerdict,
  type PrReview,
  parseQaVerdict,
  parseReQaVerdict,
  type QaRunInput,
  type QaRunResult,
  qaBrowserBinDir,
  qaChecklist,
  resetQaAppFailures,
  runQa,
  runQaTests,
  runShellCommand,
  runVerifyChecks,
  settleQa,
  type TestRun,
  verdictFromVerify,
} from "./qa.ts";
import type { QaAppInput, QaAppStart, QaAppStep } from "./qa-app.ts";
import { partMarker } from "./split.ts";
import { emptyLoopState } from "./state.ts";

const agent: ResolvedAgentConfig = {
  name: "qa",
  role: "qa",
  harness: "claude-code",
  instructions: "Be strict.",
  rules: [],
  skills: [],
};

function issue(key: string, extra: Partial<LinkedIssue> = {}): LinkedIssue {
  return {
    id: `id-${key}`,
    key,
    title: `Title ${key}`,
    description: "",
    priority: 0,
    state: "In Review",
    labels: [],
    size: "S",
    doneWhen: [],
    url: `https://linear.test/${key}`,
    blockedBy: [],
    blockers: [],
    ...extra,
  } as LinkedIssue;
}

const parent: Issue = issue("MET-50", {
  state: "In Progress",
  size: "M",
  doneWhen: [
    { text: "Avatars are served", checked: false },
    { text: "It has tests", checked: false },
  ],
});
const qa = issue("MET-53", { parentId: parent.id, description: partMarker("qa"), state: "Ready" });
const backend = issue("MET-51", { parentId: parent.id, description: partMarker("backend") });
const frontend = issue("MET-52", { parentId: parent.id, description: partMarker("frontend") });

/** A part body with the fixed brief (MET-162). */
const briefed = issue("MET-51", {
  parentId: parent.id,
  description: [
    partMarker("backend"),
    "",
    "**Goal**",
    "Serve the avatar field.",
    "",
    "**Done when**",
    "- [ ] Avatars are served",
    "",
    "**Files**",
    "- src/avatars.ts",
    "",
    "**Steps**",
    "1. Add the field.",
    "",
    "**Verify**",
    "- `pnpm test` → passes",
    "",
    "**Out of scope**",
    "The UI.",
    "",
    "**Size**: S",
  ].join("\n"),
});

/** A part the plan marked `QA: tests` (D-053). */
const testsBriefed = issue("MET-51", {
  parentId: parent.id,
  description: [
    partMarker("backend"),
    "",
    "**Goal**",
    "Serve the avatar field.",
    "",
    "**Done when**",
    "- [ ] Avatars are served",
    "",
    "**Files**",
    "- src/avatars.ts",
    "",
    "**Steps**",
    "1. Add the field.",
    "",
    "**Verify**",
    "- `pnpm check` → avatars pass",
    "- `pnpm lint` → no warnings",
    "",
    "**QA**: tests",
    "",
    "**Out of scope**",
    "The UI.",
    "",
    "**Size**: S",
  ].join("\n"),
});

function pr(number: number, key: string): PullRequest {
  return {
    number,
    title: `${key}: work`,
    url: `https://github.test/o/r/pull/${number}`,
    headRefName: `${key.toLowerCase()}-work`,
    headRefOid: `sha${number}`,
    baseRefName: "main",
    isDraft: false,
  };
}

type Reply =
  | string
  | {
      status: RunResult["status"];
      error?: string;
      /** The harness's own failure reason, e.g. turn_cap or stalled. */
      reason?: RunResult["reason"];
      /** The final assistant text for an `ok` run, e.g. a verdict. */
      text?: string;
      tokens?: RunResult["tokens"];
      turns?: number;
      usageUnknown?: true;
    };

function fakeAdapter(replies: Reply[]) {
  const tasks: Task[] = [];
  const cwds: string[] = [];
  const queue = [...replies];
  const adapter: HarnessAdapter = {
    id: "claude-code",
    start(task, worktree): AdapterRun {
      tasks.push(task);
      cwds.push(worktree);
      const reply = queue.shift() ?? "";
      const result: RunResult = {
        status: typeof reply === "string" ? "ok" : reply.status,
        exitCode: typeof reply === "string" || reply.status === "ok" ? 0 : 1,
        durationMs: 5,
        tokens: typeof reply === "string" ? emptyTokenUsage() : (reply.tokens ?? emptyTokenUsage()),
      };
      if (typeof reply === "string") result.finalText = reply;
      else {
        if (reply.text !== undefined) result.finalText = reply.text;
        if (reply.error !== undefined) result.error = reply.error;
        if (reply.reason !== undefined) result.reason = reply.reason;
        if (reply.turns !== undefined) result.turns = reply.turns;
        if (reply.usageUnknown === true) result.usageUnknown = true;
      }
      const events: AdapterEvent[] = [{ type: "end", result }];
      return {
        events: (async function* () {
          yield* events;
        })(),
        result: Promise.resolve(result),
        cancel: async () => {},
      };
    },
  };
  return { adapter, tasks, cwds };
}

interface Options {
  replies?: Reply[];
  prs?: Record<string, PullRequest>;
  /** Exit code of the test command. */
  testExit?: number;
  /** Exit code of another command by name; unset commands exit 0. */
  exits?: Record<string, number>;
  /** Output of a command by name; unset commands get the default line. */
  outputs?: Record<string, string>;
  /** Records the app starts a live review would make. */
  startApp?: (input: QaAppInput) => Promise<QaAppStart>;
  /** Make postReview refuse these events. */
  refuse?: string[];
  checkoutFails?: boolean;
  commands?: QaConfig;
}

function harness(options: Options = {}) {
  const reviews: Array<ReviewInput & { number: number }> = [];
  const checkouts: Array<{ issueKey: string; title: string; branch: string; sha: string }> = [];
  const removed: string[] = [];
  const removals: Array<{ path: string; options?: unknown }> = [];
  const commands: Array<{ command: string; cwd: string }> = [];
  const worktreeLog: string[] = [];
  const logs: string[] = [];
  const prs = options.prs ?? { [backend.key]: pr(7, backend.key) };
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
    async prFiles() {
      return [{ path: "src/avatars.ts", additions: 40, deletions: 2 }];
    },
    async prDiff() {
      return "diff --git a/src/avatars.ts b/src/avatars.ts\n+avatar";
    },
    createPr: () => Promise.reject(new Error("QA never opens a PR")),
    async postReview(number, review) {
      if (options.refuse?.includes(review.event)) {
        throw new Error("HTTP 422: Can not approve your own pull request");
      }
      reviews.push({ number, ...review });
      return `https://github.test/o/r/pull/${number}#review-${reviews.length}`;
    },
    prStatus: async (number): Promise<PullRequestStatus> => ({
      number,
      url: `https://github.test/o/r/pull/${number}`,
      state: "OPEN",
      headRefOid: "sha7",
      mergeable: "MERGEABLE",
      checks: [{ name: "CI / test", state: "pass", detail: "SUCCESS" }],
      files: [],
      changedFiles: 0,
    }),
    mergePr: () => Promise.reject(new Error("QA never merges")),
    addLabel: () => Promise.reject(new Error("QA never labels")),
  };
  const { adapter, tasks, cwds } = fakeAdapter(options.replies ?? []);
  const runCommand: CommandRunner = async (command, cwd): Promise<CommandResult> => {
    commands.push({ command, cwd });
    const exitCode =
      options.exits?.[command] ?? (command === "pnpm test" ? (options.testExit ?? 0) : 0);
    return {
      exitCode,
      timedOut: false,
      output: options.outputs?.[command] ?? (exitCode === 0 ? "ok 12" : "not ok 3 - avatars"),
    };
  };
  const deps = {
    github,
    worktrees: {
      async checkout(input: (typeof checkouts)[number]): Promise<Worktree> {
        if (options.checkoutFails) throw new Error("fetch failed");
        checkouts.push(input);
        return { path: `/wt/qa-${input.sha}`, branch: input.branch, resumed: false };
      },
      async remove(path: string, options?: unknown) {
        removed.push(path);
        removals.push({ path, options });
        return { removed: true };
      },
    },
    adapter,
    agent,
    commands: options.commands ?? { setup_command: "", test_command: "pnpm test" },
    runCommand,
    ...(options.startApp === undefined ? {} : { startApp: options.startApp }),
    onWorktree: (path: string) => worktreeLog.push(path),
    log: (line: string) => logs.push(line),
  };
  const input: QaRunInput = {
    qa,
    parent,
    parts: [backend],
    budgetMs: 60_000,
    round: 1,
    maxRounds: 2,
  };
  return {
    deps,
    input,
    reviews,
    checkouts,
    removed,
    removals,
    commands,
    worktreeLog,
    logs,
    tasks,
    cwds,
  };
}

interface TestCase {
  id: string;
  item: string;
  repro: string;
  expected: string;
  actual: string;
}

/** One case per failing item, with C1, C2, … in reply order (D-054). */
function casesFor(pass: boolean[], items: string[]): TestCase[] {
  let n = 0;
  const out: TestCase[] = [];
  pass.forEach((p, i) => {
    if (p) return;
    n += 1;
    out.push({
      id: `C${n}`,
      item: items[i] ?? `item ${i + 1}`,
      repro: `pnpm test -- item ${i + 1}`,
      expected: `item ${i + 1} passes`,
      actual: `nothing covers item ${i + 1}`,
    });
  });
  return out;
}

const verdict = (
  pass: boolean[],
  testsPassed = true,
  items = qaChecklist(parent),
  cases?: TestCase[],
) =>
  JSON.stringify({
    items: pass.map((p, i) => ({
      text: items[i] ?? `item ${i + 1}`,
      pass: p,
      evidence: p ? `src/avatars.ts:${i + 1}` : `nothing covers item ${i + 1}`,
    })),
    testsPassed,
    cases: cases ?? casesFor(pass, items),
  });

function settleDeps() {
  const comments: Array<{ issueId: string; body: string }> = [];
  const moves: Array<{ issueId: string; state: WorkflowStateName }> = [];
  const pings: string[] = [];
  const logs: string[] = [];
  const notifier: Notifier = {
    async notify(notice) {
      pings.push(formatNotice(notice));
    },
  };
  const linear = {
    async comment(issueId: string, body: string) {
      comments.push({ issueId, body });
      return `comment-${comments.length}`;
    },
    async moveTo(issueId: string, state: WorkflowStateName) {
      moves.push({ issueId, state });
    },
  };
  return {
    deps: { linear, notifier, maxFailures: 2, log: (line: string) => logs.push(line) },
    comments,
    moves,
    pings,
    logs,
  };
}

function setupErrorReview(part: LinkedIssue, error: string): PrReview {
  return { part, decision: "error", failing: [], setup: true, error };
}

/** A review that gave no usable verdict, on a PR head (MET-196, D-052). */
function notJudgedReview(
  part: LinkedIssue,
  notJudged: NonNullable<PrReview["notJudged"]>,
  error: string,
  head = "sha7",
): PrReview {
  return {
    part,
    pr: { ...pr(7, part.key), headRefOid: head },
    decision: "error",
    failing: [],
    notJudged,
    error,
  };
}

/** A one-part QA round with a single not-judged review. */
function notJudgedRound(
  notJudged: NonNullable<PrReview["notJudged"]>,
  error: string,
  head = "sha7",
): QaRunResult {
  return { outcome: "error", reviews: [notJudgedReview(backend, notJudged, error, head)] };
}

/** A repo that declares a live web product (MET-177, D-051). */
const liveQa: QaConfig = {
  setup_command: "",
  test_command: "pnpm test",
  kind: "web",
  start: "pnpm dev --port {port}",
  url: "http://127.0.0.1:{port}",
  health: "/health",
};

function appStarted(stop: () => Promise<void> = async () => {}): QaAppStart {
  return {
    ok: true,
    app: {
      kind: "web",
      url: "http://127.0.0.1:4321",
      port: 4321,
      browser: "http://127.0.0.1:9222",
      stop,
    },
  };
}

function appFailed(step: QaAppStep = "start", detail = "boom | exit 1"): QaAppStart {
  return { ok: false, step, detail, error: "exited with code 1" };
}

test("every item and the tests pass: approve at the PR head, then QA stays Ready", async () => {
  const h = harness({ replies: [verdict([true, true])] });
  const result = await runQa(h.input, h.deps);
  assert.equal(result.outcome, "approved");
  assert.equal(h.reviews.length, 1);
  assert.equal(h.reviews[0]?.event, "APPROVE");
  assert.equal(h.reviews[0]?.number, 7);
  assert.equal(h.reviews[0]?.commitId, "sha7");
  assert.match(h.reviews[0]?.body ?? "", /approved/);
  assert.match(h.reviews[0]?.body ?? "", /- \[x\] Avatars are served: src\/avatars.ts:1/);

  const prompt = h.tasks[0]?.prompt ?? "";
  assert.match(
    prompt,
    /## Done when \(MET-50: Title MET-50\)\n1\. Avatars are served\n2\. It has tests/,
  );
  assert.match(prompt, /src\/avatars\.ts \(\+40 -2\)/);
  assert.match(prompt, /## Diff\n```diff\ndiff --git a\/src\/avatars\.ts/);
  assert.match(prompt, /## CI\n- CI \/ test: success/);
  assert.match(prompt, /Read this part's brief, the decision IDs it names/);
  assert.match(prompt, /Do not read docs\/SPEC\.md or every decision record/);
  assert.match(prompt, /Judge each item only from the test results/);
  assert.doesNotMatch(prompt, /code style|code quality|Open a file only|Judge from this diff/);
  assert.doesNotMatch(prompt, /Read the diff and the code/);
  assert.match(prompt, /`pnpm test` passed/);
  assert.match(prompt, /exactly 2 item\(s\)/);

  const s = settleDeps();
  const state = emptyLoopState();
  state.qaFailures[parent.id] = 1;
  assert.equal(await settleQa(state, { qa, parent }, result, s.deps), "approved");
  assert.deepEqual(state.qaFailures, {});
  assert.deepEqual(s.moves, [{ issueId: qa.id, state: "Ready" }]);
  assert.equal(s.comments.length, 1);
  assert.equal(s.comments[0]?.issueId, qa.id);
  assert.match(
    s.comments[0]?.body ?? "",
    /MET-51 \[PR #7\]\(https:\/\/github\.test\/o\/r\/pull\/7\): approved \(\[review\]\(https:\/\/github\.test\/o\/r\/pull\/7#review-1\)\)/,
  );
  assert.deepEqual(s.pings, []);
});

test("QA checks the part's own Done-when items and Verify, not the parent's list (MET-162)", async () => {
  const h = harness({
    replies: [verdict([true, true], true, qaChecklist(parent, briefed))],
    prs: { [briefed.key]: pr(7, briefed.key) },
  });
  h.input.parts = [briefed];
  const result = await runQa(h.input, h.deps);
  assert.equal(result.outcome, "approved");
  assert.equal(h.reviews[0]?.event, "APPROVE");
  assert.deepEqual(result.reviews[0]?.failing, [], "the part's item and its Verify item pass");
  const prompt = h.tasks[0]?.prompt ?? "";
  assert.match(prompt, /## Done when \(MET-51: Title MET-51\)\n1\. Avatars are served\n2\. Verify/);
  assert.match(
    prompt,
    /## Verify\nRun each command in the part brief[^\n]*\n- `pnpm test` → passes/,
  );
  assert.doesNotMatch(prompt, /It has tests/);
  assert.match(prompt, /exactly 2 item\(s\)/);
  assert.match(prompt, /The last item, `Verify`, passes only when each Verify command ran/);
});

test("the verdict needs one item per part Done-when item plus Verify (MET-162)", async () => {
  // One item for a part that has one Done-when item and a Verify item: unusable.
  const h = harness({
    replies: [verdict([true], true, qaChecklist(parent, briefed))],
    prs: { [briefed.key]: pr(7, briefed.key) },
  });
  h.input.parts = [briefed];
  const result = await runQa(h.input, h.deps);
  assert.equal(result.outcome, "error");
  assert.equal(h.reviews.length, 0, "no review for an unusable verdict");
  assert.match(result.reviews[0]?.error ?? "", /expected 2.*got 1/);
});

test("a QA: tests part approves from its Verify commands with no QA agent (D-053)", async () => {
  let appStarts = 0;
  const h = harness({
    prs: { [testsBriefed.key]: pr(7, testsBriefed.key) },
    commands: {
      setup_command: "",
      test_command: "pnpm test",
      kind: "web",
      start: "pnpm dev",
      url: "http://127.0.0.1:{port}",
    },
    startApp: async () => {
      appStarts += 1;
      throw new Error("a QA: tests part starts no app");
    },
  });
  const result = await runQa({ ...h.input, parts: [testsBriefed] }, h.deps);
  assert.equal(result.outcome, "approved", JSON.stringify(result.reviews[0]));
  assert.equal(h.tasks.length, 0, "no QA agent run");
  assert.equal(appStarts, 0, "no app or browser starts");
  assert.deepEqual(
    h.commands.map((entry) => entry.command),
    ["pnpm test", "pnpm check", "pnpm lint"],
    "the repo tests then the part's Verify commands in order",
  );
  assert.equal(h.reviews[0]?.event, "APPROVE");
  const body = h.reviews[0]?.body ?? "";
  assert.ok(body.startsWith("not run live: QA from Verify commands\n"), body);
  const evidence =
    "`pnpm check` exited with code 0 (expected: avatars pass); " +
    "`pnpm lint` exited with code 0 (expected: no warnings)";
  assert.ok(body.includes(`- [x] Avatars are served: ${evidence}`), body);
  assert.ok(body.includes(`- [x] Verify: ${evidence}`), body);
  assert.deepEqual(result.tokens, emptyTokenUsage(), "no usage is recorded");
  assert.equal(result.turns, undefined, "no turn cap applies");
  assert.deepEqual(h.logs, ["MET-53: QA from Verify commands on MET-51, 2 commands"]);
});

test("a failing Verify command requests changes with its line and test tail (D-053)", async () => {
  const output = `start\n${"x".repeat(MAX_TEST_TAIL)}\nTAIL`;
  const h = harness({
    prs: { [testsBriefed.key]: pr(7, testsBriefed.key) },
    exits: { "pnpm check": 3 },
    outputs: { "pnpm check": output },
  });
  const result = await runQa({ ...h.input, parts: [testsBriefed] }, h.deps);
  assert.equal(result.outcome, "changes_requested");
  assert.equal(h.tasks.length, 0, "no QA agent run");
  const review = result.reviews[0];
  assert.equal(review?.decision, "request_changes");
  assert.deepEqual(review?.failing, ["Verify: `pnpm check` exited with code 3"]);
  assert.equal(
    review?.testTail,
    `…${output.slice(-MAX_TEST_TAIL)}`,
    "the send-back carries the last MAX_TEST_TAIL characters",
  );
  assert.deepEqual(
    h.commands.map((entry) => entry.command),
    ["pnpm test", "pnpm check"],
    "stops at the first failing command",
  );
  const body = h.reviews[0]?.body ?? "";
  assert.ok(body.startsWith("not run live: QA from Verify commands\n"), body);
  assert.match(body, /Last lines of `pnpm check`/);
});

test("a failing Verify command names only itself, after a passing one (D-053)", async () => {
  // QA ran `true` (passes) then the failing command straight through the daemon's own
  // functions; the failing line must not also list the passing command.
  const checks = [
    { run: "true", expect: "" },
    { run: "echo second-check-failed; exit 3", expect: "" },
  ];
  const run: CommandRunner = async (command) => ({
    exitCode: command === "true" ? 0 : 3,
    timedOut: false,
    output: command === "true" ? "" : "start\nsecond-check-failed",
  });
  const runs = await runVerifyChecks(checks, "/wt", 60_000, run);
  const checklist = ["Avatars are served", "Verify"];
  const tests: TestRun = {
    passed: true,
    command: "pnpm test",
    exitCode: 0,
    timedOut: false,
    output: "",
  };
  const verdict: ParsedQaVerdict = {
    ok: true,
    verdict: verdictFromVerify(checklist, tests, runs),
  };
  const decision = decideReview(checklist, tests, verdict);
  assert.equal(decision.decision, "request_changes");
  assert.deepEqual(decision.failing, [
    "Verify: `echo second-check-failed; exit 3` exited with code 3",
  ]);
});

test("a QA: agent part and a body with no QA line still run the QA agent (D-053)", async () => {
  const agentPart = issue("MET-51", {
    parentId: parent.id,
    description: testsBriefed.description.replace("**QA**: tests", "**QA**: agent"),
  });
  const noCommand = issue("MET-51", {
    parentId: parent.id,
    description: testsBriefed.description.replace(
      "- `pnpm check` → avatars pass",
      "- pnpm check → avatars pass",
    ),
  });
  for (const part of [agentPart, briefed, noCommand]) {
    const h = harness({
      replies: [verdict([true, true], true, qaChecklist(parent, part))],
      prs: { [part.key]: pr(7, part.key) },
    });
    const result = await runQa({ ...h.input, parts: [part] }, h.deps);
    assert.equal(result.outcome, "approved");
    assert.equal(h.tasks.length, 1, "the QA agent ran");
    assert.equal(
      h.commands.some((entry) => entry.command === "pnpm check"),
      false,
      "the Verify commands did not run",
    );
    assert.equal(
      h.logs.some((line) => line.includes("QA from Verify commands")),
      false,
      "no tests-mode log line",
    );
    if (part === noCommand) {
      assert.deepEqual(h.logs, [
        "MET-53: MET-51 has a Verify line with no backticked command, using agent QA",
      ]);
    }
  }
});

test("agent QA evidence keeps whitespace inside backticks as written (D-053)", () => {
  const verdict: ParsedQaVerdict = {
    ok: true,
    verdict: {
      testsPassed: true,
      cases: [],
      items: [
        {
          text: "Avatars",
          pass: true,
          evidence: "src/a.ts:1\n\nand `one\ttwo\nthree`",
        },
      ],
    },
  };
  const decision = decideReview(
    ["Avatars"],
    { passed: true, command: "pnpm test", exitCode: 0, timedOut: false, output: "" },
    verdict,
  );
  assert.deepEqual(decision.passing, ["Avatars: src/a.ts:1 and `one\ttwo\nthree`"]);
});

test("agent QA evidence keeps whitespace in a double-backtick span (D-054)", () => {
  const verdict: ParsedQaVerdict = {
    ok: true,
    verdict: {
      testsPassed: true,
      cases: [],
      items: [
        {
          text: "Avatars",
          pass: true,
          evidence: 'ran ``test "a  b"``\n\nnow',
        },
      ],
    },
  };
  const decision = decideReview(
    ["Avatars"],
    { passed: true, command: "pnpm test", exitCode: 0, timedOut: false, output: "" },
    verdict,
  );
  assert.deepEqual(decision.passing, ['Avatars: ran ``test "a  b"`` now']);
});

test("the QA agent run gets the role turn cap", async () => {
  const h = harness({ replies: [verdict([true, true])] });
  await runQa({ ...h.input, maxTurns: 40 }, h.deps);
  assert.equal(h.tasks[0]?.maxTurns, 40);
});

test("a QA round whose replies all report unknown usage sums nothing and says unknown", async () => {
  const h = harness({
    replies: [
      { status: "error", error: "no usage", usageUnknown: true, turns: 3 },
      { status: "error", error: "no usage", usageUnknown: true, turns: 4 },
    ],
    prs: { [backend.key]: pr(7, backend.key), [frontend.key]: pr(8, frontend.key) },
  });
  h.input.parts = [backend, frontend];

  const result = await runQa(h.input, h.deps);

  assert.equal(result.usageUnknown, true);
  assert.deepEqual(result.tokens, emptyTokenUsage());
  assert.equal(result.turns, 7);
});

test("a mixed QA round adds only the replies with known usage and keeps the normal sum", async () => {
  const known = { input: 100, output: 20, cacheRead: 30, cacheWrite: 5 };
  const h = harness({
    replies: [
      {
        status: "error",
        error: "no usage",
        usageUnknown: true,
        tokens: { input: 999, output: 999, cacheRead: 999, cacheWrite: 999 },
        turns: 3,
      },
      { status: "error", error: "boom", tokens: known, turns: 4 },
    ],
    prs: { [backend.key]: pr(7, backend.key), [frontend.key]: pr(8, frontend.key) },
  });
  h.input.parts = [backend, frontend];

  const result = await runQa(h.input, h.deps);

  assert.equal(result.usageUnknown, undefined);
  assert.deepEqual(result.tokens, known);
  assert.equal(result.turns, 7);
});

test("the worktree is checked out at the PR head, used as the agent's cwd and force-removed", async () => {
  const h = harness({ replies: [verdict([true, true])] });
  await runQa(h.input, h.deps);
  assert.deepEqual(h.checkouts, [
    { issueKey: "MET-53", title: "pr 7", branch: "met-51-work", sha: "sha7" },
  ]);
  assert.deepEqual(
    h.commands,
    [{ command: "pnpm test", cwd: "/wt/qa-sha7" }],
    "empty setup skipped",
  );
  assert.deepEqual(h.cwds, ["/wt/qa-sha7"]);
  assert.equal(h.tasks[0]?.id, "MET-53-qa-1-pr7");
  assert.deepEqual(h.removed, ["/wt/qa-sha7"]);
  assert.deepEqual(
    h.removals,
    [{ path: "/wt/qa-sha7", options: { force: true } }],
    "a QA checkout is removed without the keep guard",
  );
  assert.deepEqual(h.worktreeLog, ["/wt/qa-sha7", ""]);
});

test("the worktree is removed even when the agent run fails", async () => {
  const h = harness({ replies: [{ status: "timeout", error: "budget" }] });
  const result = await runQa(h.input, h.deps);
  assert.equal(result.outcome, "error");
  assert.match(result.reviews[0]?.error ?? "", /harness run timeout: budget/);
  assert.deepEqual(h.removed, ["/wt/qa-sha7"]);
  assert.equal(h.reviews.length, 0, "no review without a verdict");
});

test("one failing item requests changes listing it; the part goes back to Ready", async () => {
  const h = harness({ replies: [verdict([true, false])] });
  const result = await runQa(h.input, h.deps);
  assert.equal(result.outcome, "changes_requested");
  assert.equal(h.reviews[0]?.event, "REQUEST_CHANGES");
  const body = h.reviews[0]?.body ?? "";
  assert.match(body, /changes requested, round 1 of 2/);
  assert.match(body, /Failing:\n- \[ \] It has tests: nothing covers item 2/);
  assert.match(body, /Passing:\n- \[x\] Avatars are served/);
  assert.deepEqual(result.reviews[0]?.failing, ["It has tests: nothing covers item 2"]);

  const s = settleDeps();
  const state = emptyLoopState();
  assert.equal(await settleQa(state, { qa, parent }, result, s.deps), "sent_back");
  assert.equal(state.qaFailures[parent.id], 1);
  assert.deepEqual(state.qaFeedback[backend.id], {
    failing: ["It has tests: nothing covers item 2"],
    prUrl: "https://github.test/o/r/pull/7",
    reviewUrl: "https://github.test/o/r/pull/7#review-1",
    cases: [
      {
        id: "C1",
        item: "It has tests",
        repro: "pnpm test -- item 2",
        expected: "item 2 passes",
        actual: "nothing covers item 2",
      },
    ],
  });
  assert.deepEqual(s.moves, [
    { issueId: backend.id, state: "Ready" },
    { issueId: qa.id, state: "Ready" },
  ]);
  const partComment = s.comments.find((c) => c.issueId === backend.id)?.body ?? "";
  assert.match(partComment, /changes requested on \[PR #7\].*\[review\]\(.*#review-1\)/);
  assert.match(partComment, /backend agent fixes the PR/);
  assert.match(partComment, /- It has tests: nothing covers item 2/);
  assert.match(s.comments.at(-1)?.body ?? "", /runs again once every part is back in review/);
  assert.deepEqual(s.pings, []);
});

test("a re-QA on a new head gets only the saved cases and commands (D-054)", async () => {
  resetQaAppFailures();
  const saved = [
    {
      id: "C1",
      item: "Avatars are served",
      repro: "pnpm test -- avatars",
      expected: "the avatar test passes",
      actual: "not ok 3 - avatars",
    },
  ];
  const reply = JSON.stringify({
    cases: [{ id: "C1", pass: true, evidence: "pnpm test -- avatars: ok 3 - avatars" }],
    verify: { pass: true, evidence: "`pnpm test` exited with code 0" },
  });
  const h = harness({ replies: [reply] });
  const result = await runQa(
    {
      ...h.input,
      parts: [briefed],
      reviewedHeads: {
        [briefed.id]: { sha: "sha6", verdict: "changes_requested", cases: saved },
      },
    },
    h.deps,
  );
  assert.equal(result.reviews[0]?.decision, "approve");
  assert.deepEqual(result.reviews[0]?.reQa, {
    cases: [{ id: "C1", pass: true, evidence: "pnpm test -- avatars: ok 3 - avatars" }],
    verify: { pass: true, evidence: "`pnpm test` exited with code 0" },
  });

  const prompt = h.tasks[0]?.prompt ?? "";
  assert.match(prompt, /## Saved cases \(1\)/);
  assert.match(prompt, /1\. C1 \(Avatars are served\)/);
  assert.match(prompt, /repro: pnpm test -- avatars/);
  assert.match(prompt, /expected: the avatar test passes/);
  assert.match(prompt, /actual: not ok 3 - avatars/);
  assert.match(prompt, /## Verify[\s\S]*`pnpm test` → passes/);
  assert.match(prompt, /## Tests[\s\S]*`pnpm test` passed/);
  assert.match(prompt, /Write no new probes/);
  assert.match(prompt, /"verify": \{ "pass": true \| false/);
  assert.doesNotMatch(prompt, /## Diff/);
  assert.doesNotMatch(prompt, /## Changed files/);
  assert.doesNotMatch(prompt, /## Part brief/);
  assert.doesNotMatch(prompt, /## Done when/);
  assert.doesNotMatch(prompt, /docs\/SPEC/);
  assert.deepEqual(
    h.commands.map((entry) => entry.command),
    ["pnpm test"],
    "the daemon runs setup and test before the agent",
  );
});

test("a reviewed head with no saved cases still gets the full round 1 (D-054)", async () => {
  resetQaAppFailures();
  const h = harness({ replies: [verdict([true, true])] });
  const result = await runQa(
    {
      ...h.input,
      parts: [briefed],
      reviewedHeads: {
        [briefed.id]: { sha: "sha6", verdict: "changes_requested" },
      },
    },
    h.deps,
  );
  assert.equal(result.outcome, "approved");
  const prompt = h.tasks[0]?.prompt ?? "";
  assert.match(prompt, /## Diff/);
  assert.match(prompt, /## Part brief/);
  assert.match(prompt, /## Done when/);
  assert.doesNotMatch(prompt, /## Saved cases/);
});

test("a re-QA of a QA: agent part starts the live app and names it (D-051)", async () => {
  resetQaAppFailures();
  let stopped = false;
  const saved = [
    {
      id: "C1",
      item: "Avatars are served",
      repro: "qa-browser open http://127.0.0.1:4321/avatars",
      expected: "the avatar shows",
      actual: "the page is empty",
    },
  ];
  const reply = JSON.stringify({
    cases: [{ id: "C1", pass: true, evidence: "qa-browser text .avatar: Ada" }],
    verify: { pass: true, evidence: "`pnpm test` exited with code 0" },
  });
  const h = harness({
    commands: liveQa,
    replies: [reply],
    startApp: async () =>
      appStarted(async () => {
        stopped = true;
      }),
  });
  const result = await runQa(
    {
      ...h.input,
      parts: [backend],
      reviewedHeads: {
        [backend.id]: { sha: "sha6", verdict: "changes_requested", cases: saved },
      },
    },
    h.deps,
  );
  assert.equal(result.reviews[0]?.decision, "approve");
  assert.match(
    h.tasks[0]?.prompt ?? "",
    /## App\nThe product is running at http:\/\/127\.0\.0\.1:4321 \(kind web\)/,
  );
  assert.equal(stopped, true, "the app stops at teardown");
});

test("a re-QA approves when every case and command passes, and lists each case with its result (D-056)", async () => {
  resetQaAppFailures();
  const saved = [
    {
      id: "C1",
      item: "Avatars are served",
      repro: "pnpm test -- avatars",
      expected: "the avatar test passes",
      actual: "not ok 3 - avatars",
    },
    {
      id: "T1",
      item: "Tests",
      repro: "pnpm test",
      expected: "exit 0",
      actual: "exited with code 1",
    },
  ];
  const reply = JSON.stringify({
    cases: [
      { id: "C1", pass: true, evidence: "pnpm test -- avatars: ok 3 - avatars" },
      { id: "T1", pass: true, evidence: "`pnpm test` exited with code 0" },
    ],
    verify: { pass: true, evidence: "`pnpm test` exited with code 0" },
  });
  const h = harness({ replies: [reply] });
  const result = await runQa(
    {
      ...h.input,
      parts: [briefed],
      reviewedHeads: {
        [briefed.id]: { sha: "sha6", verdict: "changes_requested", cases: saved },
      },
    },
    h.deps,
  );
  assert.equal(result.outcome, "approved");
  assert.equal(h.reviews[0]?.event, "APPROVE");
  assert.equal(result.reviews[0]?.cases, undefined, "an approval sends back no case");
  const body = h.reviews[0]?.body ?? "";
  assert.match(body, /approved\. Every saved case passes and `pnpm test` passed\./);
  assert.match(
    body,
    /- \[x\] C1 \(Avatars are served\): pass: pnpm test -- avatars: ok 3 - avatars/,
  );
  assert.match(body, /- \[x\] T1 \(Tests\): pass: `pnpm test` exited with code 0/);
  assert.match(body, /- \[x\] Verify: pass: `pnpm test` exited with code 0/);
});

test("a re-QA sends back only the still-failing case, with its new actual and no new case (D-056)", async () => {
  resetQaAppFailures();
  const saved = [
    {
      id: "C1",
      item: "Avatars are served",
      repro: "pnpm test -- avatars",
      expected: "the avatar test passes",
      actual: "not ok 3 - avatars",
    },
    {
      id: "C2",
      item: "It has tests",
      repro: "pnpm test -- tests",
      expected: "the tests pass",
      actual: "not ok 4 - tests",
    },
  ];
  const reply = JSON.stringify({
    cases: [
      { id: "C1", pass: true, evidence: "pnpm test -- avatars: ok 3 - avatars" },
      { id: "C2", pass: false, evidence: "pnpm test -- tests: ✖ still not ok 4" },
    ],
    verify: { pass: true, evidence: "`pnpm test` exited with code 0" },
  });
  const h = harness({ replies: [reply] });
  const result = await runQa(
    {
      ...h.input,
      parts: [briefed],
      reviewedHeads: {
        [briefed.id]: { sha: "sha6", verdict: "changes_requested", cases: saved },
      },
    },
    h.deps,
  );
  assert.equal(result.outcome, "changes_requested");
  const sent = result.reviews[0]?.cases ?? [];
  assert.deepEqual(sent, [
    {
      id: "C2",
      item: "It has tests",
      repro: "pnpm test -- tests",
      expected: "the tests pass",
      actual: "pnpm test -- tests: ✖ still not ok 4",
    },
  ]);
  const body = h.reviews[0]?.body ?? "";
  assert.match(body, /- \[x\] C1 \(Avatars are served\): pass: /);
  assert.match(body, /- \[ \] C2 \(It has tests\): fail: pnpm test -- tests: ✖ still not ok 4/);
  assert.doesNotMatch(body, /C3/);

  const s = settleDeps();
  const state = emptyLoopState();
  assert.equal(await settleQa(state, { qa, parent }, result, s.deps), "sent_back");
  assert.deepEqual(state.qaFeedback[briefed.id]?.cases, sent);
  assert.equal(state.qaFailures[parent.id], 1);
});

test("a failing re-QA test command keeps T1 with the daemon's actual (D-056)", async () => {
  resetQaAppFailures();
  const saved = [
    {
      id: "C1",
      item: "Avatars are served",
      repro: "pnpm test -- avatars",
      expected: "the avatar test passes",
      actual: "not ok 3 - avatars",
    },
  ];
  const reply = JSON.stringify({
    cases: [{ id: "C1", pass: true, evidence: "pnpm test -- avatars: ok 3 - avatars" }],
    verify: { pass: true, evidence: "`pnpm test` exited with code 0" },
  });
  const h = harness({ replies: [reply], testExit: 1 });
  const result = await runQa(
    {
      ...h.input,
      parts: [briefed],
      reviewedHeads: {
        [briefed.id]: { sha: "sha6", verdict: "changes_requested", cases: saved },
      },
    },
    h.deps,
  );
  assert.equal(result.outcome, "changes_requested");
  const sent = result.reviews[0]?.cases ?? [];
  assert.equal(sent.length, 1, "no new case beyond T1");
  assert.equal(sent[0]?.id, "T1");
  assert.equal(sent[0]?.item, "Tests");
  assert.equal(sent[0]?.repro, "pnpm test");
  assert.equal(sent[0]?.expected, "exit 0");
  assert.match(sent[0]?.actual ?? "", /^exited with code 1\nnot ok 3 - avatars$/);
});

test("a failing re-QA Verify command adds T1 from its evidence (D-056)", async () => {
  resetQaAppFailures();
  const saved = [
    {
      id: "C1",
      item: "Avatars are served",
      repro: "pnpm test -- avatars",
      expected: "the avatar test passes",
      actual: "not ok 3 - avatars",
    },
  ];
  const reply = JSON.stringify({
    cases: [{ id: "C1", pass: true, evidence: "pnpm test -- avatars: ok 3 - avatars" }],
    verify: { pass: false, evidence: "`pnpm check` exited with code 1" },
  });
  const h = harness({ replies: [reply] });
  const result = await runQa(
    {
      ...h.input,
      parts: [briefed],
      reviewedHeads: {
        [briefed.id]: { sha: "sha6", verdict: "changes_requested", cases: saved },
      },
    },
    h.deps,
  );
  assert.equal(result.outcome, "changes_requested");
  assert.deepEqual(result.reviews[0]?.cases, [
    {
      id: "T1",
      item: "Verify",
      repro: "`pnpm test` → passes",
      expected: "exit 0",
      actual: "`pnpm check` exited with code 1",
    },
  ]);
});

test("the second failed re-QA sends the parent to Needs input and clears the cases (D-014, D-056)", async () => {
  resetQaAppFailures();
  const savedCase = {
    id: "C1",
    item: "It has tests",
    repro: "pnpm test -- tests",
    expected: "the tests pass",
    actual: "not ok 4 - tests",
  };
  const result: QaRunResult = {
    outcome: "changes_requested",
    reviews: [
      {
        part: briefed,
        pr: pr(7, briefed.key),
        decision: "request_changes",
        failing: ["It has tests: still failing"],
        cases: [{ ...savedCase, actual: "still not ok 4" }],
      },
    ],
  };
  const s = settleDeps();
  const state = emptyLoopState();
  state.qaFailures[parent.id] = 1;
  state.reviewedHeads = {
    [briefed.id]: {
      sha: "sha7",
      verdict: "changes_requested",
      cases: [{ ...savedCase, actual: "still not ok 4" }],
    },
  };
  state.qaFeedback[briefed.id] = {
    failing: ["It has tests: still failing"],
    cases: [{ ...savedCase, actual: "still not ok 4" }],
  };

  assert.equal(await settleQa(state, { qa, parent }, result, s.deps), "escalated");
  assert.deepEqual(s.moves, [
    { issueId: parent.id, state: "Needs input" },
    { issueId: qa.id, state: "Needs input" },
  ]);
  assert.deepEqual(state.qaFailures, {});
  assert.equal(state.reviewedHeads[briefed.id]?.cases, undefined, "the saved cases are cleared");
  assert.deepEqual(state.qaFeedback, {}, "the send-back feedback is dropped");
});

test("a not-judged escalation clears the part's saved cases from reviewedHeads and qaFeedback (D-052, D-056)", async () => {
  resetQaAppFailures();
  const saved = [
    {
      id: "C1",
      item: "It has tests",
      repro: "pnpm test -- tests",
      expected: "the tests pass",
      actual: "not ok 4 - tests",
    },
  ];
  const result: QaRunResult = {
    outcome: "error",
    reviews: [
      {
        part: briefed,
        pr: pr(7, briefed.key),
        decision: "error",
        failing: [],
        notJudged: "timeout",
        error: "harness run timeout: budget",
      },
    ],
  };
  const s = settleDeps();
  const state = emptyLoopState();
  state.reviewedHeads = {
    [briefed.id]: { sha: "sha7", verdict: "changes_requested", cases: saved },
  };
  state.qaFeedback[briefed.id] = { failing: ["It has tests: still failing"], cases: saved };

  assert.equal(await settleQa(state, { qa, parent }, result, s.deps), "requeued");
  assert.deepEqual(state.reviewedHeads[briefed.id]?.cases, saved, "one not-judged run keeps them");
  assert.equal(await settleQa(state, { qa, parent }, result, s.deps), "escalated");
  assert.equal(state.reviewedHeads[briefed.id]?.cases, undefined);
  assert.deepEqual(state.qaFeedback[briefed.id], { failing: ["It has tests: still failing"] });
});

test("a request_changes verdict carries each failing case and the settle saves it (D-054)", async () => {
  const cases = [
    {
      id: "C1",
      item: "It has tests",
      repro: "pnpm test -- avatars",
      expected: "the avatar test passes",
      actual: "not ok 3 - avatars",
    },
  ];
  const h = harness({ replies: [verdict([true, false], true, qaChecklist(parent), cases)] });
  const result = await runQa(h.input, h.deps);
  assert.equal(result.outcome, "changes_requested");
  assert.deepEqual(result.reviews[0]?.cases, cases);

  const prompt = h.tasks[0]?.prompt ?? "";
  assert.match(prompt, /"cases": \[\{ "id": "C1"/);
  assert.match(prompt, /cases: \[\]/);

  const s = settleDeps();
  const state = emptyLoopState();
  assert.equal(await settleQa(state, { qa, parent }, result, s.deps), "sent_back");
  assert.deepEqual(state.qaFeedback[backend.id]?.cases, cases);
  assert.deepEqual(state.qaFeedback[backend.id]?.failing, ["It has tests: nothing covers item 2"]);
});

test("a request_changes verdict with no cases is not judged with reason no_cases (D-052)", async () => {
  resetQaAppFailures();
  const h = harness({ replies: [verdict([true, false], true, qaChecklist(parent), [])] });
  const result = await runQa(h.input, h.deps);
  assert.equal(result.outcome, "error");
  assert.equal(h.reviews.length, 0, "no review is posted");
  assert.equal(result.reviews[0]?.notJudged, "no_cases");

  const s = settleDeps();
  const state = emptyLoopState();
  state.qaFailures[parent.id] = 1;
  assert.equal(await settleQa(state, { qa, parent }, result, s.deps), "requeued");
  assert.deepEqual(state.qaFailures, { [parent.id]: 1 }, "no QA failure is counted");
  assert.deepEqual(state.qaFeedback, {});
  assert.deepEqual(s.logs, ["MET-53: QA not judged (verdict has no failing case), re-queued"]);

  assert.equal(
    await settleQa(state, { qa, parent }, result, s.deps),
    "escalated",
    "a second one in a row on the same head goes to Needs input",
  );
});

test("a malformed case is a schema error and counts a failure (D-052, D-054)", async () => {
  const items = qaChecklist(parent);
  const envelope = (cases: unknown) =>
    JSON.stringify({
      items: items.map((text, i) => ({
        text,
        pass: i !== 1,
        evidence: i === 1 ? "nothing covers item 2" : `src/avatars.ts:${i + 1}`,
      })),
      testsPassed: true,
      cases,
    });

  const emptyField = parseQaVerdict(
    envelope([{ id: "C1", item: "It has tests", repro: " ", expected: "pass", actual: "fail" }]),
    2,
  );
  assert.equal(emptyField.ok, false);
  assert.match(
    !emptyField.ok ? emptyField.error : "",
    /cases\[0\]\.repro: expected a non-empty string/,
  );

  const noFailingItem = parseQaVerdict(
    envelope([
      {
        id: "C1",
        item: "Avatars are served",
        repro: "pnpm test",
        expected: "pass",
        actual: "fail",
      },
    ]),
    2,
  );
  assert.equal(noFailingItem.ok, false);
  assert.match(!noFailingItem.ok ? noFailingItem.error : "", /cases\[0\]\.item/);

  // A schema error is a counted QA failure, not a not-judged run.
  const h = harness({
    replies: [
      envelope([
        {
          id: "C1",
          item: "Avatars are served",
          repro: "pnpm test",
          expected: "pass",
          actual: "fail",
        },
      ]),
    ],
  });
  const result = await runQa(h.input, h.deps);
  assert.equal(result.outcome, "error");
  assert.equal(result.reviews[0]?.notJudged, undefined);
  assert.match(result.reviews[0]?.error ?? "", /QA verdict was unusable: .*cases\[0\]\.item/);
});

test("a failing test command builds case T1 itself (D-054)", async () => {
  const output = "not ok 3 - avatars";
  const h = harness({
    replies: [verdict([true, true])],
    testExit: 1,
    outputs: { "pnpm test": output },
  });
  const result = await runQa(h.input, h.deps);
  assert.equal(result.outcome, "changes_requested");
  assert.deepEqual(result.reviews[0]?.cases, [
    {
      id: "T1",
      item: "Tests",
      repro: "pnpm test",
      expected: "exit 0",
      actual: `exited with code 1\n${output}`,
    },
  ]);
});

test("a failing Verify command builds case T1 with item Verify (D-054)", async () => {
  const h = harness({
    prs: { [testsBriefed.key]: pr(7, testsBriefed.key) },
    exits: { "pnpm check": 3 },
    outputs: { "pnpm check": "avatars check failed" },
  });
  const result = await runQa({ ...h.input, parts: [testsBriefed] }, h.deps);
  assert.equal(result.outcome, "changes_requested");
  assert.deepEqual(result.reviews[0]?.cases, [
    {
      id: "T1",
      item: "Verify",
      repro: "pnpm check",
      expected: "exit 0",
      actual: "exited with code 3\navatars check failed",
    },
  ]);
});

test("failing tests request changes even when the model says everything passes", async () => {
  const h = harness({ replies: [verdict([true, true], true)], testExit: 1 });
  const result = await runQa(h.input, h.deps);
  assert.equal(result.outcome, "changes_requested");
  assert.equal(h.reviews[0]?.event, "REQUEST_CHANGES");
  const body = h.reviews[0]?.body ?? "";
  assert.match(
    body,
    /- \[ \] Tests: `pnpm test` exited with code 1 when harnessd ran it, although the QA agent said they pass/,
  );
  assert.match(body, /```text\nnot ok 3 - avatars\n```/);
  assert.match(h.tasks[0]?.prompt ?? "", /`pnpm test` exited with code 1/);
});

test("a failing test tail is stored for the send-back and cut to the fixed limit", async () => {
  const output = `${"x".repeat(MAX_TEST_TAIL + 500)}not ok 3 - avatars`;
  const h = harness({ replies: [verdict([true, true])], testExit: 1 });
  const result = await runQa(h.input, {
    ...h.deps,
    runCommand: async () => ({ exitCode: 1, timedOut: false, output }),
  });
  const tail = result.reviews[0]?.testTail ?? "";
  assert.equal(tail.length, MAX_TEST_TAIL + 1, "one leading ellipsis plus the limit");
  assert.equal(tail.startsWith("…"), true);
  assert.equal(tail.endsWith("not ok 3 - avatars"), true);

  const state = emptyLoopState();
  const s = settleDeps();
  assert.equal(await settleQa(state, { qa, parent }, result, s.deps), "sent_back");
  assert.equal(state.qaFeedback[backend.id]?.testTail, tail);
});

test("a passing test run stores no test tail", async () => {
  const h = harness({ replies: [verdict([true, true])] });
  const result = await runQa(h.input, h.deps);
  assert.equal(result.reviews[0]?.testTail, undefined);
});

test("the model reporting failing tests also blocks approval", async () => {
  const cases = [
    {
      id: "C1",
      item: "Verify",
      repro: "pnpm test -- avatars",
      expected: "the tests pass",
      actual: "not ok 3 - avatars",
    },
  ];
  const h = harness({
    replies: [verdict([true, true], false, qaChecklist(parent), cases)],
  });
  const result = await runQa(h.input, h.deps);
  assert.equal(result.outcome, "changes_requested");
  assert.match(result.reviews[0]?.failing[0] ?? "", /QA agent saw failing tests/);
  assert.deepEqual(result.reviews[0]?.cases, cases);
});

test("an invalid verdict is not judged: no review, no failure, QA re-queued", async () => {
  const h = harness({ replies: ["Looks good to me!"] });
  const result = await runQa(h.input, h.deps);
  assert.equal(result.outcome, "error");
  assert.equal(h.reviews.length, 0);
  assert.equal(result.reviews[0]?.notJudged, "not_json");
  assert.match(result.reviews[0]?.error ?? "", /QA verdict was unusable: not JSON/);

  const s = settleDeps();
  const state = emptyLoopState();
  state.qaFailures[parent.id] = 1;
  assert.equal(await settleQa(state, { qa, parent }, result, s.deps), "requeued");
  assert.deepEqual(state.qaFailures, { [parent.id]: 1 }, "no QA failure is counted");
  assert.deepEqual(state.qaFeedback, {});
  assert.deepEqual(s.moves, [{ issueId: qa.id, state: "Ready" }], "only QA runs again");
  assert.deepEqual(s.comments, [], "no comment is posted");
  assert.deepEqual(s.pings, [], "no notice is sent");
  assert.match(s.logs[0] ?? "", /QA not judged \(verdict not JSON: /);
});

test("an invalid verdict with failing tests still requests changes", async () => {
  const h = harness({ replies: ["{}"], testExit: 2 });
  const result = await runQa(h.input, h.deps);
  assert.equal(result.outcome, "changes_requested");
  assert.match(
    h.reviews[0]?.body ?? "",
    /Also, the QA verdict was unusable: items: expected an array/,
  );
});

test("a turn-capped QA run is not judged, re-queued and counts no failure (D-052)", async () => {
  resetQaAppFailures();
  const h = harness({
    replies: [{ status: "error", error: "turn cap (80 turns)", reason: "turn_cap" }],
  });
  const result = await runQa(h.input, h.deps);
  assert.equal(result.outcome, "error");
  assert.equal(h.reviews.length, 0, "no review is posted");
  assert.equal(result.reviews[0]?.notJudged, "turn_cap");
  assert.equal(result.reviews[0]?.setup, undefined);

  const s = settleDeps();
  const state = emptyLoopState();
  state.qaFailures[parent.id] = 1;
  assert.equal(await settleQa(state, { qa, parent }, result, s.deps), "requeued");
  assert.deepEqual(state.qaFailures, { [parent.id]: 1 }, "no QA failure is counted");
  assert.deepEqual(state.qaFeedback, {});
  assert.deepEqual(s.moves, [{ issueId: qa.id, state: "Ready" }]);
  assert.deepEqual(s.comments, []);
  assert.deepEqual(s.pings, []);
  assert.deepEqual(s.logs, ["MET-53: QA not judged (turn cap (80 turns)), re-queued"]);
});

test("a timed-out QA run is not judged and logs timed out (D-052)", async () => {
  resetQaAppFailures();
  const h = harness({
    replies: [{ status: "timeout", error: "budget of 7168741ms exceeded" }],
  });
  const result = await runQa(h.input, h.deps);
  assert.equal(result.reviews[0]?.notJudged, "timeout");
  assert.equal(h.reviews.length, 0);

  const s = settleDeps();
  const state = emptyLoopState();
  assert.equal(await settleQa(state, { qa, parent }, result, s.deps), "requeued");
  assert.deepEqual(state.qaFailures, {});
  assert.deepEqual(s.logs, ["MET-53: QA not judged (timed out), re-queued"]);
});

test("a stalled QA run is not judged and logs stalled (D-052)", async () => {
  resetQaAppFailures();
  const h = harness({
    replies: [{ status: "error", error: "stalled (no output for 10 min)", reason: "stalled" }],
  });
  const result = await runQa(h.input, h.deps);
  assert.equal(result.reviews[0]?.notJudged, "stalled");
  assert.equal(h.reviews.length, 0);

  const s = settleDeps();
  const state = emptyLoopState();
  assert.equal(await settleQa(state, { qa, parent }, result, s.deps), "requeued");
  assert.deepEqual(state.qaFailures, {});
  assert.deepEqual(s.logs, ["MET-53: QA not judged (stalled), re-queued"]);
});

test("a second not-judged run in a row on the same head escalates with the reason", async () => {
  resetQaAppFailures();
  const s = settleDeps();
  const state = emptyLoopState();
  state.qaFailures[parent.id] = 1;
  state.sessions = {
    [backend.id]: {
      harness: "claude-code",
      sessionId: "session-1",
      worktree: "/wt/backend",
      branch: "met-51-work",
      at: "2026-11-24T10:00:00Z",
    },
  };

  const first = notJudgedRound(
    "turn_cap",
    "the QA verdict was unusable: harness run error: turn cap (80 turns)",
  );
  assert.equal(await settleQa(state, { qa, parent }, first, s.deps), "requeued");
  assert.equal(s.comments.length, 0, "the first run posts nothing");
  assert.equal(s.pings.length, 0);

  const second = notJudgedRound(
    "timeout",
    "the QA verdict was unusable: harness run timeout: budget of 7168741ms exceeded",
  );
  assert.equal(await settleQa(state, { qa, parent }, second, s.deps), "escalated");

  assert.deepEqual(state.qaFailures, { [parent.id]: 1 }, "no QA failure is counted");
  assert.deepEqual(state.qaFeedback, {}, "no feedback is stored");
  assert.equal(state.sessions[backend.id]?.sessionId, "session-1", "the part session is kept");
  assert.deepEqual(s.moves, [
    { issueId: qa.id, state: "Ready" },
    { issueId: parent.id, state: "Needs input" },
    { issueId: qa.id, state: "Needs input" },
  ]);
  assert.equal(s.comments.length, 1, "one comment on the parent");
  assert.equal(s.comments[0]?.issueId, parent.id);
  const body = s.comments[0]?.body ?? "";
  assert.match(body, /QA was not judged twice on MET-51 PR #7 at sha7: /);
  assert.match(body, /turn cap \(80 turns\); timed out\. No QA failure counted\./);
  assert.equal(s.pings.length, 1);
  assert.match(s.pings[0] ?? "", /MET-50 needs input \(QA not judged twice\): /);

  // The escalation clears the count, so the next not-judged run re-queues again.
  assert.equal(await settleQa(state, { qa, parent }, second, s.deps), "requeued");
});

test("a new head between two not-judged runs re-queues again (D-052)", async () => {
  resetQaAppFailures();
  const s = settleDeps();
  const state = emptyLoopState();
  const first = notJudgedRound("turn_cap", "harness run error: turn cap (80 turns)", "sha7");
  assert.equal(await settleQa(state, { qa, parent }, first, s.deps), "requeued");
  const newHead = notJudgedRound("stalled", "harness run error: stalled", "sha8");
  assert.equal(await settleQa(state, { qa, parent }, newHead, s.deps), "requeued");
  assert.deepEqual(state.qaFailures, {});
  assert.deepEqual(s.comments, []);
  assert.deepEqual(s.pings, []);
});

test("a judged verdict clears the not-judged count (D-052)", async () => {
  resetQaAppFailures();
  const s = settleDeps();
  const state = emptyLoopState();
  assert.equal(
    await settleQa(
      state,
      { qa, parent },
      notJudgedRound("turn_cap", "harness run error: turn cap (80 turns)"),
      s.deps,
    ),
    "requeued",
  );

  const judged: QaRunResult = {
    outcome: "changes_requested",
    reviews: [
      {
        part: backend,
        pr: pr(7, backend.key),
        decision: "request_changes",
        failing: ["It has tests: nothing covers item 2"],
      },
    ],
  };
  assert.equal(await settleQa(state, { qa, parent }, judged, s.deps), "sent_back");
  assert.equal(state.qaFailures[parent.id], 1);

  assert.equal(
    await settleQa(
      state,
      { qa, parent },
      notJudgedRound("turn_cap", "harness run error: turn cap (80 turns)"),
      s.deps,
    ),
    "requeued",
    "the judged verdict cleared the count",
  );
});

test("a D-041 setup error neither adds to nor clears the not-judged count (D-052)", async () => {
  resetQaAppFailures();
  const s = settleDeps();
  const state = emptyLoopState();
  assert.equal(
    await settleQa(
      state,
      { qa, parent },
      notJudgedRound("turn_cap", "harness run error: turn cap (80 turns)"),
      s.deps,
    ),
    "requeued",
  );

  const setup: QaRunResult = {
    outcome: "error",
    reviews: [setupErrorReview(backend, "could not check out PR #7: fetch failed")],
  };
  assert.equal(await settleQa(state, { qa, parent }, setup, s.deps), "requeued");

  assert.equal(
    await settleQa(
      state,
      { qa, parent },
      notJudgedRound("timeout", "harness run timeout: budget exceeded"),
      s.deps,
    ),
    "escalated",
    "the setup error left the earlier not-judged run counted",
  );
});

test("the second failure escalates to the human once and sends nothing back", async () => {
  const h = harness({ replies: [verdict([false, true])] });
  const input = { ...h.input, round: 2 };
  const result = await runQa(input, h.deps);
  assert.match(h.reviews[0]?.body ?? "", /round 2 of 2/);

  const s = settleDeps();
  const state = emptyLoopState();
  state.qaFailures[parent.id] = 1;
  state.qaFeedback[backend.id] = { failing: ["old"] };
  assert.equal(await settleQa(state, { qa, parent }, result, s.deps), "escalated");
  assert.deepEqual(state.qaFailures, {});
  assert.deepEqual(state.qaFeedback, {});
  assert.deepEqual(s.moves, [
    { issueId: parent.id, state: "Needs input" },
    { issueId: qa.id, state: "Needs input" },
  ]);
  assert.equal(s.comments.length, 1);
  assert.equal(s.comments[0]?.issueId, parent.id);
  assert.match(s.comments[0]?.body ?? "", /QA failed twice for MET-50, so this needs a human/);
  assert.match(s.comments[0]?.body ?? "", /- Avatars are served: nothing covers item 1/);
  assert.deepEqual(s.pings, [
    "MET-50 needs input (QA failed twice): MET-53 could not approve MET-51 PR #7 https://github.test/o/r/pull/7 https://linear.test/MET-50",
  ]);
});

test("a part without an open PR is sent back without a checkout", async () => {
  const h = harness({ prs: {} });
  const result = await runQa(h.input, h.deps);
  assert.equal(result.outcome, "changes_requested");
  assert.deepEqual(result.reviews[0]?.failing, [
    "No open PR has MET-51 in its title. Push the branch and open one.",
  ]);
  assert.deepEqual(h.checkouts, []);
  assert.deepEqual(h.tasks, []);
});

test("Done parts are skipped and every other part's PR is reviewed", async () => {
  const h = harness({
    prs: { [backend.key]: pr(7, backend.key), [frontend.key]: pr(8, frontend.key) },
    replies: [verdict([true, true]), verdict([true, true])],
  });
  const done = issue("MET-54", { state: "Done", description: partMarker("backend") });
  const result = await runQa({ ...h.input, parts: [backend, done, frontend] }, h.deps);
  assert.equal(result.outcome, "approved");
  assert.deepEqual(
    h.reviews.map((r) => [r.number, r.event]),
    [
      [7, "APPROVE"],
      [8, "APPROVE"],
    ],
  );
  assert.deepEqual(h.removed, ["/wt/qa-sha7", "/wt/qa-sha8"]);
});

test("a refused review event on your own PR falls back to a comment review", async () => {
  const h = harness({ replies: [verdict([true, true])], refuse: ["APPROVE"] });
  const result = await runQa(h.input, h.deps);
  assert.equal(result.outcome, "approved");
  assert.equal(h.reviews[0]?.event, "COMMENT");
  assert.equal(result.reviews[0]?.postedAs, "COMMENT");
  assert.match(h.logs[0] ?? "", /APPROVE on PR #7 refused/);
});

test("an approval that cannot be posted at all is an error, not an approval", async () => {
  const h = harness({ replies: [verdict([true, true])], refuse: ["APPROVE", "COMMENT"] });
  const result = await runQa(h.input, h.deps);
  assert.equal(result.outcome, "error");
  assert.match(result.reviews[0]?.error ?? "", /could not post the approval/);
});

test("a failed checkout is a setup error and nothing runs", async () => {
  const h = harness({ checkoutFails: true });
  const result: QaRunResult = await runQa(h.input, h.deps);
  assert.equal(result.outcome, "error");
  assert.equal(result.reviews[0]?.setup, true);
  assert.match(result.reviews[0]?.error ?? "", /could not check out PR #7: fetch failed/);
  assert.deepEqual(h.commands, []);
  assert.deepEqual(h.removed, []);
});

test("a PR lookup failure is also a setup error", async () => {
  const h = harness();
  const result = await runQa(h.input, {
    ...h.deps,
    github: {
      ...h.deps.github,
      async findPrForIssue() {
        throw new Error("gh pr list failed");
      },
    },
  });
  assert.equal(result.outcome, "error");
  assert.equal(result.reviews[0]?.setup, true);
  assert.match(result.reviews[0]?.error ?? "", /could not look up the PR: gh pr list failed/);
});

test("a setup-error round counts no QA failure, re-queues QA and posts nothing", async () => {
  const result: QaRunResult = {
    outcome: "error",
    reviews: [setupErrorReview(backend, "could not check out PR #7: fetch failed")],
  };
  const s = settleDeps();
  const state = emptyLoopState();
  state.qaFailures[parent.id] = 1;

  assert.equal(await settleQa(state, { qa, parent }, result, s.deps), "requeued");
  assert.deepEqual(state.qaFailures, { [parent.id]: 1 }, "no failure counted");
  assert.deepEqual(state.qaFeedback, {});
  assert.deepEqual(s.moves, [{ issueId: qa.id, state: "Ready" }]);
  assert.deepEqual(s.comments, [], "no comment is posted");
  assert.deepEqual(s.pings, [], "no notice is sent");
  assert.deepEqual(s.logs, [
    "MET-53: QA not judged (could not check out PR #7: fetch failed), re-queued",
  ]);
});

test("a setup error mixed with requested changes counts one failure", async () => {
  const result: QaRunResult = {
    outcome: "error",
    reviews: [
      setupErrorReview(backend, "could not check out PR #7: fetch failed"),
      {
        part: frontend,
        decision: "request_changes",
        failing: ["It has tests: nothing covers item 2"],
      },
    ],
  };
  const s = settleDeps();
  const state = emptyLoopState();

  assert.equal(await settleQa(state, { qa, parent }, result, s.deps), "sent_back");
  assert.equal(state.qaFailures[parent.id], 1);
  assert.deepEqual(state.qaFeedback[frontend.id], {
    failing: ["It has tests: nothing covers item 2"],
  });
  assert.deepEqual(state.qaFeedback[backend.id], undefined);
  assert.ok(s.comments.some((c) => c.issueId === frontend.id));
  assert.ok(s.comments.some((c) => c.issueId === qa.id));
  assert.deepEqual(s.pings, []);
});

test("a second not-judged run on one head escalates even when another part asks for changes", async () => {
  resetQaAppFailures();
  const s = settleDeps();
  const state = emptyLoopState();
  state.qaFailures[parent.id] = 1;

  assert.equal(
    await settleQa(
      state,
      { qa, parent },
      notJudgedRound("timeout", "harness run timeout: budget exceeded"),
      s.deps,
    ),
    "requeued",
  );

  // The frontend part asks for changes, so this round counts a failure anyway; the
  // backend part's second timeout on the same head must still escalate (D-052).
  const mixed: QaRunResult = {
    outcome: "changes_requested",
    reviews: [
      {
        part: frontend,
        pr: pr(8, frontend.key),
        decision: "request_changes",
        failing: ["It has tests: nothing covers item 2"],
      },
      notJudgedReview(backend, "timeout", "harness run timeout: budget exceeded"),
    ],
  };
  assert.equal(await settleQa(state, { qa, parent }, mixed, s.deps), "escalated");

  assert.deepEqual(state.qaFailures, { [parent.id]: 1 }, "no QA failure is counted");
  assert.deepEqual(state.qaFeedback, {}, "no feedback is stored");
  assert.deepEqual(s.moves, [
    { issueId: qa.id, state: "Ready" },
    { issueId: parent.id, state: "Needs input" },
    { issueId: qa.id, state: "Needs input" },
  ]);
  assert.equal(s.comments.length, 1, "one comment on the parent");
  assert.equal(s.comments[0]?.issueId, parent.id);
  assert.match(
    s.comments[0]?.body ?? "",
    /QA was not judged twice on MET-51 PR #7 at sha7: timed out; timed out\. No QA failure counted\./,
  );
  assert.equal(s.pings.length, 1);
  assert.match(s.pings[0] ?? "", /MET-50 needs input \(QA not judged twice\): /);
});

test("parseQaVerdict is strict", () => {
  const good = verdict([true, false]);
  const parsed = parseQaVerdict(`Here it is:\n\`\`\`json\n${good}\n\`\`\``, 2);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.ok && parsed.verdict.items[1]?.pass, false);

  const bad = (text: string, n = 1) => {
    const r = parseQaVerdict(text, n);
    assert.equal(r.ok, false, text);
    return r.ok ? "" : r.error;
  };
  const item = { text: "a", pass: true, evidence: "b" };
  assert.match(bad("no json"), /not JSON/);
  assert.match(bad("[]"), /expected a JSON object/);
  assert.match(
    bad(JSON.stringify({ items: [item], testsPassed: true, cases: [], extra: 1 })),
    /unknown key "extra"/,
  );
  assert.match(bad(JSON.stringify({ items: [item] })), /testsPassed: expected true or false/);
  assert.match(bad(JSON.stringify({ items: [item], testsPassed: "yes" })), /testsPassed/);
  assert.match(
    bad(JSON.stringify({ items: [item], testsPassed: true, cases: [] }), 2),
    /expected 2.*got 1/,
  );
  assert.match(
    bad(JSON.stringify({ items: [{ ...item, pass: "true" }], testsPassed: true, cases: [] })),
    /items\[0\]\.pass/,
  );
  assert.match(
    bad(JSON.stringify({ items: [{ ...item, evidence: " " }], testsPassed: true, cases: [] })),
    /items\[0\]\.evidence: expected a non-empty string/,
  );
  assert.match(
    bad(JSON.stringify({ items: [{ ...item, note: "x" }], testsPassed: true, cases: [] })),
    /items\[0\]: unknown key "note"/,
  );
  assert.match(
    bad(JSON.stringify({ items: [item], testsPassed: true })),
    /cases: expected an array/,
  );
  assert.match(
    bad(
      JSON.stringify({
        items: [item],
        testsPassed: true,
        cases: [{ id: "C1", item: "a", repro: "r", expected: "e", actual: "x", note: "n" }],
      }),
    ),
    /cases\[0\]: unknown key "note"/,
  );
  assert.match(
    bad(
      JSON.stringify({
        items: [item],
        testsPassed: true,
        cases: [{ id: "C2", item: "a", repro: "r", expected: "e", actual: "x" }],
      }),
    ),
    /cases\[0\]\.id: expected "C1"/,
  );
});

test("parseQaVerdict repairs a stray backslash before a backtick or dollar (MET-196)", () => {
  // b is one real backslash; a bare backtick would be invalid JSON after it.
  const b = "\\";
  const item = (evidence: string) =>
    `{"items":[{"text":"a","pass":true,"evidence":"${evidence}"}],"testsPassed":true,"cases":[]}`;

  const repaired = parseQaVerdict(item(`ran ${b}\`pnpm test${b}\` and ${b}$HOME`), 1);
  assert.equal(repaired.ok, true);
  assert.equal(
    repaired.ok && repaired.verdict.items[0]?.evidence,
    `ran ${b}\`pnpm test${b}\` and ${b}$HOME`,
    "a stray backslash is kept as an escaped backslash",
  );

  const valid = parseQaVerdict(item(`${b}${b}\`x\``), 1);
  assert.equal(valid.ok, true, "a valid escaped backslash before a backtick is kept");
  assert.equal(valid.ok && valid.verdict.items[0]?.evidence, `${b}\`x\``);

  const prose = parseQaVerdict(`Here it is:\n${item(`${b}\`x\``)}`, 1);
  assert.equal(prose.ok, true, "a verdict in prose is found after the repair");

  const badHex = parseQaVerdict(item(`${b}u12`), 1);
  assert.equal(badHex.ok, false);
  assert.equal(!badHex.ok && badHex.kind, "not_json", "bad \\u hex is not repaired");

  const notJson = parseQaVerdict("no json", 1);
  assert.equal(!notJson.ok && notJson.kind, "not_json");
  assert.match(!notJson.ok ? notJson.error : "", /^not JSON: /);
});

test("parseReQaVerdict needs exactly one entry per saved case id (D-054)", () => {
  const saved = ["C1", "T1"];
  const good = JSON.stringify({
    cases: [
      { id: "T1", pass: false, evidence: "`pnpm test` exited with code 1" },
      { id: "C1", pass: true, evidence: "pnpm test -- avatars: ok" },
    ],
    verify: { pass: true, evidence: "`pnpm test` exited with code 0" },
  });
  const parsed = parseReQaVerdict(`Here it is:\n\`\`\`json\n${good}\n\`\`\``, saved);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.ok ? parsed.verdict : undefined, {
    cases: [
      { id: "C1", pass: true, evidence: "pnpm test -- avatars: ok" },
      { id: "T1", pass: false, evidence: "`pnpm test` exited with code 1" },
    ],
    verify: { pass: true, evidence: "`pnpm test` exited with code 0" },
  });

  const bad = (cases: unknown, verify: unknown = { pass: true, evidence: "ok" }) =>
    parseReQaVerdict(JSON.stringify({ cases, verify }), saved);
  const error = (value: ReturnType<typeof parseReQaVerdict>) => (value.ok ? "" : value.error);

  assert.match(error(bad([{ id: "C1", pass: true, evidence: "ok" }])), /missing saved case "T1"/);
  assert.match(
    error(
      bad([
        { id: "C1", pass: true, evidence: "ok" },
        { id: "C1", pass: true, evidence: "ok" },
      ]),
    ),
    /cases\[1\]\.id: duplicate "C1"/,
  );
  assert.match(
    error(
      bad([
        { id: "C1", pass: true, evidence: "ok" },
        { id: "C9", pass: true, evidence: "ok" },
      ]),
    ),
    /cases\[1\]\.id: not a saved case "C9"/,
  );
  assert.match(
    error(
      bad([
        { id: "C1", pass: true, evidence: "ok" },
        { id: "T1", pass: true, evidence: "ok", item: "Tests" },
      ]),
    ),
    /cases\[1\]: unknown key "item"/,
  );
  assert.match(
    error(
      bad([
        { id: "C1", pass: true, evidence: " " },
        { id: "T1", pass: true, evidence: "ok" },
      ]),
    ),
    /cases\[0\]\.evidence: expected a non-empty string/,
  );
  assert.match(
    error(
      parseReQaVerdict(
        JSON.stringify({ cases: [], verify: { pass: true, evidence: "ok" }, items: [] }),
        saved,
      ),
    ),
    /unknown key "items"/,
  );
  assert.match(
    error(bad([], { pass: true, evidence: "ok", testsPassed: true })),
    /verify: unknown key "testsPassed"/,
  );
  assert.match(
    error(bad([], { pass: "true", evidence: "ok" })),
    /verify\.pass: expected true or false/,
  );
  assert.match(
    error(bad([], { pass: true, evidence: "" })),
    /verify\.evidence: expected a non-empty string/,
  );
  assert.match(error(bad([], [])), /verify: expected an object/);

  const notJson = parseReQaVerdict("no json", saved);
  assert.equal(notJson.ok, false);
  assert.equal(!notJson.ok && notJson.kind, "not_json");
  assert.match(!notJson.ok ? notJson.error : "", /^not JSON: /);
});

test("qaChecklist uses the part's own items plus Verify, else the parent's list", () => {
  assert.deepEqual(qaChecklist(parent), ["Avatars are served", "It has tests"]);
  assert.deepEqual(qaChecklist(parent, briefed), ["Avatars are served", "Verify"]);
  assert.deepEqual(
    qaChecklist(parent, backend),
    ["Avatars are served", "It has tests"],
    "a part body without the sections falls back to the parent's checklist",
  );
  assert.deepEqual(qaChecklist(issue("MET-9")), ["Matches MET-9 as written"]);
});

test("runQaTests runs setup then tests, stopping at the first failure", async () => {
  const seen: string[] = [];
  const run: CommandRunner = async (command) => {
    seen.push(command);
    return { exitCode: command === "setup" ? 3 : 0, timedOut: false, output: "" };
  };
  const failed = await runQaTests({ setup_command: "setup", test_command: "t" }, "/x", 1000, run);
  assert.deepEqual(seen, ["setup"]);
  assert.equal(failed.passed, false);
  assert.equal(failed.command, "setup");
  assert.equal(failed.exitCode, 3);

  seen.length = 0;
  const passed = await runQaTests({ setup_command: " ", test_command: "t" }, "/x", 1000, run);
  assert.deepEqual(seen, ["t"]);
  assert.equal(passed.passed, true);
});

test("runQaTests starts no step once the shared deadline is spent (D-014)", async () => {
  let clock = 0;
  const started: string[] = [];
  const run: CommandRunner = async (command) => {
    started.push(command);
    clock += 11; // the setup command consumes the whole 10 ms budget
    return { exitCode: 0, timedOut: false, output: "" };
  };
  const result = await runQaTests(
    { setup_command: "setup", test_command: "test" },
    "/x",
    10,
    run,
    () => clock,
  );
  assert.deepEqual(started, ["setup"], "the test command does not start after the deadline");
  assert.equal(result.passed, false);
  assert.equal(result.command, "test");
  assert.equal(result.timedOut, true);
  assert.equal(result.exitCode, null);
});

test("runVerifyChecks shares one deadline and starts no command once it is spent (D-014)", async () => {
  let clock = 0;
  const started: string[] = [];
  const run: CommandRunner = async (command) => {
    started.push(command);
    clock += 11; // the first command consumes the whole 10 ms budget
    return { exitCode: 0, timedOut: false, output: "" };
  };
  const checks = [
    { run: "first", expect: "" },
    { run: "second", expect: "" },
  ];
  const runs = await runVerifyChecks(checks, "/wt", 10, run, () => clock);
  assert.deepEqual(started, ["first"], "the second command does not start after the budget");
  assert.equal(runs.length, 2);
  assert.equal(runs[1]?.result.timedOut, true, "the unrun command counts as a timeout");
  assert.equal(runs[1]?.result.exitCode, null);
});

test("runShellCommand reports the exit code and output, and kills on timeout", async () => {
  const ok = await runShellCommand("echo out; echo err >&2; exit 4", process.cwd(), 10_000);
  assert.equal(ok.exitCode, 4);
  assert.equal(ok.timedOut, false);
  assert.match(ok.output, /out/);
  assert.match(ok.output, /err/);

  const ci = await runShellCommand('printf "%s" "$CI"', process.cwd(), 10_000);
  assert.equal(ci.output, "1");

  const started = Date.now();
  const slow = await runShellCommand("sleep 30", process.cwd(), 200);
  assert.equal(slow.timedOut, true);
  assert.ok(Date.now() - started < 10_000);
});

test("runShellCommand keeps whitespace inside quoted arguments (MET-200)", async () => {
  const same = await runShellCommand('test "a b" = "a b"', process.cwd(), 10_000);
  assert.equal(same.exitCode, 0);
  const different = await runShellCommand('test "a b" = "a  b"', process.cwd(), 10_000);
  assert.equal(different.exitCode, 1, "the two spaces in the second string are kept");
});

test("a Verify command reaches the runner with the spaces inside its quotes (MET-200)", async () => {
  const part = issue("MET-51", {
    parentId: parent.id,
    description: [
      partMarker("backend"),
      "",
      "**Done when**",
      "- [ ] The spacing rule holds",
      "",
      "**Verify**",
      '- `test "a b" = "a  b"` → exits 1',
      "",
      "**QA**: tests",
    ].join("\n"),
  });
  const command = 'test "a b" = "a  b"';
  const h = harness({
    prs: { [part.key]: pr(7, part.key) },
    exits: { [command]: 1 },
  });
  const result = await runQa({ ...h.input, parts: [part] }, h.deps);
  assert.deepEqual(
    h.commands.map((entry) => entry.command),
    ["pnpm test", command],
    "the runner got the command unchanged",
  );
  assert.equal(result.outcome, "changes_requested");
  assert.deepEqual(result.reviews[0]?.failing, [
    'Verify: `test "a b" = "a  b"` exited with code 1',
  ]);
});

test("runShellCommand stops when its signal aborts, and never starts once aborted", async () => {
  const abort = new AbortController();
  const started = Date.now();
  const running = runShellCommand("sleep 30", process.cwd(), 60_000, abort.signal);
  setTimeout(() => abort.abort(), 100);
  const stopped = await running;
  assert.equal(stopped.timedOut, false);
  assert.notEqual(stopped.exitCode, 0);
  assert.ok(Date.now() - started < 10_000);

  const never = await runShellCommand("echo ran", process.cwd(), 10_000, abort.signal);
  assert.equal(never.error, "cancelled");
  assert.equal(never.output, "");
});

test("prepare runs after the tests and before the agent; its env and the memory reach the run", async () => {
  const h = harness({ replies: [verdict([true, true])] });
  const order: string[] = [];
  const runCommand = h.deps.runCommand;
  const result = await runQa(h.input, {
    ...h.deps,
    runCommand: async (command, cwd, timeoutMs) => {
      order.push(`test ${cwd}`);
      return runCommand(command, cwd, timeoutMs);
    },
    prepare: async (path, runId) => {
      order.push(`prepare ${path} ${runId}`);
      return { GIT_CONFIG_COUNT: "1" };
    },
    memory: { workspaceVault: "/repo/.harnessd/vault", globalVault: "/home/.harnessd/vault" },
  });
  assert.equal(result.outcome, "approved");
  assert.deepEqual(order, ["test /wt/qa-sha7", "prepare /wt/qa-sha7 MET-53-qa-1-pr7"]);
  assert.equal(h.tasks[0]?.env?.GIT_CONFIG_COUNT, "1");
  assert.equal(h.tasks[0]?.env?.HARNESSD_QA_RUN, "MET-53-qa-1-pr7");
  assert.equal(
    (h.tasks[0]?.env?.PATH ?? "").split(delimiter)[0],
    qaBrowserBinDir(process.env),
    "the prepare env keeps qa-browser first on PATH",
  );
  assert.match(h.tasks[0]?.prompt ?? "", /## Memory\n/);
  assert.match(h.tasks[0]?.prompt ?? "", /\/repo\/\.harnessd\/vault/);
});

test("a failed prepare is a setup error: no agent runs, nothing is posted", async () => {
  const h = harness({ replies: [verdict([true, true])] });
  const result = await runQa(h.input, {
    ...h.deps,
    prepare: async () => {
      throw new Error("bad config.toml");
    },
  });
  assert.equal(result.outcome, "error");
  assert.equal(result.reviews[0]?.setup, true);
  assert.match(
    result.reviews[0]?.error ?? "",
    /harnessd sync into the worktree failed: bad config\.toml/,
  );
  assert.equal(h.tasks.length, 0);
  assert.equal(h.reviews.length, 0);
  assert.deepEqual(h.removed, ["/wt/qa-sha7"]);

  const s = settleDeps();
  const state = emptyLoopState();
  assert.equal(await settleQa(state, { qa, parent }, result, s.deps), "requeued");
  assert.deepEqual(state.qaFailures, {});
  assert.deepEqual(s.comments, []);
});

test("QA requeues without testing when the approved PR head moved before checkout", async () => {
  const h = harness();
  const result = await runQa(
    { ...h.input, approvedHeads: { [backend.id]: "previous-head" } },
    h.deps,
  );
  assert.equal(result.outcome, "error");
  assert.equal(result.reviews[0]?.setup, true);
  assert.deepEqual(h.checkouts, []);
  assert.deepEqual(h.tasks, []);
  assert.deepEqual(h.reviews, []);
});

test("a round whose budget ran out before the agent is a setup error", async () => {
  const h = harness();
  let clock = 0;
  // The tests pass, but they consume the round's whole budget before the agent can start.
  const result = await runQa(
    { ...h.input, budgetMs: 10 },
    {
      ...h.deps,
      now: () => clock,
      runCommand: async () => {
        clock += 11;
        return { exitCode: 0, timedOut: false, output: "" };
      },
    },
  );
  assert.equal(result.outcome, "error");
  assert.equal(result.reviews[0]?.setup, true);
  assert.match(result.reviews[0]?.error ?? "", /budget ran out before the agent ran/);
  assert.equal(h.tasks.length, 0);
});

test("a limited QA run stops the round: no review, the worktree is removed, no more parts run (MET-70)", async () => {
  const h = harness({
    replies: [{ status: "limited", error: "usage limit reached" }, verdict([true, true])],
    prs: { [backend.key]: pr(7, backend.key), [frontend.key]: pr(8, frontend.key) },
  });
  const result = await runQa({ ...h.input, parts: [backend, frontend] }, h.deps);
  assert.equal(result.limited, true);
  assert.equal(result.outcome, "error");
  assert.equal(h.tasks.length, 1, "the next part waits for the harness");
  assert.equal(h.reviews.length, 0);
  assert.deepEqual(h.removed, ["/wt/qa-sha7"]);
});

test("an app start failure is a setup error: no QA failure, no review, one re-queued line", async () => {
  resetQaAppFailures();
  const h = harness({ replies: [verdict([true, true])], commands: liveQa });
  const result = await runQa(h.input, { ...h.deps, startApp: async () => appFailed() });
  assert.equal(result.outcome, "error");
  assert.equal(result.reviews[0]?.setup, true);
  assert.equal(result.reviews[0]?.error, "app start failed: boom | exit 1");
  assert.equal(h.tasks.length, 0, "the QA agent does not run");
  assert.deepEqual(h.reviews, [], "nothing is posted");
  assert.equal(h.removed[0], "/wt/qa-sha7", "the checkout is still removed");

  const s = settleDeps();
  const state = emptyLoopState();
  state.qaFailures[parent.id] = 1;
  assert.equal(await settleQa(state, { qa, parent }, result, s.deps), "requeued");
  assert.deepEqual(state.qaFailures, { [parent.id]: 1 }, "no QA failure is counted");
  assert.deepEqual(state.qaFeedback, {});
  assert.deepEqual(s.moves, [{ issueId: qa.id, state: "Ready" }]);
  assert.deepEqual(s.comments, []);
  assert.deepEqual(s.pings, []);
  assert.deepEqual(s.logs, ["MET-53: QA not judged (app start failed: boom | exit 1), re-queued"]);
});

test("each app step failure keeps its step name in the setup marker", async () => {
  resetQaAppFailures();
  for (const step of ["build", "seed", "start", "health", "browser"] as const) {
    resetQaAppFailures();
    const h = harness({ replies: [verdict([true, true])], commands: liveQa });
    const result = await runQa(h.input, {
      ...h.deps,
      startApp: async () => appFailed(step, `${step} broke`),
    });
    assert.equal(result.reviews[0]?.setup, true, step);
    assert.equal(result.reviews[0]?.error, `app ${step} failed: ${step} broke`, step);
    assert.equal(h.tasks.length, 0, step);
  }
});

test("a browser setup error re-queues QA and its log line names the fix", async () => {
  resetQaAppFailures();
  const h = harness({ replies: [verdict([true, true])], commands: liveQa });
  const result = await runQa(h.input, {
    ...h.deps,
    startApp: async () =>
      appFailed(
        "browser",
        "no browser found; install Google Chrome, or a Playwright Chromium with `pnpm exec playwright install chromium`",
      ),
  });
  assert.equal(result.reviews[0]?.setup, true);
  const s = settleDeps();
  const state = emptyLoopState();
  assert.equal(await settleQa(state, { qa, parent }, result, s.deps), "requeued");
  assert.deepEqual(state.qaFailures, {}, "no QA failure is counted");
  assert.match(s.logs[0] ?? "", /app browser failed: no browser found; install Google Chrome/);
});

test("the third app setup error on one head runs with no app; a new head resets the count", async () => {
  resetQaAppFailures();
  const h = harness({ replies: [verdict([true, true])], commands: liveQa });
  const startApp = async (): Promise<QaAppStart> => appFailed();
  assert.equal((await runQa(h.input, { ...h.deps, startApp })).reviews[0]?.setup, true);
  assert.equal((await runQa(h.input, { ...h.deps, startApp })).reviews[0]?.setup, true);
  assert.equal(h.tasks.length, 0, "two setup errors run no agent");

  const third = await runQa(h.input, { ...h.deps, startApp });
  assert.equal(h.tasks.length, 1, "the third runs the agent with no live app");
  assert.equal(third.outcome, "approved");
  assert.equal(third.reviews[0]?.appSetup, "app start failed: boom | exit 1");
  assert.ok(h.reviews[0]?.body.startsWith("not run live: app start failed\n"), h.reviews[0]?.body);
  assert.doesNotMatch(h.tasks[0]?.prompt ?? "", /## App/, "no app is named when none runs");
  assert.doesNotMatch(h.tasks[0]?.prompt ?? "", /qa-browser at 390x844/);

  const newHead = await runQa(h.input, {
    ...h.deps,
    github: {
      ...h.deps.github,
      findPrForIssue: async () => ({ ...(pr(7, backend.key) as PullRequest), headRefOid: "sha8" }),
    },
    startApp,
  });
  assert.equal(newHead.reviews[0]?.setup, true, "a new head starts the count again");
  assert.equal(h.tasks.length, 1, "the agent does not run for the new head's first failure");
});

test("the QA prompt names the live app's url and kind, and the app stops after the review", async () => {
  resetQaAppFailures();
  const h = harness({ replies: [verdict([true, true])], commands: liveQa });
  let stopped = 0;
  const result = await runQa(h.input, {
    ...h.deps,
    startApp: async () =>
      appStarted(async () => {
        stopped += 1;
      }),
  });
  assert.equal(result.outcome, "approved");
  const prompt = h.tasks[0]?.prompt ?? "";
  assert.match(
    prompt,
    /## App\nThe product is running at http:\/\/127\.0\.0\.1:4321 \(kind web\)\./,
  );
  assert.match(prompt, /qa-browser/);
  assert.match(prompt, /390x844/);
  assert.match(prompt, /1280x800/);
  assert.doesNotMatch(prompt, /code style|code quality|Read the diff only/);
  assert.match(prompt, /The diff shows what changed and where to look\. It is not evidence/);
  assert.match(prompt, /command you ran, the response you got, or the screenshot path/);
  assert.equal(stopped, 1, "the app stops after an approval");
  assert.doesNotMatch(h.reviews[0]?.body ?? "", /not run live:/, "a live review is not marked");
});

test("the live prompt judges an item the product cannot reach from its tests (MET-229)", () => {
  const tests: TestRun = {
    passed: true,
    command: "pnpm test",
    exitCode: 0,
    timedOut: false,
    output: "ok 12",
  };
  const base = {
    agent,
    qa,
    parent,
    part: backend,
    pr: pr(7, backend.key),
    files: [{ path: "src/avatars.ts", additions: 40, deletions: 2 }],
    checklist: qaChecklist(parent),
    tests,
  };
  const live = buildQaPrompt({
    ...base,
    app: { kind: "web", url: "http://127.0.0.1:4321" },
  });
  assert.match(live, /not reachable live: <reason>;/);
  assert.match(live, /judge the item from the tests\./);
  assert.match(live, /fails only when no test proves it/);
  assert.match(live, /case's `actual` says which test is missing/);
  assert.match(live, /never asks for a secret, an account or a different sandbox/);

  const noApp = buildQaPrompt(base);
  assert.doesNotMatch(noApp, /not reachable live:/, "the no-app prompt is unchanged");
  assert.doesNotMatch(noApp, /fails only when no test proves it/);
  assert.doesNotMatch(noApp, /never asks for a secret/);
});

test("the live prompt tells QA how to test an api and a cli (MET-180)", async () => {
  resetQaAppFailures();
  const api = harness({ replies: [verdict([true, true])], commands: { ...liveQa, kind: "api" } });
  const apiResult = await runQa(api.input, {
    ...api.deps,
    startApp: async () => ({
      ok: true,
      app: { kind: "api", url: "http://127.0.0.1:4321", stop: async () => {} },
    }),
  });
  assert.equal(apiResult.outcome, "approved");
  const apiPrompt = api.tasks[0]?.prompt ?? "";
  assert.match(
    apiPrompt,
    /## App\nThe product is running at http:\/\/127\.0\.0\.1:4321 \(kind api\)\./,
  );
  assert.match(apiPrompt, /Call the api with curl/);

  resetQaAppFailures();
  const cliQa: QaConfig = {
    setup_command: "",
    test_command: "pnpm test",
    kind: "cli",
    start: "node bin/app.js",
  };
  const cli = harness({ replies: [verdict([true, true])], commands: cliQa });
  const cliResult = await runQa(cli.input, {
    ...cli.deps,
    startApp: async () => ({ ok: true, app: { kind: "cli", stop: async () => {} } }),
  });
  assert.equal(cliResult.outcome, "approved");
  const cliPrompt = cli.tasks[0]?.prompt ?? "";
  assert.match(
    cliPrompt,
    /## App\nThe product is a cli \(kind cli\)\. Run it with `node bin\/app\.js`;/,
  );
  assert.match(cliPrompt, /Run the product's commands/);
  assert.doesNotMatch(cliPrompt, /qa-browser/, "a cli has no browser");
});

test("only the QA run gets qa-browser first on PATH, with the live browser endpoint", async () => {
  resetQaAppFailures();
  const h = harness({ replies: [verdict([true, true])], commands: liveQa });
  const result = await runQa(h.input, { ...h.deps, startApp: async () => appStarted() });
  assert.equal(result.outcome, "approved");
  const env = h.tasks[0]?.env ?? {};
  assert.equal(env.HARNESSD_QA_BROWSER, "http://127.0.0.1:9222");
  assert.equal(env.HARNESSD_QA_RUN, "MET-53-qa-1-pr7");
  const dirs = (env.PATH ?? "").split(delimiter);
  assert.equal(dirs[0], qaBrowserBinDir(process.env), "qa-browser's folder is first on PATH");
  assert.equal(dirs.slice(1).join(delimiter), process.env.PATH ?? "");
});

test("a QA run without a live app gets qa-browser but no endpoint", async () => {
  const h = harness({ replies: [verdict([true, true])] });
  const result = await runQa(h.input, h.deps);
  assert.equal(result.outcome, "approved");
  const env = h.tasks[0]?.env ?? {};
  assert.equal(env.HARNESSD_QA_BROWSER, undefined);
  assert.equal(env.HARNESSD_QA_RUN, "MET-53-qa-1-pr7");
  assert.equal((env.PATH ?? "").split(delimiter)[0], qaBrowserBinDir(process.env));
});

test("a pause that lands after the app started still stops the app", async () => {
  resetQaAppFailures();
  const abort = new AbortController();
  const h = harness({ replies: [verdict([true, true])], commands: liveQa });
  let stopped = 0;
  const result = await runQa(h.input, {
    ...h.deps,
    signal: abort.signal,
    startApp: async () => {
      // The pause lands while a passing health probe is in flight, after the app is up.
      abort.abort();
      return appStarted(async () => {
        stopped += 1;
      });
    },
  });
  assert.equal(result.cancelled, true);
  assert.equal(stopped, 1, "the app started before the pause, and it is stopped");
  assert.equal(h.tasks.length, 0, "no agent runs after a pause");
});

test("the app stops when the QA agent hits a usage limit", async () => {
  resetQaAppFailures();
  const h = harness({
    replies: [{ status: "limited", error: "usage limit reached" }],
    commands: liveQa,
  });
  let stopped = 0;
  const result = await runQa(h.input, {
    ...h.deps,
    startApp: async () =>
      appStarted(async () => {
        stopped += 1;
      }),
  });
  assert.equal(result.limited, true);
  assert.equal(stopped, 1, "a limited round still stops the app");
});

test("the app stops when the round errors after it started", async () => {
  resetQaAppFailures();
  const h = harness({ replies: [verdict([true, true])], commands: liveQa });
  let stopped = 0;
  const result = await runQa(h.input, {
    ...h.deps,
    startApp: async () =>
      appStarted(async () => {
        stopped += 1;
      }),
    prepare: async () => {
      throw new Error("bad config.toml");
    },
  });
  assert.equal(result.reviews[0]?.setup, true);
  assert.equal(stopped, 1, "a setup error after start still stops the app");
});

test("a failing test command skips the app lifecycle, so a broken build is a test result", async () => {
  resetQaAppFailures();
  const h = harness({ replies: [verdict([true, true])], testExit: 1, commands: liveQa });
  let called = false;
  const result = await runQa(h.input, {
    ...h.deps,
    startApp: async () => {
      called = true;
      return appStarted();
    },
  });
  assert.equal(called, false);
  assert.equal(result.outcome, "changes_requested");
  assert.match(result.reviews[0]?.failing[0] ?? "", /Tests: `pnpm test` exited with code 1/);
});

test("a GitHub network error keeps the verdict and marks the post not done (MET-213)", async () => {
  const h = harness({ replies: [verdict([true, true])] });
  const result = await runQa(h.input, {
    ...h.deps,
    github: {
      ...h.deps.github,
      async postReview() {
        throw new Error("read ECONNRESET");
      },
    },
  });
  assert.equal(result.outcome, "approved");
  assert.equal(result.reviews[0]?.decision, "approve");
  assert.equal(result.reviews[0]?.error, undefined, "no error review");
  assert.equal(result.reviews[0]?.pendingPost?.event, "APPROVE");
  assert.match(result.reviews[0]?.pendingPost?.body ?? "", /approved/);
  assert.deepEqual(h.reviews, [], "nothing was posted");
});

test("a GitHub network error on a request-changes verdict keeps it, not an error review (MET-213)", async () => {
  const h = harness({ replies: [verdict([true, false])] });
  const result = await runQa(h.input, {
    ...h.deps,
    github: {
      ...h.deps.github,
      async postReview() {
        throw new Error("fetch failed");
      },
    },
  });
  assert.equal(result.outcome, "changes_requested");
  assert.equal(result.reviews[0]?.decision, "request_changes");
  assert.equal(result.reviews[0]?.pendingPost?.event, "REQUEST_CHANGES");
  assert.equal(result.reviews[0]?.cases?.length, 1);
});

test("a Linear network error leaves the settle pending, and the retry writes it once (MET-213)", async () => {
  const h = harness({ replies: [verdict([true, true])] });
  const result = await runQa(h.input, h.deps);
  const state = emptyLoopState();
  const s = settleDeps();
  const comment = s.deps.linear.comment;
  let fail = true;
  s.deps.linear.comment = async (issueId, body) => {
    if (fail) {
      fail = false;
      throw new Error("fetch failed");
    }
    return comment(issueId, body);
  };
  const done: string[] = [];
  const deps = {
    ...s.deps,
    steps: {
      done,
      mark(step: string) {
        done.push(step);
      },
    },
  };

  assert.equal(await settleQa(state, { qa, parent }, result, deps), "pending");
  assert.deepEqual(done, [], "the failed comment is not marked done");
  assert.deepEqual(state.qaFailures, {}, "no QA failure counted");
  assert.equal(s.comments.length, 0);
  assert.equal(s.moves.length, 0, "the move after the comment did not run");

  assert.equal(await settleQa(state, { qa, parent }, result, deps), "approved");
  assert.deepEqual(
    s.comments.map((c) => c.issueId),
    [qa.id],
  );
  assert.deepEqual(s.moves, [{ issueId: qa.id, state: "Ready" }]);
  assert.deepEqual(state.qaFailures, {});
  assert.deepEqual(done, [`comment on ${qa.key}`, `move ${qa.key} to Ready`]);
});

test("without a [qa] table no app starts, and the review says it did not run live", async () => {
  resetQaAppFailures();
  const h = harness({ replies: [verdict([true, true])] });
  let called = false;
  const result = await runQa(h.input, {
    ...h.deps,
    startApp: async () => {
      called = true;
      return appFailed();
    },
  });
  assert.equal(result.outcome, "approved");
  assert.equal(called, false, "the default [qa] table declares no product");
  assert.ok(
    h.reviews[0]?.body.startsWith("not run live: no [qa] kind in .harnessd/config.toml\n"),
    h.reviews[0]?.body,
  );
  const prompt = h.tasks[0]?.prompt ?? "";
  assert.doesNotMatch(prompt, /## App/);
  // With no kind, the prompt judges each item from the tests only (MET-226).
  assert.match(prompt, /Judge each item only from the test results/);
  assert.match(prompt, /An item is about behaviour/);
  assert.doesNotMatch(prompt, /code style|code quality|Judge from this diff|file and line/);
  assert.doesNotMatch(prompt, /qa-browser|390x844|Call the api with curl/);
});
