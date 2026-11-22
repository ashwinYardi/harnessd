/**
 * Per-task git worktrees (D-012): one worktree and one branch per task, under
 * `<root>/<repo-name>/<branch>`, where root defaults to `~/.harnessd/worktrees`.
 *
 * A manifest at `<root>/.harnessd-worktrees.json` records every worktree we own.
 * Entries are written before git touches the disk, so a crash at any point leaves
 * a record that `recoverOnStartup` can reconcile.
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, open, readdir, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { excludesEnv } from "./excludes.ts";

const run = promisify(execFile);

/** Maximum length of a whole branch name, `met-<n>-<slug>` included. */
export const MAX_BRANCH_LENGTH = 60;

export const MANIFEST_FILE = ".harnessd-worktrees.json";

/**
 * active: a live daemon owns it. done: being removed. stale: its daemon died; the
 * branch (and the folder, if it survived) are kept so a resumed task picks them up.
 */
export type WorktreeStatus = "active" | "done" | "stale";

export interface WorktreeEntry {
  issueKey: string;
  branch: string;
  path: string;
  repoDir: string;
  status: WorktreeStatus;
  pid: number;
  createdAt: string;
}

export interface Manifest {
  version: 1;
  entries: WorktreeEntry[];
}

export interface Worktree {
  path: string;
  branch: string;
  /** True when an existing branch or worktree was picked back up. */
  resumed: boolean;
}

export function defaultWorktreesRoot(): string {
  return join(homedir(), ".harnessd", "worktrees");
}

function slugify(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * `branchName("MET-12", "Coordinator splits issues into sub-issues")` is
 * `met-12-coordinator-splits-issues-into-sub-issues`. The slug is cut at a word
 * boundary so the whole name stays within MAX_BRANCH_LENGTH; a single word longer
 * than the budget is cut hard. An empty slug yields just the key.
 */
export function branchName(issueKey: string, title: string): string {
  const key = slugify(issueKey);
  if (!/^[a-z]+-\d+$/.test(key)) {
    throw new Error(`invalid issue key: ${JSON.stringify(issueKey)}`);
  }
  const budget = MAX_BRANCH_LENGTH - key.length - 1;
  let slug = slugify(title);
  if (slug.length > budget) {
    const cut = slug.slice(0, budget + 1);
    const lastDash = cut.lastIndexOf("-");
    slug = lastDash > 0 ? cut.slice(0, lastDash) : slug.slice(0, budget);
    slug = slug.replace(/-+$/, "");
  }
  return slug && budget > 0 ? `${key}-${slug}` : key;
}

async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  try {
    const { stdout } = await run("git", ["-C", cwd, ...args], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env },
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new Error(`git ${args.join(" ")} failed in ${cwd}${stderr ? `: ${stderr}` : ""}`, {
      cause: error,
    });
  }
}

/** True when `git rev-parse --verify` finds `ref`. */
async function refExists(repoDir: string, ref: string): Promise<boolean> {
  try {
    await git(repoDir, ["rev-parse", "--verify", "--quiet", ref]);
    return true;
  } catch {
    return false;
  }
}

