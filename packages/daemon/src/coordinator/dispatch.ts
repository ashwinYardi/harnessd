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

export interface PartPromptInput {
  agent: ResolvedAgentConfig;
  /** The sub-issue being worked. */
  issue: LinkedIssue;
  /** The worktree's branch. */
  branch: string;
  /** What QA asked to fix, when the part was sent back (docs/LOOP.md "QA"). */
  review?: QaFeedback;
}

export function agentPromptHeader(agent: ResolvedAgentConfig, issue: LinkedIssue): string[] {
  const parts = [`You are ${agent.name}, the harnessd ${agent.role} agent.`];
  if (agent.instructions.trim()) parts.push(`## Your instructions\n${agent.instructions.trim()}`);
  const parent = issue.parentKey ? `Parent: ${issue.parentKey}\n` : "";
  parts.push(
    `## Task ${issue.key}: ${issue.title}\nURL: ${issue.url}\n${parent}Size: ${issue.size ?? "M"}\n\n` +
      issue.description.trim(),
  );
  return parts;
}

function shipSteps(issue: LinkedIssue, branch: string, what: string, review?: QaFeedback): string {
  const open = review?.prUrl
    ? `4. Your PR is already open (${review.prUrl}). Pushing updates it; do not open another.`
    : `4. Open a PR: \`gh pr create --title "${issue.key}: ${issue.title.replaceAll('"', "'")}" --body "<summary and how it was checked>"\`.`;
  return [
    "## When you are done",
    `You are in a git worktree on branch \`${branch}\`. Work only here. Use CLIs only (git, gh); no SDKs.`,
    `1. Make sure ${what} and the repo's checks pass.`,
    "2. Commit your changes.",
    `3. Push the branch: \`git push -u origin ${branch}\`.`,
    open,
    "Do not merge. Do not touch protected paths (auth, payments, secrets, release config, merge-gate config). " +
      "End with one line: the PR URL.",
  ].join("\n");
}

/** The prompt of a backend or frontend run. */
export function buildPartPrompt({ agent, issue, branch, review }: PartPromptInput): string {
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
  parts.push(
    shipSteps(issue, branch, 'every "Done when" item in your brief is met, with tests,', review),
  );
  return `${parts.join("\n\n")}\n`;
}
