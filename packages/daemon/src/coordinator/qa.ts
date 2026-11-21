// QA: every part's PR is checked against the parent's "Done when" checklist before merge
// (SPEC "Autonomy loop" step 5, D-013, D-014). See docs/LOOP.md "QA".
//
// For each part: find its PR (the part key is in the title), check the PR head out in a
// worktree of its own, run the repo's tests in harnessd, then run the QA agent for a
// strict JSON verdict. harnessd approves only when every item passes and the tests pass,
// whatever the model says; anything else requests changes. `settleQa` then moves the
// sub-issues, and the second failed round goes to the human instead of looping.
import { spawn } from "node:child_process";
import type {
  HarnessAdapter,
  Issue,
  LinkedIssue,
  QaConfig,
  ResolvedAgentConfig,
  Task,
} from "@harnessd/shared";
import type { GitHub, PullRequest, PullRequestFile, ReviewEvent } from "../github/client.ts";
import type { LinearClient } from "../linear/client.ts";
import type { TaskWorktrees } from "../worktrees/index.ts";
import { agentPromptHeader } from "./dispatch.ts";
import { extractJson, runForReply } from "./grill.ts";
import type { Notifier } from "./notifier.ts";
import { type AgentMemory, memorySection } from "./prompt.ts";
import { readPartMarker } from "./split.ts";
import type { LoopState } from "./state.ts";

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// --- the deterministic check: the repo's tests ----------------------------

export interface CommandResult {
  /** Null when the process died from a signal or never started. */
  exitCode: number | null;
  timedOut: boolean;
  /** stdout and stderr interleaved, at most MAX_COMMAND_OUTPUT characters (the tail). */
  output: string;
  /** Why the command could not start. */
  error?: string;
}

/**
 * Runs one shell command in `cwd`. Injectable so tests need no real toolchain. Aborting
 * `signal` (a pause) stops the command.
 */
export type CommandRunner = (
  command: string,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
) => Promise<CommandResult>;

export const MAX_COMMAND_OUTPUT = 64 * 1024;

