// GitHub through the `gh` CLI only (D-002): no SDK and no REST client in-process.
// Auth is whatever `gh` uses (GH_TOKEN, GITHUB_TOKEN or `gh auth login`); harnessd never
// reads or stores a token. See docs/LOOP.md.
import { spawn } from "node:child_process";
import type { MergeMethod } from "@harnessd/shared";

/** An open pull request, as `gh pr list --json` reports it. */
export interface PullRequest {
  number: number;
  title: string;
  url: string;
  /** The PR's branch. */
  headRefName: string;
  /** The commit at the head of the PR's branch. */
  headRefOid: string;
  baseRefName: string;
  isDraft: boolean;
}

export interface PullRequestFile {
  path: string;
  additions: number;
  deletions: number;
}

export type ReviewEvent = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";

export interface ReviewInput {
  event: ReviewEvent;
  /** Markdown. */
  body: string;
  /** The commit the review is about, so a later push is not approved by accident. */
  commitId?: string;
}

/** One CI check on a PR's head: a check run or a commit status. */
export interface PullRequestCheck {
  name: string;
  state: "pass" | "pending" | "fail";
  /** GitHub's word for it: SUCCESS, IN_PROGRESS, FAILURE, … */
  detail: string;
  url?: string;
}

/** What the merge gate reads about a PR, from one `gh pr view --json` call. */
export interface PullRequestStatus {
  number: number;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  headRefOid: string;
  /** MERGEABLE, CONFLICTING or UNKNOWN (GitHub is still computing it). */
  mergeable: string;
  /** The head commit's checks, one per name (the latest run wins). */
  checks: PullRequestCheck[];
  files: PullRequestFile[];
  /** How many files the PR changes; `files` may list fewer on a very large PR. */
  changedFiles: number;
}

export interface MergeInput {
  method: MergeMethod;
  /** GitHub refuses the merge if the head moved past this commit. */
  matchHeadCommit: string;
}

/** The GitHub calls harnessd makes. `createGhCli` implements it; tests use a fake. */
export interface GitHub {
  /** The newest open PR whose title carries the issue key ("MET-41"), if any. */
  findPrForIssue(issueKey: string): Promise<PullRequest | undefined>;
  /** Files the PR changes, for the QA prompt's diff summary. */
  prFiles(number: number): Promise<PullRequestFile[]>;
  /** Posts one review and returns its URL. */
  postReview(number: number, review: ReviewInput): Promise<string>;
  /** State, head, mergeability, CI checks and changed files, for the merge gate. */
  prStatus(number: number): Promise<PullRequestStatus>;
  /** Merges the PR at exactly `matchHeadCommit`. */
  mergePr(number: number, input: MergeInput): Promise<void>;
  /** Adds a label to the PR, creating the label in the repo when it does not exist yet. */
  addLabel(number: number, label: string): Promise<void>;
}

export class GitHubError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "GitHubError";
  }
}

export interface GhCliOptions {
  /** A checkout of the repo; `gh` infers owner and name from its remote. */
  cwd: string;
  /** The `gh` binary. Default $HARNESSD_GH_BIN, then `gh` on PATH. */
  bin?: string;
  /** Environment for `gh`. Default process.env (where GH_TOKEN, if any, lives). */
  env?: NodeJS.ProcessEnv;
  /** Per-call timeout. Default 60 s. */
  timeoutMs?: number;
}

const PR_FIELDS = "number,title,url,headRefName,headRefOid,baseRefName,isDraft";

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new GitHubError(`gh ${what}: output is not JSON: ${(error as Error).message}`);
  }
}

function field<T>(raw: Obj, key: string, type: "string" | "number" | "boolean", what: string): T {
  const value = raw[key];
  if (typeof value !== type) throw new GitHubError(`gh ${what}: ${key}: expected a ${type}`);
  return value as T;
}

/** Parses `gh pr list --json <PR_FIELDS>`. */
export function parsePullRequests(text: string): PullRequest[] {
  const value = parseJson(text, "pr list");
  if (!Array.isArray(value)) throw new GitHubError("gh pr list: expected a JSON array");
  return value.map((raw, i) => {
    const what = `pr list[${i}]`;
    if (!isObj(raw)) throw new GitHubError(`gh ${what}: expected an object`);
    return {
      number: field<number>(raw, "number", "number", what),
      title: field<string>(raw, "title", "string", what),
      url: field<string>(raw, "url", "string", what),
      headRefName: field<string>(raw, "headRefName", "string", what),
      headRefOid: field<string>(raw, "headRefOid", "string", what),
      baseRefName: field<string>(raw, "baseRefName", "string", what),
      isDraft: raw.isDraft === true,
    };
  });
}

