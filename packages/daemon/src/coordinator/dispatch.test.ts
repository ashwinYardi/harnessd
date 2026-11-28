import assert from "node:assert/strict";
import { test } from "node:test";
import type { LinkedIssue, ResolvedAgentConfig } from "@harnessd/shared";
import { mergeLayers } from "../config/merge.ts";
import {
  agentForRole,
  budgetMs,
  buildPartPrompt,
  buildResumePrompt,
  maxTurns,
} from "./dispatch.ts";

const limits = mergeLayers([]).limits;

const agent: ResolvedAgentConfig = {
  name: "backend",
  role: "backend",
  harness: "claude-code",
  instructions: "Global rules.\n\nBackend rules.",
  rules: [],
  skills: [],
};

const issue: LinkedIssue = {
  id: "id-41",
  key: "MET-41",
  title: 'Serve "avatars"',
  description: "harnessd part: backend\n**Brief**\nAdd it.",
  priority: 2,
  state: "In Progress",
  labels: [],
  size: "S",
  doneWhen: [],
  url: "https://linear.test/MET-41",
  blockedBy: [],
  parentId: "id-40",
  parentKey: "MET-40",
  blockers: [],
};

const briefIssue: LinkedIssue = {
  ...issue,
  description: [
    "harnessd part: backend",
    "Part of [MET-40](https://linear.test/MET-40): Agents show avatars. Role: backend.",
    "",
    "**Goal**",
    "Serve the avatar field from the API.",
    "",
    "**Done when**",
    "- [ ] Avatars show",
    "",
    "**Files**",
    "- packages/daemon/src/api.ts",
    "",
    "**Steps**",
    "1. Add the avatar field.",
    "",
    "**Verify**",
    "- `pnpm test` → the API tests pass",
    "",
    "**Out of scope**",
    "The board UI.",
    "",
    "**Decisions**",
    "- D-014: Sets the part sizes.",
    "",
    "**Why**",
    "People tell agents apart.",
    "",
    "**Size**: S",
  ].join("\n"),
};

test("budgets are S 30 minutes and M 2 hours; a missing size is M; L has none", () => {
  assert.equal(budgetMs("S", limits), 30 * 60_000);
  assert.equal(budgetMs("M", limits), 120 * 60_000);
  assert.equal(budgetMs(undefined, limits), 120 * 60_000);
  assert.equal(budgetMs("L", limits), undefined);
});

test("turn caps are per size for builders, QA and the reviewer, and fixed for the coordinator", () => {
  assert.equal(maxTurns("backend", "S", limits), 80);
  assert.equal(maxTurns("frontend", "M", limits), 160);
  // A missing or unknown size counts as M.
  assert.equal(maxTurns("backend", undefined, limits), 160);
  assert.equal(maxTurns("backend", "L", limits), 160);
  assert.equal(maxTurns("qa", "S", limits), 40);
  assert.equal(maxTurns("qa", "M", limits), 80);
  assert.equal(maxTurns("qa", undefined, limits), 80);
  assert.equal(maxTurns("reviewer", "S", limits), 15);
  assert.equal(maxTurns("reviewer", "M", limits), 30);
  assert.equal(maxTurns("reviewer", undefined, limits), 30);
  assert.equal(maxTurns("reviewer", "L", limits), 30);
  assert.equal(maxTurns("coordinator", undefined, limits), 50);
  // The config key is read per size.
  const lower = { ...limits, max_turns: { S: 20, M: 30 } };
  assert.equal(maxTurns("backend", "S", lower), 20);
  assert.equal(maxTurns("backend", "M", lower), 30);
});

test("agentForRole prefers the agent named after the role", () => {
  const config = mergeLayers([]);
  assert.equal(agentForRole(config, "qa"), "qa");
  config.agents = {
    zed: { name: "zed", role: "qa", harness: "claude-code", instructions: [] },
    ada: { name: "ada", role: "qa", harness: "codex", instructions: [] },
  };
  assert.equal(agentForRole(config, "qa"), "ada");
  assert.equal(agentForRole(config, "backend"), undefined);
});

