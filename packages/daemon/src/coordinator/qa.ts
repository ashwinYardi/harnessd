// QA: every part's PR is checked against that part's own "Done when" items and Verify
// section before merge (SPEC "Autonomy loop" step 5, D-013, D-014, D-049). See docs/LOOP.md
// "QA".
//
// For each part: find its PR (the part key is in the title), check the PR head out in a
// worktree of its own, run the repo's tests in harnessd, then run the QA agent for a
// strict JSON verdict. A part marked `**QA**: tests` instead runs its Verify commands and
// builds the verdict itself, with no app, browser or agent (MET-200, D-053). When the repo
// declares a product in `[qa]`, harnessd starts it first and, for a web app, a headless
// browser, then stops their trees afterwards (MET-178, MET-179, D-051). harnessd approves
// only when every item passes and the tests pass, whatever the model says; anything else
// requests changes.
// `settleQa` then moves the sub-issues, and the second failed round goes to the human instead
// of looping.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  emptyTokenUsage,
  type HarnessAdapter,
  type Issue,
  isLiveQa,
  type LinkedIssue,
  type QaConfig,
  type QaKind,
  type ResolvedAgentConfig,
  type Task,
  type TokenUsage,
} from "@harnessd/shared";
import { killProcessTree } from "../adapters/process.ts";
import type {
  GitHub,
  PullRequest,
  PullRequestCheck,
  PullRequestFile,
  ReviewEvent,
} from "../github/client.ts";
import type { LinearClient } from "../linear/client.ts";
import type { TaskWorktrees } from "../worktrees/index.ts";
import { agentPromptHeader } from "./dispatch.ts";
import { extractJson, runForReply } from "./grill.ts";
import type { Notifier } from "./notifier.ts";
import type { PartQa } from "./plan.ts";
import { type AgentMemory, memorySection } from "./prompt.ts";
import { type QaApp, type QaAppInput, type QaAppStart, startQaApp } from "./qa-app.ts";
import { extractSection, readPartMarker, sectionChecklist, sectionList } from "./split.ts";
import type { LoopState } from "./state.ts";

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Flattens evidence to one line. Whitespace outside `backticks` collapses to one space, and
 * a newline or tab inside them becomes a space; ordinary spaces inside them are kept, so a
 * Verify command with two spaces in a quoted string survives (MET-200).
 */
