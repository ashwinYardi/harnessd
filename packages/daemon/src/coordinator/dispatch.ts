// What an agent gets when the loop dispatches a sub-issue: budget, agent and prompt.
// See docs/LOOP.md.
import type {
  AgentRole,
  LimitsConfig,
  LinkedIssue,
  MergedConfig,
  ResolvedAgentConfig,
  Size,
} from "@harnessd/shared";
import { type AgentMemory, memorySection } from "./prompt.ts";
import type { QaFeedback } from "./state.ts";

/**
 * Wall-clock budget of a run by size (D-014), from `limits.budget_minutes`.
 * A missing size counts as M. L has no budget: it must be split, never run.
 */
export function budgetMs(size: Size | undefined, limits: LimitsConfig): number | undefined {
  const s = size ?? "M";
  if (s === "L") return undefined;
  return limits.budget_minutes[s] * 60_000;
}

/** The agent that plays a role: the one named after it, else the first by name. */
export function agentForRole(config: MergedConfig, role: AgentRole): string | undefined {
  if (config.agents[role]?.role === role) return role;
  return Object.keys(config.agents)
    .sort()
    .find((name) => config.agents[name]?.role === role);
}

/** Fixed turn caps for the roles that do not use the size key (D-045). */
export const QA_MAX_TURNS = 40;
export const COORDINATOR_MAX_TURNS = 50;

/**
 * Turn cap of a run by role and size (D-045). Builder part runs use `limits.max_turns` for
 * the part's size; a missing or unknown size counts as M. QA, grill and plan use fixed caps.
 */
export function maxTurns(role: AgentRole, size: Size | undefined, limits: LimitsConfig): number {
  if (role === "qa") return QA_MAX_TURNS;
  if (role === "coordinator") return COORDINATOR_MAX_TURNS;
  // L never runs; an unknown or L size counts as M, as for the budgets.
  return size === "S" ? limits.max_turns.S : limits.max_turns.M;
}

export interface PartPromptInput {
  agent: ResolvedAgentConfig;
  /** The sub-issue being worked. */
  issue: LinkedIssue;
  /** The worktree's branch. */
  branch: string;
  /** What QA asked to fix, when the part was sent back (docs/LOOP.md "QA"). */
  review?: QaFeedback;
  /** The vaults, when the loop synced the harness files into the worktree (MET-55). */
  memory?: AgentMemory;
}

export function agentPromptHeader(agent: ResolvedAgentConfig, issue: LinkedIssue): string[] {
  const parts = [`You are ${agent.name}, the harnessd ${agent.role} agent.`];
  parts.push("This issue is already grilled and split; ignore any instruction to run the grill.");
  if (agent.instructions.trim()) parts.push(`## Your instructions\n${agent.instructions.trim()}`);
  const parent = issue.parentKey ? `Parent: ${issue.parentKey}\n` : "";
  parts.push(
    `## Task ${issue.key}: ${issue.title}\nURL: ${issue.url}\n${parent}Size: ${issue.size ?? "M"}\n\n` +
      issue.description.trim(),
  );
  return parts;
}

function shipSteps(branch: string, what: string, review?: QaFeedback): string {
  const ship = review?.prUrl
    ? `harnessd pushes your work to the open PR (${review.prUrl}) and updates it; do not open another.`
    : "harnessd pushes the branch and opens the PR after your run.";
  return [
    "## When you are done",
    `You are in a git worktree on branch \`${branch}\`. Edit and test only in this worktree.`,
    `1. Make sure ${what} and the repo's checks pass. Run focused tests, not the full suite unless the change is global, and read file ranges rather than whole large files.`,
    "2. Do not run `git commit`, `git push` or `gh pr create`. harnessd ships the work after your run.",
    ship,
    "End with a last message: a summary of the change, and one line on how you checked it. " +
      "Do not merge. Do not touch protected paths (auth, payments, secrets, release config, merge-gate config).",
  ].join("\n");
}

/** The prompt of a backend or frontend run. */
export function buildPartPrompt({ agent, issue, branch, review, memory }: PartPromptInput): string {
  const parts = agentPromptHeader(agent, issue);
  if (review) {
    const where = [
      review.prUrl ? `PR: ${review.prUrl}` : "",
      review.reviewUrl ? `Review: ${review.reviewUrl}` : "",
    ].filter(Boolean);
    parts.push(
      `## QA requested changes\nQA checked your PR and sent it back. Fix every item below on this branch.\n${where.join("\n")}\n\n` +
        review.failing.map((f) => `- ${f}`).join("\n"),
    );
  }
  if (memory) parts.push(memorySection(memory));
  parts.push(shipSteps(branch, 'every "Done when" item in your brief is met, with tests,', review));
  return `${parts.join("\n\n")}\n`;
}
