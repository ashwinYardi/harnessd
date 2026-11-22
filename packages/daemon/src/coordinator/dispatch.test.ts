import assert from "node:assert/strict";
import { test } from "node:test";
import type { LinkedIssue, ResolvedAgentConfig } from "@harnessd/shared";
import { mergeLayers } from "../config/merge.ts";
import { agentForRole, budgetMs, buildPartPrompt, maxTurns } from "./dispatch.ts";

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

test("turn caps are per size for builders and QA, and fixed for the coordinator", () => {
  assert.equal(maxTurns("backend", "S", limits), 80);
  assert.equal(maxTurns("frontend", "M", limits), 160);
  // A missing or unknown size counts as M.
  assert.equal(maxTurns("backend", undefined, limits), 160);
  assert.equal(maxTurns("backend", "L", limits), 160);
  assert.equal(maxTurns("qa", "S", limits), 40);
  assert.equal(maxTurns("qa", "M", limits), 80);
  assert.equal(maxTurns("qa", undefined, limits), 80);
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