test("the part prompt layers the instructions and the brief; the daemon ships the work", () => {
  const prompt = buildPartPrompt({ agent, issue, branch: "met-41-serve-avatars" });
  for (const text of [
    "You are backend, the harnessd backend agent.",
    "## Your instructions\nGlobal rules.\n\nBackend rules.",
    '## Task MET-41: Serve "avatars"\nURL: https://linear.test/MET-41\nParent: MET-40\nSize: S',
    "**Brief**\nAdd it.",
    "on branch `met-41-serve-avatars`",
    "Edit and test only in this worktree.",
    "Do not run `git commit`, `git push` or `gh pr create`",
    "harnessd pushes the branch and opens the PR after your run.",
    "End with a last message: a summary of the change, and one line on how you checked it.",
    "Do not merge.",
  ]) {
    assert.ok(prompt.includes(text), text);
  }
  assert.ok(!prompt.includes("Commit your changes"));
  assert.ok(!prompt.includes("gh pr create --title"));
});

test("a part body with the fixed brief starts with that brief and keeps the rest after (MET-162)", () => {
  const prompt = buildPartPrompt({ agent, issue: briefIssue, branch: "met-41-serve-avatars" });
  assert.ok(prompt.startsWith("**Goal**\nServe the avatar field from the API."), prompt);
  const order = [
    "**Goal**",
    "**Done when**",
    "**Files**",
    "**Steps**",
    "**Verify**",
    "**Out of scope**",
    "## Your instructions",
    "## Task MET-41",
    "**Decisions**",
    "**Why**",
  ].map((section) => prompt.indexOf(section));
  assert.ok(
    order.every((n) => n >= 0),
    prompt,
  );
  assert.deepEqual(
    order,
    [...order].sort((a, b) => a - b),
    prompt,
  );
  assert.equal(prompt.match(/\*\*Goal\*\*/g)?.length, 1, "the brief appears once");
  assert.ok(prompt.includes("**Decisions**\n- D-014: Sets the part sizes."), prompt);
});

test("a body without a Goal section keeps the full body as before (MET-162)", () => {
  const prompt = buildPartPrompt({ agent, issue, branch: "met-41-serve-avatars" });
  assert.ok(
    prompt.includes(
      '## Task MET-41: Serve "avatars"\nURL: https://linear.test/MET-41\nParent: MET-40\nSize: S\n\nharnessd part: backend\n**Brief**\nAdd it.',
    ),
    prompt,
  );
});

test("a part sent back by QA gets the failing items and is told to update its open PR", () => {
  const prompt = buildPartPrompt({
    agent,
    issue,
    branch: "met-41-serve-avatars",
    review: {
      prUrl: "https://github.test/o/r/pull/7",
      reviewUrl: "https://github.test/o/r/pull/7#pullrequestreview-1",
      failing: ["Has tests: no test covers the 404 path"],
    },
  });
  for (const text of [
    "## QA requested changes",
    "PR: https://github.test/o/r/pull/7\nReview: https://github.test/o/r/pull/7#pullrequestreview-1",
    "- Has tests: no test covers the 404 path",
    "harnessd pushes your work to the open PR (https://github.test/o/r/pull/7) and updates it; do not open another.",
  ]) {
    assert.ok(prompt.includes(text), text);
  }
  assert.ok(!prompt.includes("gh pr create --title"));
});

test("a send-back with cases gets a numbered fix list and the Verify commands (D-054)", () => {
  const cases = [
    {
      id: "C1",
      item: "Avatars show",
      repro: "pnpm test -- avatars",
      expected: "the avatar test passes",
      actual: "not ok 3 - avatars",
    },
    {
      id: "C2",
      item: "Verify",
      repro: "pnpm verify",
      expected: "exit 0",
      actual: "exited with code 1",
    },
  ];
  const cold = buildPartPrompt({
    agent,
    issue: briefIssue,
    branch: "met-41-serve-avatars",
    review: {
      prUrl: "https://github.test/o/r/pull/7",
      failing: ["Avatars show: not ok 3 - avatars", "Verify: exited with code 1"],
      cases,
    },
  });
  for (const text of [
    "1. C1 (Avatars show)",
    "2. C2 (Verify)",
    "repro: pnpm test -- avatars",
    "expected: the avatar test passes",
    "actual: not ok 3 - avatars",
    "repro: pnpm verify",
    "expected: exit 0",
    "actual: exited with code 1",
    "Fix only these cases, add one test per case, then run the part's Verify commands.",
  ]) {
    assert.ok(cold.includes(text), text);
  }

  const resume = buildResumePrompt({
    issue: briefIssue,
    review: {
      prUrl: "https://github.test/o/r/pull/7",
      failing: ["Avatars show: not ok 3 - avatars", "Verify: exited with code 1"],
      cases,
    },
  });
  for (const text of [
    "1. C1 (Avatars show)",
    "repro: pnpm test -- avatars",
    "expected: the avatar test passes",
    "actual: not ok 3 - avatars",
    "Fix only these cases, add one test per case, then run the part's Verify commands.",
    "`pnpm test` → the API tests pass",
  ]) {
    assert.ok(resume.includes(text), text);
  }
});

