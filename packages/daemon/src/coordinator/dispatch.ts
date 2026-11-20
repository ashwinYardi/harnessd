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
}

export interface QaPromptInput extends PartPromptInput {
  /** The backend and frontend sub-issues QA checks; each is In Review or Done. */
  parts: LinkedIssue[];
}

/** Builds the QA agent's prompt. MET-13 replaces the default. */
export type QaPromptBuilder = (input: QaPromptInput) => string;

function header(agent: ResolvedAgentConfig, issue: LinkedIssue): string[] {
  const parts = [`You are ${agent.name}, the harnessd ${agent.role} agent.`];
  if (agent.instructions.trim()) parts.push(`## Your instructions\n${agent.instructions.trim()}`);
  const parent = issue.parentKey ? `Parent: ${issue.parentKey}\n` : "";
  parts.push(
    `## Task ${issue.key}: ${issue.title}\nURL: ${issue.url}\n${parent}Size: ${issue.size ?? "M"}\n\n` +
      issue.description.trim(),
  );
  return parts;
}

function shipSteps(issue: LinkedIssue, branch: string, what: string): string {
  return [
    "## When you are done",
    `You are in a git worktree on branch \`${branch}\`. Work only here. Use CLIs only (git, gh); no SDKs.`,
    `1. Make sure ${what} and the repo's checks pass.`,
    "2. Commit your changes.",
    `3. Push the branch: \`git push -u origin ${branch}\`.`,
    `4. Open a PR: \`gh pr create --title "${issue.key}: ${issue.title.replaceAll('"', "'")}" --body "<summary and how it was checked>"\`.`,
    "Do not merge. Do not touch protected paths (auth, payments, secrets, release config, merge-gate config). " +
      "End with one line: the PR URL.",
  ].join("\n");
}

/** The prompt of a backend or frontend run. */
export function buildPartPrompt({ agent, issue, branch }: PartPromptInput): string {
  const parts = header(agent, issue);
  parts.push(shipSteps(issue, branch, 'every "Done when" item in your brief is met, with tests,'));
  return `${parts.join("\n\n")}\n`;
}

/** Default QA prompt: verify each part's PR against the "Done when" list. */
export const buildQaPrompt: QaPromptBuilder = ({ agent, issue, branch, parts }) => {
  const list = parts.map((p) => `- ${p.key} (${p.state}): ${p.title} ${p.url}`).join("\n");
  const out = header(agent, issue);
  out.push(
    `## Parts to verify\n${list}\n\n` +
      "Find each part's PR with `gh pr list --search <KEY>` and check it out. " +
      'Verify every "Done when" item above against the code and the tests, then post one comment per PR ' +
      "with `gh pr comment` listing each item as pass or fail with the evidence.",
    shipSteps(issue, branch, "any tests you add to cover the parts"),
  );
  return `${out.join("\n\n")}\n`;
};