function evidenceLine(text: string): string {
  return text
    .split("`")
    .map((part, i) => (i % 2 === 0 ? part.replace(/\s+/g, " ") : part.replace(/[\r\n\t]+/g, " ")))
    .join("`")
    .trim();
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
 * `signal` (a pause) stops the command. `env` replaces the daemon's environment; the QA app's
 * commands get only its own small one (MET-178).
 */
export type CommandRunner = (
  command: string,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
  env?: NodeJS.ProcessEnv,
) => Promise<CommandResult>;

export const MAX_COMMAND_OUTPUT = 64 * 1024;

/** The failing test tail the review comment and the resume prompt share (MET-156). */
export const MAX_TEST_TAIL = 3000;

/**
 * The folder holding the `qa-browser` bin: a PATH entry that already has it, the nearest
 * `node_modules/.bin`, then the built folder beside this module (MET-179). Only a QA run
 * gets this folder first on its PATH.
 */
export function qaBrowserBinDir(
  env: NodeJS.ProcessEnv = process.env,
  moduleUrl: string = import.meta.url,
): string {
  const has = (dir: string) =>
    existsSync(join(dir, "qa-browser")) || existsSync(join(dir, "qa-browser.cmd"));
  const dirs: string[] = [];
  const moduleDir = dirname(fileURLToPath(moduleUrl));
  for (let dir = moduleDir; ; dir = dirname(dir)) {
    dirs.push(join(dir, "node_modules", ".bin"));
    if (dirname(dir) === dir) break;
  }
  // pnpm links a dependency's bin beside the CLI entry, not only in an ancestor folder.
  const entry = process.argv[1];
  if (entry !== undefined) dirs.push(join(dirname(entry), "..", "node_modules", ".bin"));
  for (const dir of (env.PATH ?? "").split(delimiter)) if (dir !== "") dirs.push(dir);
  for (const dir of dirs) if (has(dir)) return dir;
  // Not installed yet: the folder the build writes qa-browser.js to.
  return fileURLToPath(new URL("../qa-browser", moduleUrl));
}

/** The extra environment only a QA run gets: qa-browser first on PATH, and its run id. */
export function qaBrowserEnvironment(
  runId: string,
  browser: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const bin = qaBrowserBinDir(env);
  return {
    HARNESSD_QA_RUN: runId,
    PATH: [bin, env.PATH ?? ""].filter((part) => part !== "").join(delimiter),
    ...(browser === undefined ? {} : { HARNESSD_QA_BROWSER: browser }),
  };
}

/**
 * `sh -c <command>` in its own process group with CI=1; the group is killed on timeout or
 * abort. With `env`, the child gets exactly that environment, not the daemon's (MET-178).
 */
export const runShellCommand: CommandRunner = (command, cwd, timeoutMs, signal, env) =>
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
    function terminate() {
      // The test command may start a run of its own in another process group (D-048).
      if (pid !== undefined) void killProcessTree(pid, 5_000);
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
        env: env === undefined ? { ...process.env, CI: "1" } : env,
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

/** One Verify command of a `QA: tests` part and its result. */
export interface VerifyRun {
  check: VerifyCheck;
  result: CommandResult;
}

function commandPassed(result: CommandResult): boolean {
  return result.exitCode === 0 && !result.timedOut && result.error === undefined;
}

/**
 * Runs a `QA: tests` part's Verify commands in order, stopping at the first failure or when
 * the round's budget runs out. No QA agent runs and no app starts (D-053).
 */
export async function runVerifyChecks(
  checks: readonly VerifyCheck[],
  cwd: string,
  timeoutMs: number,
  run: CommandRunner = runShellCommand,
  now: () => number = Date.now,
  signal?: AbortSignal,
): Promise<VerifyRun[]> {
  const deadline = now() + timeoutMs;
  const out: VerifyRun[] = [];
  for (const check of checks) {
    if (signal?.aborted) break;
    const result = await run(check.run, cwd, Math.max(deadline - now(), 1), signal);
    out.push({ check, result });
    if (!commandPassed(result) || signal?.aborted) break;
  }
  return out;
}

function verifyEvidence(result: CommandResult): string {
  if (result.error !== undefined) return `could not run (${oneLine(result.error)})`;
  if (result.timedOut) return "timed out";
  return `exited with code ${result.exitCode ?? "null (killed)"}`;
}

/**
 * One Verify command's evidence: the command and its exit code, plus what its output should
 * show when it passed. A failing command keeps the exact `Verify: <cmd> exited with code <n>`
 * send-back line, so its expected text is left out (D-046, D-053).
 */
function verifyRunEvidence(entry: VerifyRun): string {
  const line = `\`${entry.check.run}\` ${verifyEvidence(entry.result)}`;
  if (!commandPassed(entry.result) || entry.check.expect === "") return line;
  return `${line} (expected: ${entry.check.expect})`;
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

export type ParsedQaVerdict =
  | { ok: true; verdict: QaVerdict }
  | {
      ok: false;
      error: string;
      /** Set when the reply was not valid JSON, even after the backslash repair (D-052). */
      kind?: "not_json";
    };

/** The characters JSON allows right after a backslash inside a string. */
const JSON_ESCAPES = '"\\/bfnrtu';

/**
 * Repairs a stray backslash inside a JSON string (MET-196, D-052): a backslash before a
 * character JSON does not allow after it becomes `\\` plus that character. A valid pair,
 * such as `\\` or `\"`, is kept as it is, and `\u` is left for JSON.parse to judge.
 */
export function repairJsonBackslashes(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string;
    if (!inString) {
      if (ch === '"') inString = true;
      out += ch;
      continue;
    }
    if (ch === '"') {
      inString = false;
      out += ch;
      continue;
    }
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = text[i + 1];
    if (next !== undefined && JSON_ESCAPES.includes(next)) {
      out += ch + next;
      i += 1;
      continue;
    }
    out += "\\\\";
    if (next !== undefined) {
      out += next;
      i += 1;
    }
  }
  return out;
}

/** Every line-start "{" candidate that runs to the last "}", newest first. */
function trailingJsonObjects(text: string): string[] {
  const end = text.lastIndexOf("}");
  if (end === -1) return [];
  const candidates: string[] = [];
  let start = text.lastIndexOf("\n{", end);
  while (start > 0) {
    candidates.push(text.slice(start + 1, end + 1));
    start = text.lastIndexOf("\n{", start - 1);
  }
  return candidates;
}

/**
 * Parses the reply's JSON, repairing stray backslashes only after the first parse fails
 * (MET-196). The repair runs on the extracted text and on each trailing-object candidate,
 * so a verdict in prose is still found.
 */
function parseQaJson(text: string): { value: unknown } | { error: Error } {
  const extracted = extractJson(text);
  let first: Error | undefined;
  try {
    return { value: JSON.parse(extracted) };
  } catch (error) {
    first = error as Error;
  }
  for (const candidate of [extracted, ...trailingJsonObjects(text.trim())]) {
    try {
      return { value: JSON.parse(repairJsonBackslashes(candidate)) };
    } catch {
      // Try the next candidate; the first error stays for the message.
    }
  }
  return { error: first as Error };
}

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
 * non-empty `text` and `evidence`, and exactly one item per checked item, the last of
 * which is `Verify` (MET-162).
 */
export function parseQaVerdict(text: string, expectedItems: number): ParsedQaVerdict {
  const parsed = parseQaJson(text);
  if ("error" in parsed) {
    return { ok: false, error: `not JSON: ${parsed.error.message}`, kind: "not_json" };
  }
  const value = parsed.value;
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
      error: `items: expected ${expectedItems}, one per item plus "Verify", got ${value.items.length}`,
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

/** The part's own "Done when" items; empty for a body from before MET-162. */
export function partItems(part: LinkedIssue): string[] {
  return sectionChecklist(extractSection(part.description, "Done when")).map(oneLine);
}

/**
 * The lines of the part's own Verify section, trimmed at the ends only: a command keeps the
 * spaces inside its quotes, so the daemon runs it exactly as written (MET-200).
 */
export function partVerify(part: LinkedIssue): string[] {
  return sectionList(extractSection(part.description, "Verify")).map((line) => line.trim());
}

/** How QA judges the part: from its Verify commands, or with the QA agent (D-053). */
export function partQaMode(part: LinkedIssue): PartQa {
  const match = /^\s*\*\*QA\*\*\s*:\s*(tests|agent)\s*$/im.exec(part.description);
  return match?.[1]?.toLowerCase() === "tests" ? "tests" : "agent";
}

/** One Verify line split into its command and what its output must show. */
export interface VerifyCheck {
  run: string;
  expect: string;
}

/**
 * The part's Verify commands, in order, taken from the backticked text before the arrow. A
 * line without that form is skipped: the part has no runnable command there (D-053).
 */
export function partVerifyChecks(part: LinkedIssue): VerifyCheck[] {
  const out: VerifyCheck[] = [];
  for (const line of partVerify(part)) {
    const match = /^`([^`]+)`\s*(?:→|->)\s*(.*)$/.exec(line);
    if (match?.[1] === undefined || match[1].trim() === "") continue;
    out.push({ run: match[1].trim(), expect: (match[2] ?? "").trim() });
  }
  return out;
}

/** True when every Verify line named a backticked command for the daemon to run. */
function partVerifyComplete(part: LinkedIssue): boolean {
  const lines = partVerify(part);
  return lines.length > 0 && partVerifyChecks(part).length === lines.length;
}

/**
 * What QA checks for one part (MET-162): the part's own "Done when" items, plus one last
 * item "Verify". A body without those sections falls back to the parent's checklist.
 */
export function qaChecklist(parent: Issue, part?: LinkedIssue): string[] {
  if (part !== undefined && partHasItems(part)) {
    return [...partItems(part), "Verify"];
  }
  return parentChecklist(parent);
}

/** True when the part body has both its Done-when items and its Verify section. */
function partHasItems(part: LinkedIssue): boolean {
  return partItems(part).length > 0 && partVerify(part).length > 0;
}

/** The parent's "Done when" items; an issue without any is checked "as written". */
function parentChecklist(parent: Issue): string[] {
  if (parent.doneWhen.length === 0) return [`Matches ${parent.key} as written`];
  return parent.doneWhen.map((d) => oneLine(d.text));
}

/** Files listed after the cut diff; at most this many (D-040). */
const MAX_PROMPT_FILES = 200;

/** The diff is cut here; the file list follows the cut (D-040). */
export const MAX_PROMPT_DIFF = 24_000;

export interface QaPromptInput {
  agent: ResolvedAgentConfig;
  qa: LinkedIssue;
  parent: Issue;
  part: LinkedIssue;
  pr: PullRequest;
  /** The PR's unified diff, when `gh pr diff` answered. */
  diff?: string;
  /** The PR head's CI checks, when `gh pr view` answered. */
  ci?: PullRequestCheck[];
  /** Undefined when `gh` could not list them. */
  files: PullRequestFile[] | undefined;
  checklist: string[];
  /** The part's Verify commands, each with what it must show (MET-162). */
  verify?: string[];
  tests: TestRun;
  /** The vaults, when the loop synced the harness files into the checkout (MET-55). */
  memory?: AgentMemory;
  /** The running app, when the repo declares one (MET-177, D-051). */
  app?: { kind: QaKind; url?: string; command?: string };
}

/** The diff, cut to `MAX_PROMPT_DIFF`, and how much was left out. */
export function cutDiff(diff: string): { text: string; omitted: number } {
  if (diff.length <= MAX_PROMPT_DIFF) return { text: diff, omitted: 0 };
  return { text: diff.slice(0, MAX_PROMPT_DIFF), omitted: diff.length - MAX_PROMPT_DIFF };
}

function describeCi(checks: PullRequestCheck[] | undefined): string {
  if (checks === undefined) return "(could not read the checks; run `gh pr checks`)";
  if (checks.length === 0) return "(no checks yet)";
  return checks.map((c) => `- ${c.name}: ${c.detail.toLowerCase()}`).join("\n");
}

/** How QA tests an item against each kind of product (MET-180). */
const LIVE_CHECK: Record<QaKind, string> = {
  web: "Use qa-browser: `open` the url at 390x844 and again at 1280x800, click and type as an item needs, and screenshot what you checked.",
  api: "Call the api with curl (or another HTTP client) and quote the status and the body.",
  cli: "Run the product's commands with the inputs an item names and quote their output.",
};

/** The App section: where the product runs and what kind it is (MET-180). */
function appSection(app: NonNullable<QaPromptInput["app"]>): string {
  if (app.url !== undefined) {
    return `## App\nThe product is running at ${app.url} (kind ${app.kind}). Check each item against it.`;
  }
  const command = app.command === undefined ? "`qa.start`" : `\`${app.command}\``;
  return (
    `## App\nThe product is a ${app.kind} (kind ${app.kind}). ` +
    `Run it with ${command}; harnessd starts no server.`
  );
}

/** The QA agent's prompt for one PR. */
export function buildQaPrompt(input: QaPromptInput): string {
  const { agent, qa, parent, part, pr, diff, ci, files, checklist, verify, tests, memory, app } =
    input;
  const out = agentPromptHeader(agent, qa);
  const ownItems = partHasItems(part);
  const doneWhen = ownItems ? `${part.key}: ${part.title}` : `${parent.key}: ${parent.title}`;

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

  const cut = diff === undefined ? undefined : cutDiff(diff);
  const diffSection =
    cut === undefined
      ? "## Diff\n(could not read it; run `gh pr diff` in this worktree.)"
      : `## Diff\n\`\`\`diff\n${cut.text || "(empty)"}\n\`\`\`` +
        (cut.omitted > 0
          ? `\nThe diff was cut after ${MAX_PROMPT_DIFF} characters; ${cut.omitted} were left out. ` +
            `Run \`gh pr diff ${pr.number}\` for the rest.`
          : "");

  out.push(
    `## PR to verify\nPart ${part.key}: ${part.title} (${part.url})\n` +
      `PR #${pr.number}: ${pr.title}\n${pr.url}\n` +
      `Branch \`${pr.headRefName}\` at \`${pr.headRefOid}\`, into \`${pr.baseRefName}\`.`,
    diffSection,
    `## Changed files (${files?.length ?? "?"})\n${fileList}`,
    `## CI\n${describeCi(ci)}`,
    `## Tests\nharnessd ran the repo's tests in this worktree before you started: ${describeTests(tests)}.\n` +
      `\`\`\`text\n${tail(tests.output, MAX_TEST_TAIL) || "(no output)"}\n\`\`\``,
    ...(app === undefined ? [] : [appSection(app)]),
    `## Part brief\n${part.description.trim() || "(none)"}`,
    `## Done when (${doneWhen})\n${checklist.map((c, i) => `${i + 1}. ${c}`).join("\n")}`,
    ...(verify !== undefined && verify.length > 0
      ? [
          `## Verify\nRun each command in the part brief and quote its result as the evidence for the last item:\n${verify.map((v) => `- ${v}`).join("\n")}`,
        ]
      : []),
    [
      "## How to verify",
      ...(app === undefined
        ? [
            "- Read this part's brief, the decision IDs it names in the part body, the part's \"Done when\" and Verify sections, the diff, the CI result and the tests. Do not read docs/SPEC.md or every decision record.",
            "- Judge from this diff, the CI result and the tests. Open a file only to check a line the diff touches.",
            "- This worktree is a detached checkout of the PR head. Do not edit files, commit, push, comment or review: harnessd posts the review from your verdict.",
            "- An item passes only with concrete evidence: a file and line, a test name, or command output.",
            "- The last item, `Verify`, passes only when each Verify command ran and its result is quoted.",
            "- `testsPassed` is false when any test or check you ran fails.",
          ]
        : [
            "- Read this part's brief, the decision IDs it names in the part body, the part's \"Done when\" and Verify sections, the diff, the CI result and the tests. Do not read docs/SPEC.md or every decision record.",
            `- Test each item against the running product. ${LIVE_CHECK[app.kind]} Another method is allowed when an item needs it.`,
            "- Read the diff only to find what to test. Do not judge code style: the tests and CI guard the code, and a separate reviewer judges style.",
            "- Each item's evidence is the command you ran, the response you got, or the screenshot path. An item passes only with that evidence.",
            "- This worktree is a detached checkout of the PR head. Do not edit files, commit, push, comment or review: harnessd posts the review from your verdict.",
            "- The last item, `Verify`, passes only when each Verify command ran and its result is quoted.",
            "- `testsPassed` is false when any test or check you ran fails.",
          ]),
    ].join("\n"),
  );
  if (memory) out.push(memorySection(memory));
  out.push(
    `## Verdict\nYour final message is strict JSON only, no prose and no code fence, with exactly ${checklist.length} ` +
      `item(s), one per item above in the order listed, \`text\` copied from the list:\n${QA_VERDICT_SHAPE}`,
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
  /**
   * True when QA could not set up the review (PR lookup, checkout, worktree sync, budget
   * before the agent). Such a round is re-queued without counting a QA failure (D-041).
   */
  setup?: boolean;
  /**
   * Why the QA agent gave no usable verdict: turn cap, time limit, stall or a reply that is
   * not JSON even after the backslash repair. Such a round counts no QA failure, and two in
   * a row on one PR head go to the human (MET-196, D-052).
   */
  notJudged?: "turn_cap" | "timeout" | "stalled" | "not_json";
  /** One line per failing item: the item and its evidence. */
  failing: string[];
  /** The last lines of the tests when they failed, for the send-back prompt (MET-156). */
  testTail?: string;
  /** The posted review. */
  reviewUrl?: string;
  /** COMMENT when GitHub refused the real review event (e.g. on your own PR). */
  postedAs?: ReviewEvent;
  /**
   * Why this review ran without a live app: the third consecutive app setup error on this
   * head (D-051). It counts no QA failure; a later prompt part shows it.
   */
  appSetup?: string;
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
    const line = `${checklist[i] ?? item.text}: ${evidenceLine(item.evidence)}`;
    (item.pass ? passing : failing).push(line);
  }
  return { decision: failing.length === 0 ? "approve" : "request_changes", failing, passing };
}

/**
 * The verdict for a `QA: tests` part: every item carries the commands with their exit codes,
 * and the last item, `Verify`, also carries each expected result and passes only when a
 * command ran and every command exited 0 (D-053). A failing command leaves only its own line
 * as the `Verify` evidence, so the send-back names the command that failed and not the ones
 * before it (D-046). A repo test failure leaves Verify unrun, so both the test line and
 * Verify fail.
 */
export function verdictFromVerify(
  checklist: string[],
  tests: TestRun,
  runs: readonly VerifyRun[],
): QaVerdict {
  const failed = runs.find((entry) => !commandPassed(entry.result));
  const verifyPass = runs.length > 0 && failed === undefined;
  const evidence =
    runs.length === 0 ? "not run: the repo tests failed" : runs.map(verifyRunEvidence).join("; ");
  const verifyEvidence = failed === undefined ? evidence : verifyRunEvidence(failed);
  return {
    items: checklist.map((text, i) => ({
      text,
      pass: i === checklist.length - 1 ? verifyPass : true,
      evidence: i === checklist.length - 1 ? verifyEvidence : evidence,
    })),
    testsPassed: tests.passed,
  };
}

export interface ReviewBodyInput {
  qa: LinkedIssue;
  parent: Issue;
  decision: Decision;
  tests: TestRun;
  round: number;
  maxRounds: number;
  /** The failing Verify command's output for a `QA: tests` part (D-053). */
  verifyTail?: { command: string; output: string };
  /**
   * Why this verdict was made without the product: live QA is off, or the app failed three
   * times on this head. The body starts with `not run live: <reason>` (MET-180, D-013).
   */
  notLive?: string;
}

/** The PR review body. */
export function formatReviewBody(input: ReviewBodyInput): string {
  const { qa, parent, decision, tests, round, maxRounds, notLive, verifyTail } = input;
  const lines: string[] = [];
  if (notLive !== undefined) lines.push(`not run live: ${notLive}`, "");
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
      tail(tests.output, MAX_TEST_TAIL),
      "```",
    );
  }
  if (verifyTail !== undefined) {
    lines.push(
      "",
      `Last lines of \`${verifyTail.command}\`:`,
      "```text",
      tail(verifyTail.output, MAX_TEST_TAIL),
      "```",
    );
  }
  return `${lines.join("\n")}\n`;
}

