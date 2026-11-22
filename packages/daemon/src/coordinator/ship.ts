// Ships an ok part run (MET-109): the daemon commits the worktree, pushes the branch and
// opens or updates the PR. The agent gets no git write and no GitHub login, so this works
// for every harness sandbox. See docs/LOOP.md.
import { spawn } from "node:child_process";
import type { GitHub } from "../github/client.ts";

/** Every git and gh call in the ship step stops after this (D-002, MET-109). */
export const SHIP_TIMEOUT_MS = 60_000;

/** The agent's last message is cut to this many characters in the commit body. */
export const MAX_COMMIT_BODY = 2_000;

export interface ShipInput {
  /** The run's worktree. */
  worktree: string;
  /** The branch the run is on. */
  branch: string;
  issueKey: string;
  title: string;
  /** The Linear issue URL, one line at the end of the PR body. */
  issueUrl?: string;
  /** The agent's last message: the commit body and the PR body. */
  finalText?: string;
  /**
   * The run env from worktree sync: it points `core.excludesFile` at the run's excludes
   * file, so generated native files never enter the commit.
   */
  env?: Record<string, string>;
  github: GitHub;
  timeoutMs?: number;
}

export interface Shipped {
  ok: true;
  /** True when the daemon made a commit; false when the agent had already committed. */
  committed: boolean;
  prUrl: string;
  /** False when an open PR already uses the run branch: the push updated it. */
  created: boolean;
}

export interface ShipFailed {
  ok: false;
  /** One line that explains why the daemon could not ship the run. */
  error: string;
}

export type ShipResult = Shipped | ShipFailed;

/** Commits, pushes and opens or updates the PR. The loop uses `shipPart`. */
export type ShipRun = (input: ShipInput) => Promise<ShipResult>;

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max).trimEnd()}...`;
}

interface GitOptions {
  input?: string;
  timeoutMs?: number;
}

/** Runs git with no shell. Throws with the first line git wrote on failure. */
function git(
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  options: GitOptions = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? SHIP_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", cwd, "--literal-pathspecs", ...args], {
      env,
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
      else resolve(stdout);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done(new Error(`git ${args[0] ?? ""} timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) =>
      done(new Error(`could not run git: ${error.message}`, { cause: error })),
    );
    child.on("close", (code) => {
      if (code === 0) return done();
      const detail = oneLine(stderr) || oneLine(stdout);
      done(
        new Error(
          `git ${args.slice(0, 2).join(" ")} exited with code ${code}${detail ? `: ${detail}` : ""}`,
        ),
      );
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(options.input ?? "");
  });
}

async function exists(worktree: string, ref: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  return git(worktree, ["rev-parse", "--verify", "--quiet", ref], env).then(
    () => true,
    () => false,
  );
}

/** `main` or `master`, from `origin/HEAD`; `main` when the remote has no HEAD set. */
async function defaultBranch(worktree: string, env: NodeJS.ProcessEnv): Promise<string> {
  const head = (
    await git(
      worktree,
      ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
      env,
    ).catch(() => "")
  ).trim();
  if (head.startsWith("origin/")) return head.slice("origin/".length);
  for (const name of ["main", "master"]) {
    if (await exists(worktree, `refs/remotes/origin/${name}`, env)) return name;
  }
  return "main";
}

/** The ref the branch is compared with: the remote default branch when present. */
async function baseRef(worktree: string, base: string, env: NodeJS.ProcessEnv): Promise<string> {
  for (const ref of [`origin/${base}`, base]) {
    if (await exists(worktree, ref, env)) return ref;
  }
  throw new Error(`no ${base} branch to compare with`);
}

/** The agent's final text, then one line with the issue URL. Empty text leaves the line. */
export function prBody(finalText: string | undefined, issueUrl: string | undefined): string {
  const parts: string[] = [];
  const text = finalText?.trim() ?? "";
  if (text !== "") parts.push(text);
  if (issueUrl !== undefined && issueUrl.trim() !== "") parts.push(`Issue: ${issueUrl.trim()}`);
  return parts.join("\n\n");
}

function commitMessage(issueKey: string, title: string, finalText: string | undefined): string {
  const subject = `${issueKey}: ${title}`;
  const body = finalText?.trim() ?? "";
  return body === "" ? subject : `${subject}\n\n${cut(body, MAX_COMMIT_BODY)}`;
}

/**
 * Commits the worktree with the run's excludes, pushes the branch with no force, then
 * opens a PR when the issue has none. A run with nothing ahead of base fails as
 * "no changes"; a failed push or PR fails with that reason. Never force-pushes.
 */
export async function shipPart(input: ShipInput): Promise<ShipResult> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...input.env,
    GIT_TERMINAL_PROMPT: "0",
  };
  const timeoutMs = input.timeoutMs ?? SHIP_TIMEOUT_MS;
  const asError = (error: unknown): string =>
    oneLine(error instanceof Error ? error.message : String(error));

  let committed = false;
  try {
    await git(input.worktree, ["add", "-A"], env, { timeoutMs });
    const staged = (
      await git(input.worktree, ["diff", "--cached", "--name-only"], env, { timeoutMs })
    ).trim();
    if (staged !== "") {
      await git(input.worktree, ["commit", "-F", "-"], env, {
        timeoutMs,
        input: commitMessage(input.issueKey, input.title, input.finalText),
      });
      committed = true;
    }
  } catch (error) {
    return { ok: false, error: `push failed: ${asError(error)}` };
  }

  const base = await defaultBranch(input.worktree, env).catch(() => "main");
  let ahead = 0;
  try {
    const ref = await baseRef(input.worktree, base, env);
    ahead = Number(
      (
        await git(input.worktree, ["rev-list", "--count", `${ref}..HEAD`], env, { timeoutMs })
      ).trim(),
    );
  } catch (error) {
    return { ok: false, error: `push failed: ${asError(error)}` };
  }
  if (!committed && ahead === 0) return { ok: false, error: "no changes" };

  try {
    await git(input.worktree, ["push", "-u", "origin", input.branch], env, { timeoutMs });
  } catch (error) {
    return { ok: false, error: `push failed: ${asError(error)}` };
  }

  try {
    const open = await input.github.findPrByHead(input.branch);
    if (open !== undefined) {
      return { ok: true, committed, prUrl: open.url, created: false };
    }
    const issuePr = await input.github.findPrForIssue(input.issueKey);
    if (issuePr !== undefined) {
      // A PR on the same branch may have opened between the two lookups.
      if (issuePr.headRefName === input.branch) {
        if (issuePr.isCrossRepository) {
          return {
            ok: false,
            error: `pr failed: the open PR for ${input.issueKey} is from a fork`,
          };
        }
        return { ok: true, committed, prUrl: issuePr.url, created: false };
      }
      return {
        ok: false,
        error: `the open PR for ${input.issueKey} is on branch ${issuePr.headRefName}, not ${input.branch}`,
      };
    }
    const prUrl = await input.github.createPr({
      base,
      head: input.branch,
      title: `${input.issueKey}: ${input.title}`,
      body: prBody(input.finalText, input.issueUrl),
    });
    return { ok: true, committed, prUrl, created: true };
  } catch (error) {
    return { ok: false, error: `pr failed: ${asError(error)}` };
  }
}
