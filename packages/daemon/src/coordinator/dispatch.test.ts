import assert from "node:assert/strict";
import { test } from "node:test";
import type { LinkedIssue, ResolvedAgentConfig } from "@harnessd/shared";
import { mergeLayers } from "../config/merge.ts";
import { agentForRole, budgetMs, buildPartPrompt, buildQaPrompt } from "./dispatch.ts";

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

test("the default QA prompt lists the parts to verify", () => {
  const prompt = buildQaPrompt({
    agent: { ...agent, name: "qa", role: "qa" },
    issue: { ...issue, key: "MET-43", title: "QA: avatars" },
    branch: "met-43-qa",
    parts: [{ ...issue, state: "In Review" }],
  });
  assert.ok(prompt.includes('- MET-41 (In Review): Serve "avatars" https://linear.test/MET-41'));
  assert.ok(prompt.includes("gh pr comment"));
  assert.ok(prompt.includes('gh pr create --title "MET-43: QA: avatars"'));
});
