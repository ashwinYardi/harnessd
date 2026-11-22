import { lstat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Exec, execFile } from "../status/detect.ts";
import { isLaunchdServiceProcess } from "../status/launchd.ts";
import { SYNC_OUTPUT_PATHS } from "../sync/generate.ts";

export interface SelfUpdateRunner {
  exec: Exec;
  pathKind(path: string): Promise<"directory" | "entry" | undefined>;
}

const systemRunner: SelfUpdateRunner = {
  exec: execFile,
  async pathKind(path) {
    try {
      return (await lstat(path)).isDirectory() ? "directory" : "entry";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  },
};

export type Detection = { kind: "off" } | { kind: "on"; installRoot: string };

interface DetectOptions {
  /** Pass import.meta.url from the running CLI entry point. */
  cliUrl: string;
  workspace: string;
  selfUpdate: boolean;
  log(line: string): void;
  pid?: number;
  uid?: number;
}

export type UpdateCheck =
  | { kind: "none" }
  | { kind: "pending"; from: string; to: string }
  | { kind: "blocked"; reason: string };

/**
 * Local changes a self-update keeps (D-042): the files `harnessd sync` writes, the workspace
 * vault and the workspace config. Every other change still blocks. The sync list is imported,
 * not copied, so the two stay one list.
 */
export const SELF_UPDATE_KEPT_PATHS: readonly string[] = [
  ...SYNC_OUTPUT_PATHS,
  ".harnessd/vault/",
  ".harnessd/config.toml",
];

/** A porcelain path is quoted with C-style escapes when it holds a space or a control byte. */
function porcelainPath(text: string): string {
  if (!text.startsWith('"') || !text.endsWith('"')) return text;
  try {
    return JSON.parse(text) as string;
  } catch {
    return text.slice(1, -1);
  }
}

/** Every path a `git status --porcelain` line touches; a rename line names two. */
function changedPaths(line: string): string[] {
  return line.slice(3).split(" -> ").map(porcelainPath);
}

/** True when a repo-relative path is one a self-update keeps (D-042). */
export function isSelfUpdateKeptPath(path: string): boolean {
  return SELF_UPDATE_KEPT_PATHS.some((kept) =>
    kept.endsWith("/") ? path === kept.slice(0, -1) || path.startsWith(kept) : path === kept,
  );
}

/**
 * The changed paths in `git status --porcelain` output that block a self-update: every line
 * whose path harnessd does not write itself. An empty list means only kept changes remain.
 */
export function blockingLocalChanges(status: string): string[] {
  return status
    .split("\n")
    .filter((line) => line.trim() !== "")
    .filter((line) => !changedPaths(line).every(isSelfUpdateKeptPath))
    .map((line) => line.slice(3));
}

// Keep each command scoped to its cwd even when the daemon inherits Git's repo context.
const gitRepositoryEnv = [
  "GIT_DIR",
  "GIT_COMMON_DIR",
  "GIT_WORK_TREE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_GRAFT_FILE",
  "GIT_REPLACE_REF_BASE",
  "GIT_SHALLOW_FILE",
  "GIT_PREFIX",
];

function git(runner: SelfUpdateRunner, cwd: string, ...args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  for (const key of gitRepositoryEnv) delete env[key];
  return runner.exec("git", args, {
    cwd,
    timeoutMs: args[0] === "fetch" ? 60_000 : 5_000,
    env,
  });
}

function githubRepo(remote: string): string | undefined {
  const match =
    /^(?:https?:\/\/(?:[^/@\s]+@)?github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([\w.-]+)\/([\w.-]+)\/?$/i.exec(
      remote.trim(),
    );
  return match ? `${match[1]}/${match[2]?.replace(/\.git$/i, "")}`.toLowerCase() : undefined;
}

/** Run once at startup. Logs one reason when self-update is off. */
export async function detectSelfUpdate(
  options: DetectOptions,
  runner: SelfUpdateRunner = systemRunner,
): Promise<Detection> {
  const off = (reason: string): Detection => {
    options.log(`Self-update is off. ${reason}`);
    return { kind: "off" };
  };
  if (!options.selfUpdate) return off("daemon.self_update is false.");

  const cliDir = dirname(fileURLToPath(options.cliUrl));
  const root = await git(runner, cliDir, "rev-parse", "--show-toplevel");
  const installRoot = root.stdout.trim();
  if (root.code !== 0 || !installRoot) return off("The CLI is outside a git clone.");

  const [installed, served] = await Promise.all([
    git(runner, installRoot, "remote", "get-url", "origin"),
    git(runner, options.workspace, "remote", "get-url", "origin"),
  ]);
  const repo = githubRepo(installed.stdout);
  if (installed.code !== 0 || served.code !== 0 || !repo || repo !== githubRepo(served.stdout)) {
    return off("The install and workspace must have the same GitHub origin.");
  }

  try {
    if ((await runner.pathKind(join(options.workspace, "packages", "daemon"))) !== "directory") {
      return off("The workspace has no packages/daemon directory.");
    }
  } catch {
    return off("Cannot inspect the workspace packages/daemon directory.");
  }

  const uid = options.uid ?? process.getuid?.();
  if (
    uid === undefined ||
    !(await isLaunchdServiceProcess(runner.exec, uid, options.pid ?? process.pid))
  ) {
    return off("This process is outside the harnessd launchd service.");
  }
  return { kind: "on", installRoot };
}

/** Check the install clone. The default branch is the branch name from GitHub. */
export async function checkForUpdate(
  detection: Detection,
  defaultBranch: string,
  runner: SelfUpdateRunner = systemRunner,
): Promise<UpdateCheck> {
  if (detection.kind === "off") return { kind: "none" };
  const run = (...args: string[]) => git(runner, detection.installRoot, ...args);
  const blocked = (reason: string): UpdateCheck => ({ kind: "blocked", reason });

  const status = await run(
    "--no-optional-locks",
    "status",
    "--porcelain",
    "--untracked-files=all",
    "--ignore-submodules=none",
  );
  if (status.code !== 0) return blocked("Cannot check the install clone for local changes.");
  if (status.stdout) {
    const files = blockingLocalChanges(status.stdout);
    if (files.length > 0) {
      return blocked(`Local changes in the install clone: ${files.join(", ")}`);
    }
  }

  for (const marker of ["MERGE_HEAD", "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD"]) {
    const path = await run("rev-parse", "--path-format=absolute", "--git-path", marker);
    if (path.code !== 0 || !path.stdout.trim()) {
      return blocked("Cannot check the install clone for git operations.");
    }
    try {
      if (await runner.pathKind(path.stdout.trim())) {
        return blocked(`A git operation is in progress in the install clone (${marker}).`);
      }
    } catch {
      return blocked("Cannot check the install clone for git operations.");
    }
  }

  const headRef = `refs/heads/${defaultBranch}`;
  const branch = await run("symbolic-ref", "--quiet", "HEAD");
  if (branch.code !== 0 || branch.stdout.trim() !== headRef) {
    return blocked(`The install clone must be on the default branch (${defaultBranch}).`);
  }

  const remoteRef = `refs/remotes/origin/${defaultBranch}`;
  // An explicit refspec keeps the comparison current even with a narrow fetch config.
  const fetch = await run(
    "fetch",
    "--no-tags",
    "--no-recurse-submodules",
    "--refmap=",
    "origin",
    `+${headRef}:${remoteRef}`,
  );
  if (fetch.code !== 0) return blocked(`git fetch failed (exit ${fetch.code}).`);

  const [head, remote] = await Promise.all([
    run("rev-parse", "--verify", "HEAD^{commit}"),
    run("rev-parse", "--verify", `${remoteRef}^{commit}`),
  ]);
  const from = head.stdout.trim();
  const to = remote.stdout.trim();
  if (head.code !== 0 || remote.code !== 0 || !from || !to) {
    return blocked("Cannot read the install and origin commits.");
  }
  if (from === to) return { kind: "none" };

  const ancestor = await run("merge-base", "--is-ancestor", from, to);
  if (ancestor.code === 1) return blocked("The install clone cannot fast-forward to origin.");
  if (ancestor.code !== 0)
    return blocked("Cannot check whether the install clone can fast-forward.");
  return { kind: "pending", from, to };
}

/**
 * The branch `origin/HEAD` names in the install clone, such as `main`, or undefined when it is
 * not set. The self-update uses it when GitHub cannot name the default branch (MET-137).
 */
export async function originHeadBranch(
  installRoot: string,
  runner: SelfUpdateRunner = systemRunner,
): Promise<string | undefined> {
  const head = await git(
    runner,
    installRoot,
    "symbolic-ref",
    "--quiet",
    "--short",
    "refs/remotes/origin/HEAD",
  );
  const name = head.stdout.trim();
  if (head.code !== 0 || !name.startsWith("origin/")) return undefined;
  return name.slice("origin/".length);
}

/** The commit the install clone is on, or undefined. A new process reads it after a restart. */
export async function headCommit(
  installRoot: string,
  runner: SelfUpdateRunner = systemRunner,
): Promise<string | undefined> {
  const head = await git(runner, installRoot, "rev-parse", "--verify", "HEAD^{commit}");
  const sha = head.stdout.trim();
  return head.code === 0 && sha !== "" ? sha : undefined;
}