// --- a QA round ---------------------------------------------------------------

/** The third app setup error on one head runs the review with no live app (D-051). */
export const MAX_APP_SETUP_FAILURES = 3;

/** In-memory app setup errors per part, with the head they happened on (D-051). */
const appSetupFailures = new Map<string, { head: string; count: number }>();

/**
 * In-memory not-judged runs per part, with the head they happened on and why (D-052).
 * A restart resets it, which costs at most one extra QA run.
 */
const notJudgedRuns = new Map<string, { head: string; count: number; reasons: string[] }>();

/** Forgets every counted app setup error and not-judged run; tests start clean with it. */
export function resetQaAppFailures(): void {
  appSetupFailures.clear();
  notJudgedRuns.clear();
}

/** Counts one app setup error for this part and head; a new head starts at one. */
function countAppSetupFailure(partId: string, head: string): number {
  const previous = appSetupFailures.get(partId);
  const count = previous?.head === head ? previous.count + 1 : 1;
  appSetupFailures.set(partId, { head, count });
  return count;
}

/** The app started on this head, so its earlier setup errors no longer count. */
function clearAppSetupFailures(partId: string): void {
  appSetupFailures.delete(partId);
}

/** Counts one not-judged run for this part and head; a new head starts at one (D-052). */
function countNotJudged(
  partId: string,
  head: string,
  reason: string,
): { head: string; count: number; reasons: string[] } {
  const previous = notJudgedRuns.get(partId);
  const sameHead = previous?.head === head;
  const counted = {
    head,
    count: sameHead ? (previous?.count ?? 0) + 1 : 1,
    reasons: sameHead ? [...(previous?.reasons ?? []), reason] : [reason],
  };
  notJudgedRuns.set(partId, counted);
  return counted;
}