/** True when `ancestor` is on the history of `descendant`. */
async function isAncestor(repoDir: string, ancestor: string, descendant: string): Promise<boolean> {
  try {
    await git(repoDir, ["merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch {
    return false;
  }
}

/** Commits on the worktree's HEAD that `from` does not reach. */
function commitsAhead(path: string, from: string): Promise<number> {
  return git(path, ["rev-list", "--count", `${from}..HEAD`]).then((out) => {
    const n = Number.parseInt(out.trim(), 10);
    return Number.isInteger(n) && n > 0 ? n : 0;
  });
}

/**
 * The head of `refs/heads/<branch>` on the remote, or undefined when the remote has no
 * such branch. Asks the remote itself: a local `refs/remotes/origin/<branch>` can outlive
 * a deleted remote branch and would wrongly report the branch as shipped.
 */
async function remoteBranchHead(
  repoDir: string,
  branch: string,
  remote = "origin",
): Promise<string | undefined> {
  try {
    const out = await git(repoDir, ["ls-remote", "--heads", remote, `refs/heads/${branch}`]);
    const sha = out.trim().split("\n")[0]?.split(/\s+/)[0];
    return sha !== undefined && /^[0-9a-f]{40}$/.test(sha) ? sha : undefined;
  } catch {
    // The remote is unreachable. Treat it as missing: keep rather than lose work.
    return undefined;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** realpath that tolerates missing paths, so /tmp vs /private/tmp compare equal. */
async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(await canonical(parent), basename(path));
  }
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** Deletes a folder, but only if it sits inside the worktrees root. */
async function removeDir(root: string, path: string): Promise<void> {
  if (!isInside(await canonical(root), await canonical(path))) {
    throw new Error(`refusing to delete ${path}: outside worktrees root ${root}`);
  }
  await rm(path, { recursive: true, force: true });
}

/** Paths of the worktrees git has registered for a repo, canonicalised. */
async function registeredWorktrees(repoDir: string): Promise<Map<string, string | undefined>> {
  const out = await git(repoDir, ["worktree", "list", "--porcelain"]);
  const result = new Map<string, string | undefined>();
  for (const block of out.split("\n\n")) {
    const lines = block.split("\n");
    const pathLine = lines.find((l) => l.startsWith("worktree "));
    if (!pathLine) continue;
    const branchLine = lines.find((l) => l.startsWith("branch "));
    const branch = branchLine?.slice("branch refs/heads/".length);
    result.set(await canonical(pathLine.slice("worktree ".length)), branch);
  }
  return result;
}

async function branchExists(repoDir: string, branch: string): Promise<boolean> {
  try {
    await git(repoDir, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

// --- manifest -------------------------------------------------------------

function manifestPath(root: string): string {
  return join(root, MANIFEST_FILE);
}

function isEntry(value: unknown): value is WorktreeEntry {
  const e = value as Partial<WorktreeEntry> | null;
  return (
    typeof e === "object" &&
    e !== null &&
    typeof e.issueKey === "string" &&
    typeof e.branch === "string" &&
    typeof e.path === "string" &&
    typeof e.repoDir === "string" &&
    typeof e.pid === "number" &&
    typeof e.createdAt === "string" &&
    (e.status === "active" || e.status === "done" || e.status === "stale")
  );
}

/**
 * Reads the manifest. A missing file is an empty manifest. An unreadable one is
 * moved aside to `<file>.corrupt-<ts>` so the daemon can still start; the orphan
 * scan in recoverOnStartup then cleans up what it can.
 */
export async function readManifest(root: string): Promise<Manifest> {
  const file = manifestPath(root);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, entries: [] };
    throw error;
  }
  try {
    const parsed = JSON.parse(text) as Partial<Manifest>;
    if (!Array.isArray(parsed.entries)) throw new Error("no entries array");
    return { version: 1, entries: parsed.entries.filter(isEntry) };
  } catch {
    await rename(file, `${file}.corrupt-${Date.now()}`);
    return { version: 1, entries: [] };
  }
}

/** Writes tmp, fsyncs, then renames, so readers see the old or the new file, never half. */
async function writeManifest(root: string, manifest: Manifest): Promise<void> {
  await mkdir(root, { recursive: true });
  const file = manifestPath(root);
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const handle = await open(tmp, "w");
  try {
    await handle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

const locks = new Map<string, Promise<unknown>>();

/** Serialises read-modify-write of one manifest within this process. */
async function updateManifest<T>(
  root: string,
  fn: (manifest: Manifest) => Promise<T> | T,
): Promise<T> {
  const key = resolve(root);
  const previous = locks.get(key) ?? Promise.resolve();
  const next = previous.then(async () => {
    const manifest = await readManifest(root);
    const result = await fn(manifest);
    await writeManifest(root, manifest);
    return result;
  });
  const settled = next.catch(() => undefined);
  locks.set(key, settled);
  try {
    return await next;
  } finally {
    if (locks.get(key) === settled) locks.delete(key);
  }
}

function upsert(manifest: Manifest, entry: WorktreeEntry): void {
  const i = manifest.entries.findIndex((e) => e.path === entry.path);
  if (i === -1) manifest.entries.push(entry);
  else manifest.entries[i] = entry;
}

function drop(manifest: Manifest, path: string): void {
  manifest.entries = manifest.entries.filter((e) => e.path !== path);
}

// --- create / remove ------------------------------------------------------

export interface CreateWorktreeOptions {
  repoDir: string;
  issueKey: string;
  title: string;
  /** Branch or commit the new branch starts from. Default "main". */
  base?: string;
  /** Worktrees root. Default `~/.harnessd/worktrees`. */
  root?: string;
  /** Owner recorded in the manifest. Default this process. */
  pid?: number;
}

/**
 * Creates `<root>/<repo-name>/<branch>` on a new branch from `base`. If the branch
 * already exists (a resumed task) it is checked out as is; if the worktree itself
 * is still there, it is reused. Fetches nothing.
 */
export async function createWorktree(options: CreateWorktreeOptions): Promise<Worktree> {
  const root = resolve(options.root ?? defaultWorktreesRoot());
  const repoDir = (await git(options.repoDir, ["rev-parse", "--show-toplevel"])).trim();
  const branch = branchName(options.issueKey, options.title);
  const path = join(root, basename(repoDir), branch);
  const pid = options.pid ?? process.pid;

  return updateManifest(root, async (manifest) => {
    const previous = manifest.entries.find((e) => e.path === path);
    const entry: WorktreeEntry = {
      issueKey: options.issueKey,
      branch,
      path,
      repoDir,
      status: "active",
      pid,
      createdAt: previous?.createdAt ?? new Date().toISOString(),
    };

    await git(repoDir, ["worktree", "prune"]);
    const registered = await registeredWorktrees(repoDir);
    const canonicalPath = await canonical(path);
    if (registered.has(canonicalPath)) {
      const onBranch = registered.get(canonicalPath);
      if (onBranch !== branch) {
        throw new Error(`${path} is a worktree on ${onBranch ?? "a detached HEAD"}, not ${branch}`);
      }
      upsert(manifest, entry);
      return { path, branch, resumed: true };
    }
    if (await exists(path)) {
      throw new Error(`${path} exists but is not a git worktree; run recoverOnStartup first`);
    }

    // Record intent before git writes anything, so a crash mid-add is recoverable.
    upsert(manifest, entry);
    await writeManifest(root, manifest);

    await mkdir(dirname(path), { recursive: true });
    const resumed = await branchExists(repoDir, branch);
    // A branch a QA send-back already pushed starts from, or catches up to, its remote
    // head, so the next daemon push is a fast-forward.
    const remoteBranch = (await refExists(repoDir, `refs/remotes/origin/${branch}`))
      ? `origin/${branch}`
      : undefined;
    if (resumed && remoteBranch !== undefined) {
      const inUse = [...registered.values()].some((on) => on === branch);
      if (!inUse && (await isAncestor(repoDir, branch, remoteBranch))) {
        await git(repoDir, ["branch", "-f", branch, remoteBranch]);
      }
    }
    const base = !resumed && remoteBranch !== undefined ? remoteBranch : (options.base ?? "main");
    try {
      await git(
        repoDir,
        resumed ? ["worktree", "add", path, branch] : ["worktree", "add", "-b", branch, path, base],
      );
    } catch (error) {
      if (previous) upsert(manifest, previous);
      else drop(manifest, path);
      await writeManifest(root, manifest);
      throw error;
    }
    return { path, branch, resumed };
  });
}

export interface CheckoutWorktreeOptions {
  repoDir: string;
  /** The task that reads the checkout, e.g. the QA sub-issue. Names the folder. */
  issueKey: string;
  title: string;
  /** Remote branch to fetch, e.g. a PR's head branch. */
  branch: string;
  /** Commit to check out (the PR head). It must be the branch's head or reachable locally. */
  sha: string;
  /** Default "origin". */
  remote?: string;
  root?: string;
  pid?: number;
}

/**
 * Checks out someone else's branch read-only: fetches `branch` from `remote` and adds
 * `<root>/<repo-name>/<branchName(issueKey, title)>` with a detached HEAD at `sha`, so the
 * branch itself stays free for its owner and is never moved. A leftover worktree at the
 * same path (a crashed run) is replaced. If the fetch fails but `sha` is already present
 * locally, the local commit is used; it is the same commit.
 */
export async function checkoutWorktree(options: CheckoutWorktreeOptions): Promise<Worktree> {
  const root = resolve(options.root ?? defaultWorktreesRoot());
  const repoDir = (await git(options.repoDir, ["rev-parse", "--show-toplevel"])).trim();
  const path = join(root, basename(repoDir), branchName(options.issueKey, options.title));
  const remote = options.remote ?? "origin";

  let fetchError: unknown;
  try {
    await git(repoDir, ["fetch", "--quiet", remote, `refs/heads/${options.branch}`]);
  } catch (error) {
    fetchError = error;
  }
  try {
    await git(repoDir, ["rev-parse", "--verify", "--quiet", `${options.sha}^{commit}`]);
  } catch (error) {
    throw fetchError ?? error;
  }

  return updateManifest(root, async (manifest) => {
    await git(repoDir, ["worktree", "prune"]);
    if ((await registeredWorktrees(repoDir)).has(await canonical(path))) {
      await teardown(root, repoDir, path);
    } else if (await exists(path)) {
      throw new Error(`${path} exists but is not a git worktree; run recoverOnStartup first`);
    }
    upsert(manifest, {
      issueKey: options.issueKey,
      branch: options.branch,
      path,
      repoDir,
      status: "active",
      pid: options.pid ?? process.pid,
      createdAt: new Date().toISOString(),
    });
    await writeManifest(root, manifest);
    await mkdir(dirname(path), { recursive: true });
    try {
      await git(repoDir, ["worktree", "add", "--detach", path, options.sha]);
    } catch (error) {
      drop(manifest, path);
      await writeManifest(root, manifest);
      throw error;
    }
    return { path, branch: options.branch, resumed: false };
  });
}

export interface RemoveWorktreeOptions {
  repoDir: string;
  path: string;
  root?: string;
  /** Also delete the branch. Default false: the PR needs it. */
  deleteBranch?: boolean;
  /**
   * A throwaway checkout, such as a QA PR head, detached from a branch. Its commits are
   * judged against the remote branch when one exists, not against the base, because a
   * PR from a fork keeps its commits on another branch. Uncommitted work is still kept.
   */
  scratch?: boolean;
  /** The run's excludes file, so synced files do not count as uncommitted changes. */
  excludesFile?: string;
  /** The branch the task started from, when it has no remote branch. Default "main". */
  base?: string;
}

/** Why a worktree was kept: it holds work the remote does not have. */
export type WorktreeKeepReason = "uncommitted changes" | "commits not on the remote";

export interface RemoveWorktreeResult {
  removed: boolean;
  /** Set when the worktree was kept. */
  kept?: WorktreeKeepReason;
}

/**
 * The reason to keep the worktree, or undefined when it is safe to remove. Committed
 * work counts only when it is not on the remote branch; with no remote branch, every
 * commit ahead of base is unshipped. A scratch checkout is detached from a PR head, so
 * its commits may live on a fork: it is judged on the remote branch when one exists,
 * and otherwise on its uncommitted changes only.
 */
async function keepReason(
  repoDir: string,
  path: string,
  branch: string | undefined,
  base: string,
  excludesFile: string | undefined,
  scratch: boolean,
): Promise<WorktreeKeepReason | undefined> {
  const status = await git(
    path,
    ["status", "--porcelain"],
    excludesFile ? excludesEnv(excludesFile) : undefined,
  );
  if (status.trim() !== "") return "uncommitted changes";

  const remoteHead = branch === undefined ? undefined : await remoteBranchHead(repoDir, branch);
  if (remoteHead !== undefined) {
    // The remote may name a commit this clone has not fetched. Without it locally we
    // cannot prove the work is shipped, so keep it.
    if (!(await refExists(repoDir, `${remoteHead}^{commit}`))) return "commits not on the remote";
    return (await commitsAhead(path, remoteHead)) > 0 ? "commits not on the remote" : undefined;
  }
  if (scratch) return undefined;
  for (const ref of [`origin/${base}`, base]) {
    if (await refExists(repoDir, ref)) {
      return (await commitsAhead(path, ref)) > 0 ? "commits not on the remote" : undefined;
    }
  }
  // No named base: the main checkout's commit is the best reference left.
  const head = (await git(repoDir, ["rev-parse", "--verify", "HEAD"]).catch(() => "")).trim();
  if (head !== "") {
    return (await commitsAhead(path, head)) > 0 ? "commits not on the remote" : undefined;
  }
  return undefined;
}

async function teardown(root: string, repoDir: string, path: string): Promise<void> {
  if (await exists(path)) {
    await git(repoDir, ["worktree", "remove", "--force", path]).catch(() => undefined);
    if (await exists(path)) await removeDir(root, path);
  }
  await git(repoDir, ["worktree", "prune"]);
}

/**
 * Removes a task's worktree and its manifest entry. The branch is kept unless asked.
 * A worktree with unshipped work is kept instead, with the reason.
 */
export async function removeWorktree(
  options: RemoveWorktreeOptions,
): Promise<RemoveWorktreeResult> {
  const root = resolve(options.root ?? defaultWorktreesRoot());
  const path = resolve(options.path);
  if (!isInside(await canonical(root), await canonical(path))) {
    throw new Error(`refusing to remove ${path}: outside worktrees root ${root}`);
  }
  return updateManifest(root, async (manifest) => {
    const entry = manifest.entries.find((e) => e.path === path);
    const repoDir = entry?.repoDir ?? options.repoDir;
    const branch = entry?.branch ?? (await registeredWorktrees(repoDir)).get(await canonical(path));

    if (await exists(path)) {
      const kept = await keepReason(
        repoDir,
        path,
        branch,
        options.base ?? "main",
        options.excludesFile,
        options.scratch ?? false,
      );
      if (kept !== undefined) return { removed: false, kept };
    }

    // Mark done first: if we crash below, recovery finishes the job.
    if (entry) {
      entry.status = "done";
      await writeManifest(root, manifest);
    }
    await teardown(root, repoDir, path);
    if (options.deleteBranch && branch && (await branchExists(repoDir, branch))) {
      await git(repoDir, ["branch", "-D", branch]);
    }
    drop(manifest, path);
    return { removed: true };
  });
}

// --- recovery -------------------------------------------------------------

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface RecoverOptions {
  root?: string;
  /** Liveness check, injectable for tests. Default: signal 0, and never this process. */
  isAlive?: (pid: number) => boolean;
}

export interface RecoveryReport {
  /** Entries whose owner died; marked stale and kept so the task can resume its branch. */
  resumed: string[];
  /** Folders deleted: finished worktrees, and orphans git no longer knows about. */
  removed: string[];
  /** Worktrees whose folder vanished behind git's back; git's record was pruned. */
  pruned: string[];
}

/** At startup no task is ours yet, so our own pid in the manifest is a reused one. */
function defaultIsAlive(pid: number): boolean {
  return pid !== process.pid && isPidAlive(pid);
}

/** Reads the gitdir a worktree's `.git` file points at, if any. */
async function linkedGitDir(path: string): Promise<string | undefined> {
  try {
    const text = await readFile(join(path, ".git"), "utf8");
    const match = /^gitdir: (.+)$/m.exec(text);
    return match?.[1] ? resolve(path, match[1].trim()) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reconciles the manifest with disk and git after a crash. For every entry whose
 * owner is gone (or that is done): prune git's record if the folder vanished,
 * delete the folder if git no longer knows it, then drop done entries and mark the
 * rest stale. Folders under the root that are in no entry and point at no live
 * git worktree are deleted too. Entries owned by a live process are left alone.
 */
export async function recoverOnStartup(options: RecoverOptions = {}): Promise<RecoveryReport> {
  const root = resolve(options.root ?? defaultWorktreesRoot());
  const isAlive = options.isAlive ?? defaultIsAlive;
  const report: RecoveryReport = { resumed: [], removed: [], pruned: [] };
  if (!(await exists(root))) return report;

  await updateManifest(root, async (manifest) => {
    const kept: WorktreeEntry[] = [];
    for (const entry of manifest.entries) {
      if (entry.status === "active" && isAlive(entry.pid)) {
        kept.push(entry);
        continue;
      }
      if (!(await exists(entry.repoDir))) {
        // The repo is gone; nothing to resume. Clear the folder if we can.
        if (await exists(entry.path)) {
          await removeDir(root, entry.path);
          report.removed.push(entry.path);
        }
        continue;
      }
      const registered = await registeredWorktrees(entry.repoDir);
      const known = registered.has(await canonical(entry.path));
      const onDisk = await exists(entry.path);

      if (known && !onDisk) {
        await git(entry.repoDir, ["worktree", "prune"]);
        report.pruned.push(entry.path);
      } else if (onDisk && !known) {
        await removeDir(root, entry.path);
        await git(entry.repoDir, ["worktree", "prune"]);
        report.removed.push(entry.path);
      }

      if (entry.status === "done") {
        if (known && onDisk) {
          await teardown(root, entry.repoDir, entry.path);
          report.removed.push(entry.path);
        }
        continue;
      }
      entry.status = "stale";
      kept.push(entry);
      report.resumed.push(entry.path);
    }
    manifest.entries = kept;

    // Orphans: folders at <root>/<repo>/<branch> that no entry claims and whose
    // .git link points nowhere (or is missing).
    const claimed = new Set(await Promise.all(kept.map((e) => canonical(e.path))));
    for (const repo of await readdir(root, { withFileTypes: true })) {
      if (!repo.isDirectory()) continue;
      for (const child of await readdir(join(root, repo.name), { withFileTypes: true })) {
        if (!child.isDirectory()) continue;
        const path = join(root, repo.name, child.name);
        if (claimed.has(await canonical(path))) continue;
        const gitDir = await linkedGitDir(path);
        if (gitDir && (await exists(gitDir))) continue; // git still knows it; not ours to judge
        await removeDir(root, path);
        report.removed.push(path);
      }
    }
  });
  return report;
}

// --- bound to one repo ----------------------------------------------------

/** The worktree operations the coordinator loop needs, bound to one repo. */
export interface TaskWorktrees {
  create(input: { issueKey: string; title: string }): Promise<Worktree>;
  /** A detached checkout of a remote branch at `sha` (checkoutWorktree), e.g. a PR to QA. */
  checkout(input: {
    issueKey: string;
    title: string;
    branch: string;
    sha: string;
  }): Promise<Worktree>;
  /**
   * Removes the worktree; the branch stays for the PR and for a retry. A worktree with
   * unshipped work is kept, and the result says why.
   */
  remove(
    path: string,
    options?: Omit<RemoveWorktreeOptions, "repoDir" | "path" | "root">,
  ): Promise<RemoveWorktreeResult>;
  /** Startup reconciliation (recoverOnStartup). */
  recover(): Promise<void>;
}

export interface GitWorktreesOptions {
  repoDir: string;
  /** Worktrees root. Default `~/.harnessd/worktrees`. */
  root?: string;
  /** Branch new task branches start from. Default "main". */
  base?: string;
}

export function createGitWorktrees(options: GitWorktreesOptions): TaskWorktrees {
  const root = options.root;
  return {
    create: ({ issueKey, title }) => {
      const create: CreateWorktreeOptions = { repoDir: options.repoDir, issueKey, title };
      if (root !== undefined) create.root = root;
      if (options.base !== undefined) create.base = options.base;
      return createWorktree(create);
    },
    checkout: (input) => {
      const checkout: CheckoutWorktreeOptions = { repoDir: options.repoDir, ...input };
      if (root !== undefined) checkout.root = root;
      return checkoutWorktree(checkout);
    },
    remove: (path, more) => {
      const remove: RemoveWorktreeOptions = { repoDir: options.repoDir, path, ...more };
      if (root !== undefined) remove.root = root;
      if (options.base !== undefined) remove.base = options.base;
      return removeWorktree(remove);
    },
    recover: async () => {
      await recoverOnStartup(root === undefined ? {} : { root });
    },
  };
}
