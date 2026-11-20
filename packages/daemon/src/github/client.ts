// GitHub through the `gh` CLI only (D-002): no SDK and no REST client in-process.
// Auth is whatever `gh` uses (GH_TOKEN, GITHUB_TOKEN or `gh auth login`); harnessd never
// reads or stores a token. See docs/LOOP.md.
import { spawn } from "node:child_process";

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

/** The GitHub calls harnessd makes. `createGhCli` implements it; tests use a fake. */
export interface GitHub {
  /** The newest open PR whose title carries the issue key ("MET-41"), if any. */
  findPrForIssue(issueKey: string): Promise<PullRequest | undefined>;
  /** Files the PR changes, for the QA prompt's diff summary. */
  prFiles(number: number): Promise<PullRequestFile[]>;
  /** Posts one review and returns its URL. */
  postReview(number: number, review: ReviewInput): Promise<string>;
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
  };
}