/** A judged verdict (or a new head) drops the earlier not-judged runs for this part. */
function clearNotJudged(partId: string): void {
  notJudgedRuns.delete(partId);
}

/** The reason a not-judged review adds to the log line and the escalation (D-052). */
function notJudgedReason(r: PrReview): string {
  switch (r.notJudged) {
    case "timeout":
      return "timed out";
    case "stalled":
      return "stalled";
    case "turn_cap": {
      const cap = /turn cap \(\d+ turns\)/.exec(r.error ?? "");
      return cap?.[0] ?? "turn cap";
    }
    case "not_json": {
      const error = r.error ?? "unknown";
      const at = error.indexOf("not JSON: ");
      return `verdict not JSON: ${at === -1 ? oneLine(error) : error.slice(at + 10)}`;
    }
    default:
      return oneLine(r.error ?? "unknown");
  }
}

export interface QaRunInput {
  qa: LinkedIssue;
  parent: Issue;
  /** The parts that block the QA sub-issue. Done parts are skipped. */
  parts: LinkedIssue[];
  /** D-014 budget of the whole round: checkouts, tests and agent runs. */
  budgetMs: number;
  /** Turn cap of each QA agent run (D-045). */
  maxTurns?: number;
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
  /** Starts the product for a live review (MET-178); a test injects one. */
  startApp?: (input: QaAppInput) => Promise<QaAppStart>;
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
  /** Tokens the QA agent runs used (D-040). */
  tokens?: TokenUsage;
  /** Model turns the QA agent runs reported (D-043). */
  turns?: number;
  /** True when every QA agent reply had unknown usage, so `tokens` counts nothing (MET-188). */
  usageUnknown?: true;
}