test("a resumed send-back with no cases keeps the failing list (D-054)", () => {
  const prompt = buildResumePrompt({
    issue: briefIssue,
    review: {
      prUrl: "https://github.test/o/r/pull/7",
      failing: ["Has tests: no test covers the 404 path"],
    },
  });
  assert.ok(prompt.includes("Failing items:\n- Has tests: no test covers the 404 path"));
  assert.ok(!prompt.includes("add one test per case"));
});

test("a review send-back carries the numbered findings and not a QA round (MET-225)", () => {
  const review = {
    source: "review" as const,
    prUrl: "https://github.test/o/r/pull/7",
    failing: ["R1 (src/api.ts:12) The loop reads the file on every tick."],
  };
  const cold = buildPartPrompt({
    agent,
    issue: briefIssue,
    branch: "met-41-serve-avatars",
    review,
  });
  for (const text of [
    "## Review requested changes",
    "The reviewer checked your PR and sent it back. Fix only these findings on this branch.",
    "R1 (src/api.ts:12) The loop reads the file on every tick.",
    "Fix only these findings, run focused tests and the part's Verify commands, and do not commit.",
    "Do not run `git commit`, `git push` or `gh pr create`.",
  ]) {
    assert.ok(cold.includes(text), text);
  }
  assert.ok(!cold.includes("## QA requested changes"));
  assert.ok(!cold.includes("add one test per case"));

  const resume = buildResumePrompt({ issue: briefIssue, review });
  for (const text of [
    "## Review send-back",
    "Findings to fix:\nR1 (src/api.ts:12) The loop reads the file on every tick.",
    "- Fix only these findings, run focused tests and the part's Verify commands.",
    "Run each command before you finish:\n- `pnpm test` → the API tests pass",
    "Do not commit, push or open a PR",
  ]) {
    assert.ok(resume.includes(text), text);
  }
  assert.ok(!resume.includes("## QA send-back"));
});

test("a review send-back prints each hint under its R<n> line (MET-243)", () => {
  const review = {
    source: "review" as const,
    prUrl: "https://github.test/o/r/pull/7",
    failing: [
      "R1 (src/shape.ts:4) This belongs in the review module.",
      "R2 (src/api.ts:12) The loop reads the file on every tick.",
    ],
    hints: [
      { id: "R1", hint: "Move the seam into the review module." },
      { id: "R2", hint: "Read the file once per part run." },
    ],
  };
  const cold = buildPartPrompt({
    agent,
    issue: briefIssue,
    branch: "met-41-serve-avatars",
    review,
  });
  assert.ok(
    cold.includes(
      "R1 (src/shape.ts:4) This belongs in the review module.\n   hint: Move the seam into the review module.\n" +
        "R2 (src/api.ts:12) The loop reads the file on every tick.\n   hint: Read the file once per part run.",
    ),
    cold,
  );

  const resume = buildResumePrompt({ issue: briefIssue, review });
  assert.ok(
    resume.includes(
      "Findings to fix:\nR1 (src/shape.ts:4) This belongs in the review module.\n" +
        "   hint: Move the seam into the review module.\n" +
        "R2 (src/api.ts:12) The loop reads the file on every tick.\n" +
        "   hint: Read the file once per part run.",
    ),
    resume,
  );

  const withoutHints = buildResumePrompt({
    issue: briefIssue,
    review: { source: "review", failing: review.failing },
  });
  assert.ok(
    withoutHints.includes(
      "Findings to fix:\nR1 (src/shape.ts:4) This belongs in the review module.\nR2 (src/api.ts:12)",
    ),
    withoutHints,
  );
  assert.ok(!withoutHints.includes("hint:"), withoutHints);
});

test("with memory, the part prompt names the vaults and the generated files before the ship steps", () => {
  const prompt = buildPartPrompt({
    agent,
    issue,
    branch: "met-41",
    memory: { workspaceVault: "/repo/.harnessd/vault", globalVault: "/home/.harnessd/vault" },
  });
  const memory = prompt.indexOf("## Memory\n");
  assert.ok(memory > 0);
  assert.ok(memory < prompt.indexOf("## When you are done"));
  assert.doesNotMatch(buildPartPrompt({ agent, issue, branch: "met-41" }), /## Memory/);
});