/** Parses `gh pr view <n> --json files`. */
export function parsePullRequestFiles(text: string): PullRequestFile[] {
  const value = parseJson(text, "pr view");
  if (!isObj(value) || !Array.isArray(value.files)) {
    throw new GitHubError("gh pr view: expected an object with a files array");
  }
  return value.files.map((raw, i) => {
    const what = `pr view files[${i}]`;
    if (!isObj(raw)) throw new GitHubError(`gh ${what}: expected an object`);
    return {
      path: field<string>(raw, "path", "string", what),
      additions: field<number>(raw, "additions", "number", what),
      deletions: field<number>(raw, "deletions", "number", what),
    };
  });
}

export const PR_STATUS_FIELDS =
  "number,url,state,headRefOid,mergeable,statusCheckRollup,files,changedFiles";

/** Check-run conclusions that count as passing; any other conclusion fails. */
const PASSING_CONCLUSIONS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

function str(raw: Obj, key: string): string {
  const value = raw[key];
  return typeof value === "string" ? value : "";
}

/**
 * One `statusCheckRollup` entry. A check run passes when it completed with SUCCESS,
 * NEUTRAL or SKIPPED, and is pending until it completes. A commit status passes on
 * SUCCESS and is pending on PENDING or EXPECTED. Anything else fails, except an entry of
 * an unknown kind, which stays pending: it is not green, but nobody's fault either.
 */
function parseCheck(raw: Obj): PullRequestCheck & { key: string; at: string } {
  // A re-run starts after the run it replaces; an unfinished run has no real completedAt.
  const at = str(raw, "startedAt") || str(raw, "completedAt");
  if (raw.__typename === "StatusContext" || ("context" in raw && !("status" in raw))) {
    const detail = str(raw, "state") || "UNKNOWN";
    const name = str(raw, "context") || "status";
    const state =
      detail === "SUCCESS"
        ? "pass"
        : detail === "PENDING" || detail === "EXPECTED"
          ? "pending"
          : "fail";
    const check: PullRequestCheck & { key: string; at: string } = {
      name,
      state,
      detail,
      key: `status:${name}`,
      at,
    };
    if (str(raw, "targetUrl")) check.url = str(raw, "targetUrl");
    return check;
  }
  if (raw.__typename === "CheckRun" || "status" in raw) {
    const status = str(raw, "status") || "UNKNOWN";
    const conclusion = str(raw, "conclusion");
    const workflow = str(raw, "workflowName");
    const base = str(raw, "name") || "check";
    const name = workflow ? `${workflow} / ${base}` : base;
    const done = status === "COMPLETED";
    const state = !done ? "pending" : PASSING_CONCLUSIONS.has(conclusion) ? "pass" : "fail";
    const check: PullRequestCheck & { key: string; at: string } = {
      name,
      state,
      detail: done ? conclusion || "UNKNOWN" : status,
      key: `run:${name}`,
      at,
    };
    if (str(raw, "detailsUrl")) check.url = str(raw, "detailsUrl");
    return check;
  }
  return { name: "unknown check", state: "pending", detail: "UNKNOWN", key: "unknown", at };
}

/** Parses `gh pr view <n> --json <PR_STATUS_FIELDS>`. */
export function parsePullRequestStatus(text: string): PullRequestStatus {
  const value = parseJson(text, "pr view");
  const what = "pr view";
  if (!isObj(value)) throw new GitHubError(`gh ${what}: expected an object`);
  const state = field<string>(value, "state", "string", what);
  if (state !== "OPEN" && state !== "CLOSED" && state !== "MERGED") {
    throw new GitHubError(`gh ${what}: state: unexpected ${JSON.stringify(state)}`);
  }
  const rollup = value.statusCheckRollup ?? [];
  if (!Array.isArray(rollup))
    throw new GitHubError(`gh ${what}: statusCheckRollup: expected an array`);
  // A re-run leaves the earlier run in the rollup too: the latest one per name decides.
  const latest = new Map<string, PullRequestCheck & { key: string; at: string }>();
  for (const raw of rollup) {
    if (!isObj(raw)) continue;
    const check = parseCheck(raw);
    const seen = latest.get(check.key);
    if (seen === undefined || check.at >= seen.at) latest.set(check.key, check);
  }
  const checks = [...latest.values()].map(({ key: _key, at: _at, ...check }) => check);
  const files = parsePullRequestFiles(JSON.stringify({ files: value.files ?? [] }));
  const changed = value.changedFiles;
  return {
    number: field<number>(value, "number", "number", what),
    url: field<string>(value, "url", "string", what),
    state,
    headRefOid: field<string>(value, "headRefOid", "string", what),
    mergeable: typeof value.mergeable === "string" ? value.mergeable : "UNKNOWN",
    checks,
    files,
    changedFiles: typeof changed === "number" ? changed : files.length,
  };
}