/** `sh -c <command>` in its own process group with CI=1; the group is killed on timeout or abort. */
export const runShellCommand: CommandRunner = (command, cwd, timeoutMs, signal) =>
  new Promise((resolve) => {
    let output = "";
    let timedOut = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (exitCode: number | null, error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", terminate);
      const result: CommandResult = { exitCode, timedOut, output };
      if (error !== undefined) result.error = error;
      resolve(result);
    };
    let pid: number | undefined;
    const kill = (sig: NodeJS.Signals) => {
      try {
        if (pid !== undefined) process.kill(-pid, sig);
      } catch {
        // already gone
      }
    };
    function terminate() {
      kill("SIGTERM");
      setTimeout(() => kill("SIGKILL"), 5_000).unref();
    }
    if (signal?.aborted) {
      finish(null, "cancelled");
      return;
    }
    signal?.addEventListener("abort", terminate, { once: true });
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("sh", ["-c", command], {
        cwd,
        detached: true,
        env: { ...process.env, CI: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      finish(null, message(error));
      return;
    }
    pid = child.pid;
    const append = (chunk: string) => {
      output = (output + chunk).slice(-MAX_COMMAND_OUTPUT);
    };
    child.stdout?.setEncoding("utf8").on("data", append);
    child.stderr?.setEncoding("utf8").on("data", append);
    timer = setTimeout(
      () => {
        timedOut = true;
        terminate();
      },
      Math.max(timeoutMs, 1),
    );
    child.on("error", (error) => {
      if (child.pid === undefined) finish(null, error.message);
    });
    child.on("close", (code) => finish(code));
  });

/** The outcome of `qa.setup_command` then `qa.test_command`. */
export interface TestRun {
  passed: boolean;
  /** The command that decided: the failing one, else the test command. */
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  output: string;
  error?: string;
}

/** Runs the setup command (unless empty) and then the tests, within `timeoutMs` in total. */
export async function runQaTests(
  commands: QaConfig,
  cwd: string,
  timeoutMs: number,
  run: CommandRunner = runShellCommand,
  now: () => number = Date.now,
  signal?: AbortSignal,
): Promise<TestRun> {
  const deadline = now() + timeoutMs;
  const steps = [commands.setup_command.trim(), commands.test_command.trim()].filter(Boolean);
  let last: TestRun | undefined;
  for (const command of steps) {
    const result = await run(command, cwd, Math.max(deadline - now(), 1), signal);
    last = {
      passed: result.exitCode === 0 && !result.timedOut && result.error === undefined,
      command,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      output: result.output,
    };
    if (result.error !== undefined) last.error = result.error;
    if (!last.passed || signal?.aborted) return last;
  }
  return last ?? { passed: false, command: "", exitCode: null, timedOut: false, output: "" };
}

function describeTests(tests: TestRun): string {
  if (tests.passed) return `\`${tests.command}\` passed`;
  if (tests.timedOut) return `\`${tests.command}\` timed out`;
  if (tests.error !== undefined)
    return `\`${tests.command}\` could not run (${oneLine(tests.error)})`;
  return `\`${tests.command}\` exited with code ${tests.exitCode ?? "null (killed)"}`;
}

function tail(text: string, chars: number): string {
  const t = text.trimEnd();
  return t.length <= chars ? t : `…${t.slice(-chars)}`;
}

// --- the verdict ------------------------------------------------------------

export interface QaVerdictItem {
  text: string;
  pass: boolean;
  evidence: string;
}

export interface QaVerdict {
  items: QaVerdictItem[];
  testsPassed: boolean;
}

export type ParsedQaVerdict = { ok: true; verdict: QaVerdict } | { ok: false; error: string };

/** The JSON shape the QA agent must end with. */
export const QA_VERDICT_SHAPE = `{
  "items": [{ "text": "string", "pass": true | false, "evidence": "string" }],
  "testsPassed": true | false
}`;

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const ITEM_KEYS = ["text", "pass", "evidence"];

/**
 * Strictly validates a verdict: known keys only, booleans for `pass` and `testsPassed`,
 * non-empty `text` and `evidence`, and exactly one item per "Done when" item.
 */
export function parseQaVerdict(text: string, expectedItems: number): ParsedQaVerdict {
  let value: unknown;
  try {
    value = JSON.parse(extractJson(text));
  } catch (error) {
    return { ok: false, error: `not JSON: ${(error as Error).message}` };
  }
  if (!isObj(value)) return { ok: false, error: "expected a JSON object" };
  for (const key of Object.keys(value)) {
    if (key !== "items" && key !== "testsPassed") {
      return { ok: false, error: `unknown key "${key}"` };
    }
  }
  if (!Array.isArray(value.items)) return { ok: false, error: "items: expected an array" };
  if (typeof value.testsPassed !== "boolean") {
    return { ok: false, error: "testsPassed: expected true or false" };
  }
  if (value.items.length !== expectedItems) {
    return {
      ok: false,
      error: `items: expected ${expectedItems}, one per "Done when" item, got ${value.items.length}`,
    };
  }
  const items: QaVerdictItem[] = [];
  for (const [i, raw] of value.items.entries()) {
    const path = `items[${i}]`;
    if (!isObj(raw)) return { ok: false, error: `${path}: expected an object` };
    for (const key of Object.keys(raw)) {
      if (!ITEM_KEYS.includes(key)) return { ok: false, error: `${path}: unknown key "${key}"` };
    }
    if (typeof raw.pass !== "boolean") {
      return { ok: false, error: `${path}.pass: expected true or false` };
    }
    for (const key of ["text", "evidence"]) {
      const v = raw[key];
      if (typeof v !== "string" || v.trim() === "") {
        return { ok: false, error: `${path}.${key}: expected a non-empty string` };
      }
    }
    items.push({
      text: (raw.text as string).trim(),
      pass: raw.pass,
      evidence: (raw.evidence as string).trim(),
    });
  }
  return { ok: true, verdict: { items, testsPassed: value.testsPassed } };
}

// --- the prompt ---------------------------------------------------------------

/** The parent's "Done when" items; an issue without any is checked "as written". */
export function qaChecklist(parent: Issue): string[] {
  if (parent.doneWhen.length === 0) return [`Matches ${parent.key} as written`];
  return parent.doneWhen.map((d) => oneLine(d.text));
}

/** Files listed in the prompt; the agent reads the full diff with `gh pr diff`. */
const MAX_PROMPT_FILES = 200;

export interface QaPromptInput {
  agent: ResolvedAgentConfig;
  qa: LinkedIssue;
  parent: Issue;
  part: LinkedIssue;
  pr: PullRequest;
  /** Undefined when `gh` could not list them. */
  files: PullRequestFile[] | undefined;
  checklist: string[];
  tests: TestRun;
  /** The vaults, when the loop synced the harness files into the checkout (MET-55). */
  memory?: AgentMemory;
}

/** The QA agent's prompt for one PR. */
export function buildQaPrompt(input: QaPromptInput): string {
  const { agent, qa, parent, part, pr, files, checklist, tests, memory } = input;
  const out = agentPromptHeader(agent, qa);

  let fileList: string;
  if (files === undefined) fileList = "(could not list them; run `gh pr diff`)";
  else if (files.length === 0) fileList = "(none)";
  else {
    fileList = files
      .slice(0, MAX_PROMPT_FILES)
      .map((f) => `- ${f.path} (+${f.additions} -${f.deletions})`)
      .join("\n");
    if (files.length > MAX_PROMPT_FILES) {
      fileList += `\n- … ${files.length - MAX_PROMPT_FILES} more`;
    }
  }
  out.push(
    `## PR to verify\nPart ${part.key}: ${part.title} (${part.url})\n` +
      `PR #${pr.number}: ${pr.title}\n${pr.url}\n` +
      `Branch \`${pr.headRefName}\` at \`${pr.headRefOid}\`, into \`${pr.baseRefName}\`.\n\n` +
      `Changed files (${files?.length ?? "?"}); the full diff is \`gh pr diff ${pr.number}\`:\n${fileList}`,
    `## Tests\nharnessd ran the repo's tests in this worktree before you started: ${describeTests(tests)}.\n` +
      `\`\`\`text\n${tail(tests.output, 3000) || "(no output)"}\n\`\`\``,
    `## Done when (${parent.key}: ${parent.title})\n${checklist.map((c, i) => `${i + 1}. ${c}`).join("\n")}`,
    [
      "## How to verify",
      "- This worktree is a detached checkout of the PR head. Read the diff and the code, and run what you need.",
      "- Do not edit files, commit, push, comment or review: harnessd posts the review from your verdict.",
      "- An item passes only with concrete evidence: a file and line, a test name, or command output.",
      "- An item outside this part's brief passes when this PR does not break it and another part covers it; say so in the evidence.",
      "- `testsPassed` is false when any test or check you ran fails.",
    ].join("\n"),
  );
  if (memory) out.push(memorySection(memory));
  out.push(
    `## Verdict\nYour final message is strict JSON only, no prose and no code fence, with exactly ${checklist.length} ` +
      `item(s), one per "Done when" item in the order above, \`text\` copied from the list:\n${QA_VERDICT_SHAPE}`,
  );
  return `${out.join("\n\n")}\n`;
}

// --- one PR -------------------------------------------------------------------

export type ReviewDecision = "approve" | "request_changes" | "error";

/** What QA concluded about one part. */
export interface PrReview {
  part: LinkedIssue;
  /** Undefined when no open PR carries the part's key. */
  pr?: PullRequest;
  /** `error` means QA itself could not judge; no review is posted. */
  decision: ReviewDecision;
  /** One line per failing item: the item and its evidence. */
  failing: string[];
  /** The posted review. */
  reviewUrl?: string;
  /** COMMENT when GitHub refused the real review event (e.g. on your own PR). */
  postedAs?: ReviewEvent;
  error?: string;
}

interface Decision {
  decision: ReviewDecision;
  failing: string[];
  passing: string[];
  note?: string;
  error?: string;
}

/** Approve only when every item passes and the tests pass in harnessd and for the agent. */
export function decideReview(
  checklist: string[],
  tests: TestRun,
  verdict: ParsedQaVerdict,
): Decision {
  const failing: string[] = [];
  const passing: string[] = [];
  if (!tests.passed) {
    const said =
      verdict.ok && verdict.verdict.testsPassed ? ", although the QA agent said they pass" : "";
    failing.push(`Tests: ${describeTests(tests)} when harnessd ran it${said}`);
  }
  if (!verdict.ok) {
    const error = `the QA verdict was unusable: ${verdict.error}`;
    if (failing.length === 0) return { decision: "error", failing, passing, error };
    return { decision: "request_changes", failing, passing, note: `Also, ${error}.` };
  }
  if (tests.passed && !verdict.verdict.testsPassed) {
    failing.push("Tests: the QA agent saw failing tests or checks (see the items' evidence)");
  }
  for (const [i, item] of verdict.verdict.items.entries()) {
    const line = `${checklist[i] ?? item.text}: ${oneLine(item.evidence)}`;
    (item.pass ? passing : failing).push(line);
  }
  return { decision: failing.length === 0 ? "approve" : "request_changes", failing, passing };
}

export interface ReviewBodyInput {
  qa: LinkedIssue;
  parent: Issue;
  decision: Decision;
  tests: TestRun;
  round: number;
  maxRounds: number;
}

/** The PR review body. */
export function formatReviewBody(input: ReviewBodyInput): string {
  const { qa, parent, decision, tests, round, maxRounds } = input;
  const lines: string[] = [];
  if (decision.decision === "approve") {
    lines.push(
      `**harnessd QA** (${qa.key}): approved. Every "Done when" item of ${parent.key} passes and ${describeTests(tests)}.`,
      "",
      ...decision.passing.map((p) => `- [x] ${p}`),
    );
    return `${lines.join("\n")}\n`;
  }
  lines.push(
    `**harnessd QA** (${qa.key}): changes requested, round ${round} of ${maxRounds} (D-014).`,
    "",
    "Failing:",
    ...decision.failing.map((f) => `- [ ] ${f}`),
  );
  if (decision.passing.length > 0) {
    lines.push("", "Passing:", ...decision.passing.map((p) => `- [x] ${p}`));
  }
  if (decision.note) lines.push("", decision.note);
  if (!tests.passed) {
    lines.push(
      "",
      `Last lines of \`${tests.command}\`:`,
      "```text",
      tail(tests.output, 3000),
      "```",
    );
  }
  return `${lines.join("\n")}\n`;
}

// --- a QA round ---------------------------------------------------------------

export interface QaRunInput {
  qa: LinkedIssue;
  parent: Issue;
  /** The parts that block the QA sub-issue. Done parts are skipped. */
  parts: LinkedIssue[];
  /** D-014 budget of the whole round: checkouts, tests and agent runs. */
  budgetMs: number;
  /** 1 for the first round; shown in the review. */
  round: number;
  /** `limits.qa_max_failures`. */
  maxRounds: number;
}

export interface QaRunDeps {
  github: GitHub;
  worktrees: Pick<TaskWorktrees, "checkout" | "remove">;
  /** The QA agent's harness. */
  adapter: HarnessAdapter;
  agent: ResolvedAgentConfig;
  commands: QaConfig;
  runCommand?: CommandRunner;
  now?: () => number;
  /** Told the worktree in use ("" once removed), so a crash can clean it up. */
  onWorktree?: (path: string) => void;
  /**
   * Runs after the tests and before the QA agent, in the checkout: the loop syncs the
   * harness files there (MET-55). Returns env for the agent run. A throw is an error review.
   */
  prepare?: (worktree: string, runId: string) => Promise<Record<string, string>>;
  /** The vaults, named in the QA prompt. */
  memory?: AgentMemory;
  /**
   * Aborted by a pause: the tests and the QA agent are stopped, no review is posted and
   * the worktree in use is kept for the loop to record. The result is then `cancelled`.
   */
  signal?: AbortSignal;
  log?: (line: string) => void;
}

export interface QaRunResult {
  /** `changes_requested` when any part must change; `error` when QA could not judge some. */
  outcome: "approved" | "changes_requested" | "error";
  reviews: PrReview[];
  /** True when `signal` stopped the round early. Nothing was posted for the PR in progress. */
  cancelled?: boolean;
  /**
   * True when the QA agent's harness hit a usage limit (MET-70). The round stopped there:
   * nothing was posted for that PR and no later part ran. It is no QA failure.
   */
  limited?: boolean;
}

/** Reviews every part's PR. Never throws: a broken step is an `error` review. */
export async function runQa(input: QaRunInput, deps: QaRunDeps): Promise<QaRunResult> {
  const { qa, parent } = input;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const deadline = now() + input.budgetMs;
  const checklist = qaChecklist(parent);
  const cancelled = () => deps.signal?.aborted === true;
  let limited = false;
  const stopped = (part: LinkedIssue, pr?: PullRequest): PrReview => ({
    part,
    ...(pr ? { pr } : {}),
    decision: "error",
    failing: [],
    error: "cancelled by harnessd pause",
  });

  async function post(pr: PullRequest, event: ReviewEvent, body: string) {
    try {
      const url = await deps.github.postReview(pr.number, { event, body, commitId: pr.headRefOid });
      return { url, postedAs: event };
    } catch (error) {
      // GitHub refuses APPROVE and REQUEST_CHANGES on your own PR, which is the norm when
      // every agent shares one `gh` login. A comment review still carries the verdict.
      log(`${qa.key}: ${event} on PR #${pr.number} refused (${message(error)}), posting a comment`);
      const url = await deps.github.postReview(pr.number, {
        event: "COMMENT",
        body,
        commitId: pr.headRefOid,
      });
      return { url, postedAs: "COMMENT" as const };
    }
  }

  async function review(part: LinkedIssue): Promise<PrReview> {
    let pr: PullRequest | undefined;
    try {
      pr = await deps.github.findPrForIssue(part.key);
    } catch (error) {
      return {
        part,
        decision: "error",
        failing: [],
        error: `could not look up the PR: ${message(error)}`,
      };
    }
    if (pr === undefined) {
      return {
        part,
        decision: "request_changes",
        failing: [`No open PR has ${part.key} in its title. Push the branch and open one.`],
      };
    }
    const checkout = {
      issueKey: qa.key,
      title: `pr ${pr.number}`,
      branch: pr.headRefName,
      sha: pr.headRefOid,
    };
    let path: string;
    try {
      path = (await deps.worktrees.checkout(checkout)).path;
    } catch (error) {
      return {
        part,
        pr,
        decision: "error",
        failing: [],
        error: `could not check out PR #${pr.number}: ${message(error)}`,
      };
    }
    deps.onWorktree?.(path);
    if (cancelled()) return stopped(part, pr);

    let tests: TestRun;
    let verdict: ParsedQaVerdict;
    try {
      const files = await deps.github.prFiles(pr.number).catch((error) => {
        log(`${qa.key}: could not list the files of PR #${pr.number}: ${message(error)}`);
        return undefined;
      });
      tests = await runQaTests(
        deps.commands,
        path,
        deadline - now(),
        deps.runCommand,
        now,
        deps.signal,
      );
      const left = deadline - now();
      if (cancelled()) {
        verdict = { ok: false, error: "cancelled by harnessd pause" };
      } else if (left <= 0) {
        verdict = { ok: false, error: "the QA budget ran out before the agent ran" };
      } else {
        const id = `${qa.key}-qa-${input.round}-pr${pr.number}`;
        let env: Record<string, string> | undefined;
        if (deps.prepare) {
          try {
            env = await deps.prepare(path, id);
          } catch (error) {
            throw new Error(`harnessd sync into the worktree failed: ${message(error)}`);
          }
        }
        const task: Task = {
          id,
          title: `QA ${part.key}: PR #${pr.number}`,
          prompt: buildQaPrompt({
            agent: deps.agent,
            qa,
            parent,
            part,
            pr,
            files,
            checklist,
            tests,
            ...(deps.memory ? { memory: deps.memory } : {}),
          }),
          budgetMs: left,
        };
        if (deps.agent.model !== undefined) task.model = deps.agent.model;
        if (env !== undefined) task.env = env;
        const reply = await runForReply(deps.adapter, task, path);
        if (!reply.ok && reply.limited) limited = true;
        verdict = reply.ok ? parseQaVerdict(reply.text, checklist.length) : reply;
      }
    } catch (error) {
      if (cancelled()) return stopped(part, pr);
      return { part, pr, decision: "error", failing: [], error: message(error) };
    } finally {
      // A pause keeps the worktree in use for inspection (MET-15); the loop records it.
      if (!cancelled()) {
        // A detached PR-head checkout holds no branch work: remove it as a scratch tree.
        await deps.worktrees
          .remove(path, { scratch: true })
          .catch((error) => log(`${qa.key}: could not remove ${path}: ${message(error)}`));
        deps.onWorktree?.("");
      }
    }
    if (cancelled()) return stopped(part, pr);
    if (limited)
      return {
        part,
        pr,
        decision: "error",
        failing: [],
        error: verdict.ok ? "limited" : verdict.error,
      };

    const decision = decideReview(checklist, tests, verdict);
    if (decision.decision === "error") {
      return { part, pr, decision: "error", failing: [], error: decision.error ?? "unknown" };
    }
    const body = formatReviewBody({
      qa,
      parent,
      decision,
      tests,
      round: input.round,
      maxRounds: input.maxRounds,
    });
    const event: ReviewEvent = decision.decision === "approve" ? "APPROVE" : "REQUEST_CHANGES";
    const result: PrReview = { part, pr, decision: decision.decision, failing: decision.failing };
    try {
      const posted = await post(pr, event, body);
      result.reviewUrl = posted.url;
      result.postedAs = posted.postedAs;
    } catch (error) {
      log(`${qa.key}: could not post the review on PR #${pr.number}: ${message(error)}`);
      // Without a posted approval nothing may merge; changes requested still go back.
      if (decision.decision === "approve") {
        return {
          part,
          pr,
          decision: "error",
          failing: [],
          error: `could not post the approval: ${message(error)}`,
        };
      }
    }
    return result;
  }

  const reviews: PrReview[] = [];
  for (const part of input.parts) {
    if (cancelled() || limited) break;
    if (part.state.toLowerCase() === "done") {
      log(`${qa.key}: ${part.key} is Done, not reviewed`);
      continue;
    }
    reviews.push(await review(part));
  }
  if (cancelled()) return { outcome: "error", reviews, cancelled: true };
  if (limited) return { outcome: "error", reviews, limited: true };
  const outcome = reviews.some((r) => r.decision === "request_changes")
    ? "changes_requested"
    : reviews.some((r) => r.decision === "error")
      ? "error"
      : "approved";
  return { outcome, reviews };
}

// --- after a round: Linear and the loop state ----------------------------------

/** The Linear calls settling a round makes. A LinearClient satisfies it. */
export type QaLinear = Pick<LinearClient, "comment" | "moveTo">;

export interface QaSettleDeps {
  linear: QaLinear;
  notifier: Notifier;
  /** `limits.qa_max_failures`: failed rounds before the human is asked (D-014). */
  maxFailures: number;
  log?: (line: string) => void;
}

export type QaSettlement = "approved" | "sent_back" | "escalated";

function reviewLines(reviews: PrReview[]): string[] {
  const lines: string[] = [];
  for (const r of reviews) {
    const pr = r.pr ? `[PR #${r.pr.number}](${r.pr.url})` : "no PR";
    const link = r.reviewUrl ? ` ([review](${r.reviewUrl}))` : "";
    const what =
      r.decision === "approve"
        ? "approved"
        : r.decision === "request_changes"
          ? "changes requested"
          : `not judged: ${oneLine(r.error ?? "unknown")}`;
    const comment = r.postedAs === "COMMENT" ? ", posted as a comment review" : "";
    lines.push(`- ${r.part.key} ${pr}: ${what}${link}${comment}`);
    for (const f of r.decision === "request_changes" ? r.failing : []) lines.push(`  - ${f}`);
  }
  return lines;
}

function times(n: number): string {
  return n === 1 ? "once" : n === 2 ? "twice" : `${n} times`;
}

/**
 * Applies a QA round. Approved: QA moves to In Review (MET-14 merges). Otherwise the
 * round counts as a failure for the parent: parts with requested changes go back to
 * Ready with a comment pointing at the review, and QA waits in Ready for them. The
 * `maxFailures`-th failure moves QA and the parent to Needs input with one comment and
 * one ping, and nothing is sent back again (D-014).
 */
export async function settleQa(
  state: Pick<LoopState, "qaFailures" | "qaFeedback">,
  input: { qa: LinkedIssue; parent: Issue },
  result: QaRunResult,
  deps: QaSettleDeps,
): Promise<QaSettlement> {
  const { qa, parent } = input;
  const log = deps.log ?? (() => {});
  const safely = async (what: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (error) {
      log(`could not ${what}: ${message(error)}`);
    }
  };
  const lines = reviewLines(result.reviews);

  if (result.outcome === "approved") {
    delete state.qaFailures[parent.id];
    const body = [
      `**harnessd QA**: approved. Every "Done when" item of ${parent.key} passes and the tests pass.`,
      "",
      ...(lines.length > 0 ? lines : ["- Every part was already Done."]),
    ].join("\n");
    await safely(`comment on ${qa.key}`, () => deps.linear.comment(qa.id, `${body}\n`));
    await safely(`move ${qa.key} to In Review`, () => deps.linear.moveTo(qa.id, "In Review"));
    return "approved";
  }

  const failures = (state.qaFailures[parent.id] ?? 0) + 1;
  if (failures >= deps.maxFailures) {
    delete state.qaFailures[parent.id];
    for (const r of result.reviews) delete state.qaFeedback[r.part.id];
    const body = [
      `**harnessd QA**: QA failed ${times(failures)} for ${parent.key}, so this needs a human (D-014). ` +
        `${qa.key} and ${parent.key} are in Needs input, and nothing is sent back again.`,
      "",
      "Last round:",
      ...lines,
    ].join("\n");
    await safely(`comment on ${parent.key}`, () => deps.linear.comment(parent.id, `${body}\n`));
    await safely(`move ${qa.key} to Needs input`, () => deps.linear.moveTo(qa.id, "Needs input"));
    await safely(`move ${parent.key} to Needs input`, () =>
      deps.linear.moveTo(parent.id, "Needs input"),
    );
    const failing = result.reviews.filter((r) => r.decision !== "approve");
    const keys = failing.map((r) => r.part.key);
    await safely("send the notice", () =>
      deps.notifier.notify({
        kind: "needs_input",
        issue: { key: parent.key, url: parent.url },
        prs: failing.flatMap((r) => (r.pr ? [{ number: r.pr.number, url: r.pr.url }] : [])),
        reason: `QA failed ${times(failures)}`,
        detail: `${qa.key} could not approve ${keys.join(", ") || "the parts"}`,
      }),
    );
    return "escalated";
  }

  state.qaFailures[parent.id] = failures;
  for (const r of result.reviews) {
    if (r.decision !== "request_changes") continue;
    const feedback: (typeof state.qaFeedback)[string] = { failing: r.failing };
    if (r.pr) feedback.prUrl = r.pr.url;
    if (r.reviewUrl) feedback.reviewUrl = r.reviewUrl;
    state.qaFeedback[r.part.id] = feedback;
    const role = readPartMarker(r.part.description)?.role ?? "part";
    const where = r.pr
      ? `on [PR #${r.pr.number}](${r.pr.url})${r.reviewUrl ? ` ([review](${r.reviewUrl}))` : ""}`
      : "";
    const body = [
      `**harnessd QA**: changes requested ${where} (round ${failures} of ${deps.maxFailures}, D-014). ` +
        `Back to Ready so the ${role} agent fixes the PR.`,
      "",
      ...r.failing.map((f) => `- ${f}`),
    ].join("\n");
    await safely(`comment on ${r.part.key}`, () => deps.linear.comment(r.part.id, `${body}\n`));
    await safely(`re-queue ${r.part.key}`, () => deps.linear.moveTo(r.part.id, "Ready"));
  }
  const sentBack = result.reviews.some((r) => r.decision === "request_changes");
  const body = [
    `**harnessd QA**: round ${failures} of ${deps.maxFailures} did not pass. ` +
      (sentBack
        ? `${qa.key} runs again once every part is back in review.`
        : `QA could not judge every PR, so ${qa.key} runs again.`),
    "",
    ...lines,
  ].join("\n");
  await safely(`comment on ${qa.key}`, () => deps.linear.comment(qa.id, `${body}\n`));
  await safely(`re-queue ${qa.key}`, () => deps.linear.moveTo(qa.id, "Ready"));
  return "sent_back";
}
