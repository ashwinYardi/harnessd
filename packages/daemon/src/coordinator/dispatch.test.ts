import assert from "node:assert/strict";
import { test } from "node:test";
import type { LinkedIssue, ResolvedAgentConfig } from "@harnessd/shared";
import { mergeLayers } from "../config/merge.ts";
import { agentForRole, budgetMs, buildPartPrompt } from "./dispatch.ts";

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

test("budgets are S 30 minutes and M 2 hours; a missing size is M; L has none", () => {
  assert.equal(budgetMs("S", limits), 30 * 60_000);
  assert.equal(budgetMs("M", limits), 120 * 60_000);
  assert.equal(budgetMs(undefined, limits), 120 * 60_000);
  assert.equal(budgetMs("L", limits), undefined);
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

test("the part prompt layers the instructions and the brief and ends with commit, push and PR", () => {
  const prompt = buildPartPrompt({ agent, issue, branch: "met-41-serve-avatars" });
  for (const text of [
    "You are backend, the harnessd backend agent.",
    "## Your instructions\nGlobal rules.\n\nBackend rules.",
    '## Task MET-41: Serve "avatars"\nURL: https://linear.test/MET-41\nParent: MET-40\nSize: S',
    "**Brief**\nAdd it.",
    "on branch `met-41-serve-avatars`",
    "2. Commit your changes.",
    "`git push -u origin met-41-serve-avatars`",
    `gh pr create --title "MET-41: Serve 'avatars'"`,
    "Do not merge.",
  ]) {
    assert.ok(prompt.includes(text), text);
  }
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
    "4. Your PR is already open (https://github.test/o/r/pull/7). Pushing updates it; do not open another.",
  ]) {
    assert.ok(prompt.includes(text), text);
  }
  assert.ok(!prompt.includes("gh pr create"));
});