/** Reviews every part's PR. Never throws: a broken step is an `error` review. */
export async function runQa(input: QaRunInput, deps: QaRunDeps): Promise<QaRunResult> {
  const { qa, parent } = input;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const deadline = now() + input.budgetMs;
  const cancelled = () => deps.signal?.aborted === true;
  let limited = false;
  let spent: TokenUsage = emptyTokenUsage();
  let spentTurns: number | undefined;
  /** Replies that did and did not report usage; a sum of only unknown replies is unknown. */
  let knownReplies = 0;
  let unknownReplies = 0;
  const usageUnknown = (): { usageUnknown?: true } =>
    unknownReplies > 0 && knownReplies === 0 ? { usageUnknown: true } : {};
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
    const checklist = qaChecklist(parent, part);
    // A `QA: tests` part needs a backticked command on every Verify line; otherwise it
    // falls back to the QA agent (D-053).
    const qaMode = partQaMode(part);
    const verifyChecks = partVerifyChecks(part);
    const testsMode = qaMode === "tests" && partVerifyComplete(part);
    if (testsMode) {
      log(`${qa.key}: QA from Verify commands on ${part.key}, ${verifyChecks.length} commands`);
    } else if (qaMode === "tests") {
      log(`${qa.key}: ${part.key} has a Verify line with no backticked command, using agent QA`);
    }
    let pr: PullRequest | undefined;
    try {
      pr = await deps.github.findPrForIssue(part.key);
    } catch (error) {
      return {
        part,
        decision: "error",
        failing: [],
        setup: true,
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
        setup: true,
        error: `could not check out PR #${pr.number}: ${message(error)}`,
      };
    }
    deps.onWorktree?.(path);
    if (cancelled()) return stopped(part, pr);

    let tests: TestRun;
    let verdict: ParsedQaVerdict;
    // Why the agent gave no usable verdict; such a review counts no QA failure (D-052).
    let notJudged: PrReview["notJudged"];
    // A throw while this is true is a setup error: it counts no QA failure (D-041).
    let inSetup = true;
    let setupError = false;
    // The live app for this review, stopped in the teardown whatever path leaves the round.
    let app: QaApp | undefined;
    // Why this review runs without an app: the third setup error on this head (D-051).
    let appSetup: string | undefined;
    // What the review body puts after `not run live:`: no kind, or the app step (MET-180).
    let liveOff: string | undefined;
    // The tail of the failing Verify command, for the review body and the send-back (D-053).
    let verifyTail: { command: string; output: string } | undefined;
    try {
      const files = await deps.github.prFiles(pr.number).catch((error) => {
        log(`${qa.key}: could not list the files of PR #${pr.number}: ${message(error)}`);
        return undefined;
      });
      const diff = await deps.github.prDiff(pr.number).catch((error) => {
        log(`${qa.key}: could not read the diff of PR #${pr.number}: ${message(error)}`);
        return undefined;
      });
      const status = await deps.github.prStatus(pr.number).catch((error) => {
        log(`${qa.key}: could not read the checks of PR #${pr.number}: ${message(error)}`);
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
      if (cancelled()) {
        verdict = { ok: false, error: "cancelled by harnessd pause" };
      } else if (testsMode) {
        // No app and no agent: the part's Verify commands are the whole verdict (D-053).
        const runs = tests.passed
          ? await runVerifyChecks(
              verifyChecks,
              path,
              Math.max(deadline - now(), 1),
              deps.runCommand ?? runShellCommand,
              now,
              deps.signal,
            )
          : [];
        if (cancelled()) return stopped(part, pr);
        const failedRun = runs.find((entry) => !commandPassed(entry.result));
        if (failedRun !== undefined) {
          verifyTail = { command: failedRun.check.run, output: failedRun.result.output };
        }
        verdict = { ok: true, verdict: verdictFromVerify(checklist, tests, runs) };
      } else {
        // The app starts only once the tests pass: a build broken by the PR is a test result,
        // not a setup error (D-051).
        if (tests.passed && isLiveQa(deps.commands)) {
          const role = readPartMarker(part.description)?.role;
          const area = role === "frontend" ? "frontend" : "backend";
          const started = await (deps.startApp ?? startQaApp)({
            qa: deps.commands,
            cwd: path,
            area,
            budgetMs: Math.max(deadline - now(), 1),
            ...(deps.runCommand === undefined ? {} : { run: deps.runCommand }),
            ...(deps.signal === undefined ? {} : { signal: deps.signal }),
            log: (line) => log(`${qa.key}: ${line}`),
          });
          // Keep the app the moment it exists: a pause that lands right after the health
          // probe must still stop it in the teardown (D-051).
          if (started.ok) app = started.app;
          if (cancelled()) return stopped(part, pr);
          if (!started.ok) {
            const reason = `app ${started.step} failed: ${started.detail}`;
            const failures = countAppSetupFailure(part.id, pr.headRefOid);
            if (failures < MAX_APP_SETUP_FAILURES) {
              // D-041, D-051: no QA failure, no review; settleQa logs and re-queues.
              return { part, pr, decision: "error", failing: [], setup: true, error: reason };
            }
            // The same head failed three times: review it with no live app, keeping the reason.
            appSetup = reason;
            liveOff = `app ${started.step} failed`;
            log(`${qa.key}: ${reason} on this head ${failures} times, running without it`);
          } else {
            clearAppSetupFailures(part.id);
          }
        }
        const left = deadline - now();
        if (left <= 0) {
          setupError = true;
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
          // Only a QA run gets qa-browser: the bin first on PATH, and a live web review's
          // CDP endpoint. Builder and coordinator runs never go through this path (MET-179).
          env = { ...(env ?? {}), ...qaBrowserEnvironment(id, app?.browser) };
          const task: Task = {
            id,
            title: `QA ${part.key}: PR #${pr.number}`,
            prompt: buildQaPrompt({
              agent: deps.agent,
              qa,
              parent,
              part,
              pr,
              ...(diff === undefined ? {} : { diff }),
              ...(status === undefined ? {} : { ci: status.checks }),
              files,
              checklist,
              verify: partVerify(part),
              tests,
              ...(app === undefined
                ? {}
                : {
                    app: {
                      kind: app.kind ?? deps.commands.kind ?? "web",
                      ...(app.url === undefined ? {} : { url: app.url }),
                      ...(deps.commands.start === undefined
                        ? {}
                        : { command: deps.commands.start }),
                    },
                  }),
              ...(deps.memory ? { memory: deps.memory } : {}),
            }),
            budgetMs: left,
          };
          if (input.maxTurns !== undefined) task.maxTurns = input.maxTurns;
          if (deps.agent.model !== undefined) task.model = deps.agent.model;
          if (env !== undefined) task.env = env;
          inSetup = false;
          const reply = await runForReply(deps.adapter, task, path);
          if (reply.usageUnknown === true) unknownReplies += 1;
          else {
            knownReplies += 1;
            spent = {
              input: spent.input + reply.tokens.input,
              output: spent.output + reply.tokens.output,
              cacheRead: spent.cacheRead + reply.tokens.cacheRead,
              cacheWrite: spent.cacheWrite + reply.tokens.cacheWrite,
            };
          }
          if (reply.turns !== undefined) spentTurns = (spentTurns ?? 0) + reply.turns;
          if (!reply.ok && reply.limited) limited = true;
          if (!reply.ok) {
            notJudged =
              reply.timeout === true
                ? "timeout"
                : reply.reason === "stalled"
                  ? "stalled"
                  : reply.reason === "turn_cap"
                    ? "turn_cap"
                    : undefined;
          }
          verdict = reply.ok ? parseQaVerdict(reply.text, checklist.length) : reply;
          if (!verdict.ok && verdict.kind === "not_json") notJudged = "not_json";
        }
      }
    } catch (error) {
      if (cancelled()) return stopped(part, pr);
      return {
        part,
        pr,
        decision: "error",
        failing: [],
        ...(inSetup ? { setup: true } : {}),
        error: message(error),
      };
    } finally {
      // The app stops in every teardown: approve, request_changes, error, limited, setup
      // error, timeout and pause (D-051, D-048).
      if (app !== undefined) {
        await app.stop().catch((error) => {
          log(`${qa.key}: could not stop the app: ${message(error)}`);
        });
        app = undefined;
      }
      // A pause keeps the worktree in use for inspection (MET-15); the loop records it.
      if (!cancelled()) {
        // A QA PR-head checkout is never kept, even when it has local changes (D-041).
        await deps.worktrees.remove(path, { force: true }).catch((error) => {
          log(`${qa.key}: could not remove ${path}: ${message(error)}`);
        });
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
      return {
        part,
        pr,
        decision: "error",
        failing: [],
        ...(setupError ? { setup: true } : {}),
        ...(notJudged === undefined ? {} : { notJudged }),
        ...(appSetup === undefined ? {} : { appSetup }),
        error: decision.error ?? "unknown",
      };
    }
    const notLive = testsMode
      ? "QA from Verify commands"
      : isLiveQa(deps.commands)
        ? liveOff
        : "no [qa] kind in .harnessd/config.toml";
    const body = formatReviewBody({
      qa,
      parent,
      decision,
      tests,
      round: input.round,
      maxRounds: input.maxRounds,
      ...(notLive === undefined ? {} : { notLive }),
      ...(verifyTail === undefined ? {} : { verifyTail }),
    });
    const event: ReviewEvent = decision.decision === "approve" ? "APPROVE" : "REQUEST_CHANGES";
    const result: PrReview = {
      part,
      pr,
      decision: decision.decision,
      failing: decision.failing,
      // MET-156: the send-back prompt shows only the tail of a failing test run.
      ...(tests.passed ? {} : { testTail: tail(tests.output, MAX_TEST_TAIL) }),
      ...(verifyTail === undefined ? {} : { testTail: tail(verifyTail.output, MAX_TEST_TAIL) }),
      ...(appSetup === undefined ? {} : { appSetup }),
    };
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
  if (cancelled())
    return {
      outcome: "error",
      reviews,
      cancelled: true,
      tokens: spent,
      ...usageUnknown(),
      ...(spentTurns === undefined ? {} : { turns: spentTurns }),
    };
  if (limited)
    return {
      outcome: "error",
      reviews,
      limited: true,
      tokens: spent,
      ...usageUnknown(),
      ...(spentTurns === undefined ? {} : { turns: spentTurns }),
    };
  const outcome = reviews.some((r) => r.decision === "request_changes")
    ? "changes_requested"
    : reviews.some((r) => r.decision === "error")
      ? "error"
      : "approved";
  return {
    outcome,
    reviews,
    tokens: spent,
    ...usageUnknown(),
    ...(spentTurns === undefined ? {} : { turns: spentTurns }),
  };
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

export type QaSettlement = "approved" | "sent_back" | "escalated" | "requeued";

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
 * Applies a QA round. Approved: QA moves to In Review (MET-14 merges). A round where no
 * part was judged and every failed review is a setup error, or gave no usable verdict
 * (turn cap, time limit, stall or invalid JSON), is re-queued with no failure counted
 * (D-041, D-052). Two not-judged runs in a row on one PR head go to the human instead,
 * with the reason and no QA failure (D-052). Otherwise the round counts as a failure for
 * the parent: parts with requested changes go back to Ready with a comment pointing at
 * the review, and QA waits in Ready for them. The `maxFailures`-th failure moves QA and
 * the parent to Needs input with one comment and one ping, and nothing is sent back again
 * (D-014).
 */
export async function settleQa(
  state: Pick<LoopState, "qaFailures" | "qaFeedback" | "sessions">,
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
    for (const r of result.reviews) clearNotJudged(r.part.id);
    const body = [
      `**harnessd QA**: approved. Every "Done when" item of ${parent.key} passes and the tests pass.`,
      "",
      ...(lines.length > 0 ? lines : ["- Every part was already Done."]),
    ].join("\n");
    await safely(`comment on ${qa.key}`, () => deps.linear.comment(qa.id, `${body}\n`));
    // Per-part QA: the QA sub-issue stays Ready for the next part, and moves to Done after
    // the last part merges (D-040).
    await safely(`move ${qa.key} to Ready`, () => deps.linear.moveTo(qa.id, "Ready"));
    return "approved";
  }

  const failures = (state.qaFailures[parent.id] ?? 0) + 1;
  // A judged verdict clears the not-judged count; a setup error leaves it as it is (D-052).
  for (const r of result.reviews) {
    if (r.decision === "approve" || r.decision === "request_changes") clearNotJudged(r.part.id);
  }
  // Count every not-judged run, even when another part in the round asks for changes, so
  // that a second timeout on one head still reaches a human (D-052).
  const countedParts: string[] = [];
  let twice:
    | {
        part: LinkedIssue;
        pr?: PullRequest;
        counted: { head: string; count: number; reasons: string[] };
      }
    | undefined;
  for (const r of result.reviews) {
    if (r.notJudged === undefined) continue;
    const counted = countNotJudged(r.part.id, r.pr?.headRefOid ?? "", notJudgedReason(r));
    countedParts.push(r.part.id);
    if (counted.count >= 2) {
      twice = { part: r.part, ...(r.pr === undefined ? {} : { pr: r.pr }), counted };
    }
  }
  if (twice !== undefined) {
    // Two runs in a row gave no verdict: a human decides, and no QA failure is counted.
    const head = twice.counted.head.slice(0, 7);
    const where =
      twice.pr === undefined
        ? "no PR"
        : `PR #${twice.pr.number}${head === "" ? "" : ` at ${head}`}`;
    const detail =
      `QA was not judged twice on ${twice.part.key} ${where}: ` +
      `${twice.counted.reasons.join("; ")}. No QA failure counted.`;
    await safely(`comment on ${parent.key}`, () =>
      deps.linear.comment(parent.id, `**harnessd QA**: ${detail}\n`),
    );
    await safely(`move ${qa.key} to Needs input`, () => deps.linear.moveTo(qa.id, "Needs input"));
    await safely(`move ${parent.key} to Needs input`, () =>
      deps.linear.moveTo(parent.id, "Needs input"),
    );
    await safely("send the notice", () =>
      deps.notifier.notify({
        kind: "needs_input",
        issue: { key: parent.key, url: parent.url },
        prs: twice.pr === undefined ? [] : [{ number: twice.pr.number, url: twice.pr.url }],
        reason: "QA not judged twice",
        detail,
      }),
    );
    for (const partId of countedParts) clearNotJudged(partId);
    return "escalated";
  }
  const notApproved = result.reviews.filter((r) => r.decision !== "approve");
  const noVerdictOnly =
    notApproved.length > 0 &&
    notApproved.every((r) => r.setup === true || r.notJudged !== undefined) &&
    !result.reviews.some((r) => r.decision === "request_changes");
  if (noVerdictOnly) {
    const reasons = notApproved.map((r) =>
      r.notJudged === undefined ? oneLine(r.error ?? "unknown") : notJudgedReason(r),
    );
    log(`${qa.key}: QA not judged (${reasons.join("; ")}), re-queued`);
    await safely(`re-queue ${qa.key}`, () => deps.linear.moveTo(qa.id, "Ready"));
    return "requeued";
  }

  if (failures >= deps.maxFailures) {
    delete state.qaFailures[parent.id];
    for (const r of result.reviews) {
      delete state.qaFeedback[r.part.id];
      if (state.sessions !== undefined) delete state.sessions[r.part.id];
      clearNotJudged(r.part.id);
    }
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
    if (r.testTail !== undefined) feedback.testTail = r.testTail;
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