/** True when the title names the key as a whole word: "MET-4" is not in "MET-41: x". */
export function titleHasKey(title: string, issueKey: string): boolean {
  const key = issueKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9-])${key}(?![0-9A-Za-z])`, "i").test(title);
}

interface GhResult {
  stdout: string;
}

/** Wraps the `gh` CLI. Every read uses `--json`; reviews go through `gh api` with JSON on stdin. */
export function createGhCli(options: GhCliOptions): GitHub {
  const env = options.env ?? process.env;
  const bin = options.bin ?? env.HARNESSD_GH_BIN ?? "gh";
  const timeoutMs = options.timeoutMs ?? 60_000;

  function gh(args: string[], stdin?: string): Promise<GhResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(bin, args, {
        cwd: options.cwd,
        env: { ...env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const done = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve({ stdout });
      };
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        done(new GitHubError(`gh ${args[0] ?? ""} timed out after ${timeoutMs / 1000}s`));
      }, timeoutMs);
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.on("error", (error) =>
        done(new GitHubError(`could not run ${bin}: ${error.message}`, { cause: error })),
      );
      child.on("close", (code) => {
        if (code === 0) return done();
        const detail = stderr.trim() || stdout.trim();
        done(
          new GitHubError(
            `gh ${args.slice(0, 2).join(" ")} exited with code ${code}${detail ? `: ${detail}` : ""}`,
          ),
        );
      });
      child.stdin.on("error", () => undefined);
      child.stdin.end(stdin ?? "");
    });
  }

  return {
    async findPrForIssue(issueKey) {
      const { stdout } = await gh([
        "pr",
        "list",
        "--state",
        "open",
        "--search",
        `${issueKey} in:title`,
        "--limit",
        "30",
        "--json",
        PR_FIELDS,
      ]);
      const matches = parsePullRequests(stdout).filter((pr) => titleHasKey(pr.title, issueKey));
      return matches.sort((a, b) => b.number - a.number)[0];
    },

    async prFiles(number) {
      const { stdout } = await gh(["pr", "view", String(number), "--json", "files"]);
      return parsePullRequestFiles(stdout);
    },

    async postReview(number, review) {
      const payload: Record<string, string> = { event: review.event, body: review.body };
      if (review.commitId !== undefined) payload.commit_id = review.commitId;
      const { stdout } = await gh(
        ["api", "--method", "POST", `repos/{owner}/{repo}/pulls/${number}/reviews`, "--input", "-"],
        JSON.stringify(payload),
      );
      const value = parseJson(stdout, "api reviews");
      if (!isObj(value) || typeof value.html_url !== "string") {
        throw new GitHubError("gh api reviews: expected an object with html_url");
      }
      return value.html_url;
    },

    async prStatus(number) {
      const { stdout } = await gh(["pr", "view", String(number), "--json", PR_STATUS_FIELDS]);
      return parsePullRequestStatus(stdout);
    },

    async mergePr(number, input) {
      await gh([
        "pr",
        "merge",
        String(number),
        `--${input.method}`,
        "--match-head-commit",
        input.matchHeadCommit,
      ]);
    },

    async addLabel(number, label) {
      const add = () => gh(["pr", "edit", String(number), "--add-label", label]);
      try {
        await add();
      } catch {
        // Most likely the label does not exist yet in this repo: create it, then retry.
        await gh([
          "label",
          "create",
          label,
          "--description",
          "harnessd: waits for a human before merge (D-013)",
          "--color",
          "B60205",
        ]).catch(() => undefined);
        await add();
      }
    },
  };
}
