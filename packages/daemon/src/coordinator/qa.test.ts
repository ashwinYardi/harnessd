import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type AdapterEvent,
  type AdapterRun,
  emptyTokenUsage,
  type HarnessAdapter,
  type Issue,
  type LinkedIssue,
  type ResolvedAgentConfig,
  type RunResult,
  type Task,
  type WorkflowStateName,
} from "@harnessd/shared";
import type { GitHub, PullRequest, PullRequestStatus, ReviewInput } from "../github/client.ts";
import type { Worktree } from "../worktrees/index.ts";
import { formatNotice, type Notifier } from "./notifier.ts";
import {
  type CommandResult,
  type CommandRunner,
  MAX_TEST_TAIL,
  type PrReview,
  parseQaVerdict,
  type QaRunInput,
  type QaRunResult,
  qaChecklist,
  runQa,
  runQaTests,
  runShellCommand,
  settleQa,
} from "./qa.ts";
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

type Reply = string | { status: RunResult["status"]; error: string };

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
        exitCode: typeof reply === "string" ? 0 : 1,
        durationMs: 5,
        tokens: emptyTokenUsage(),
      };
      if (typeof reply === "string") result.finalText = reply;
      else result.error = reply.error;
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
  /** Make postReview refuse these events. */
  refuse?: string[];
  checkoutFails?: boolean;
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
    const exitCode = command === "pnpm test" ? (options.testExit ?? 0) : 0;
    return { exitCode, timedOut: false, output: exitCode === 0 ? "ok 12" : "not ok 3 - avatars" };
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
    commands: { setup_command: "", test_command: "pnpm test" },
    runCommand,
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

const verdict = (pass: boolean[], testsPassed = true, items = qaChecklist(parent)) =>
  JSON.stringify({
    items: pass.map((p, i) => ({
      text: items[i] ?? `item ${i + 1}`,
      pass: p,
      evidence: p ? `src/avatars.ts:${i + 1}` : `nothing covers item ${i + 1}`,
    })),
    testsPassed,
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
  assert.match(prompt, /Open a file only to check a line the diff touches/);
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

test("the QA agent run gets the role turn cap", async () => {
  const h = harness({ replies: [verdict([true, true])] });
  await runQa({ ...h.input, maxTurns: 40 }, h.deps);
  assert.equal(h.tasks[0]?.maxTurns, 40);
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
  const h = harness({ replies: [verdict([true, true], false)] });
  const result = await runQa(h.input, h.deps);
  assert.equal(result.outcome, "changes_requested");
  assert.match(result.reviews[0]?.failing[0] ?? "", /QA agent saw failing tests/);
});

test("an invalid verdict is a failed QA run: no review, counted, nothing sent back", async () => {
  const h = harness({ replies: ["Looks good to me!"] });
  const result = await runQa(h.input, h.deps);
  assert.equal(result.outcome, "error");
  assert.equal(h.reviews.length, 0);
  assert.match(result.reviews[0]?.error ?? "", /QA verdict was unusable: not JSON/);

  const s = settleDeps();
  const state = emptyLoopState();
  assert.equal(await settleQa(state, { qa, parent }, result, s.deps), "sent_back");
  assert.equal(state.qaFailures[parent.id], 1);
  assert.deepEqual(state.qaFeedback, {});
  assert.deepEqual(s.moves, [{ issueId: qa.id, state: "Ready" }], "only QA runs again");
  assert.match(s.comments[0]?.body ?? "", /QA could not judge every PR, so MET-53 runs again/);
  assert.match(s.comments[0]?.body ?? "", /not judged: the QA verdict was unusable/);
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
    { issueId: qa.id, state: "Needs input" },
    { issueId: parent.id, state: "Needs input" },
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
    bad(JSON.stringify({ items: [item], testsPassed: true, extra: 1 })),
    /unknown key "extra"/,
  );
  assert.match(bad(JSON.stringify({ items: [item] })), /testsPassed: expected true or false/);
  assert.match(bad(JSON.stringify({ items: [item], testsPassed: "yes" })), /testsPassed/);
  assert.match(bad(JSON.stringify({ items: [item], testsPassed: true }), 2), /expected 2.*got 1/);
  assert.match(
    bad(JSON.stringify({ items: [{ ...item, pass: "true" }], testsPassed: true })),
    /items\[0\]\.pass/,
  );
  assert.match(
    bad(JSON.stringify({ items: [{ ...item, evidence: " " }], testsPassed: true })),
    /items\[0\]\.evidence: expected a non-empty string/,
  );
  assert.match(
    bad(JSON.stringify({ items: [{ ...item, note: "x" }], testsPassed: true })),
    /items\[0\]: unknown key "note"/,
  );
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
  assert.deepEqual(h.tasks[0]?.env, { GIT_CONFIG_COUNT: "1" });
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

test("a round whose budget ran out before the agent is a setup error", async () => {
  const h = harness();
  const result = await runQa({ ...h.input, budgetMs: 0 }, h.deps);
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
