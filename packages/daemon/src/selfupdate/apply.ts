import { lstat, mkdir, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { type Exec, execFile, isExecutableFile, pathDirs } from "../status/detect.ts";
import { LAUNCHD_LABEL } from "../status/launchd.ts";
import { blockingLocalChanges } from "./detect.ts";

type Target = { from: string; to: string };
type Step = "pull" | "install" | "build" | "sync" | "restart";
type Failure = { status: "failed"; step: Step; error: string };
type ApplyResult = { status: "restarted" } | { status: "blocked"; reason: string } | Failure;

/** The update went back to the old commit because a kept change conflicts with the target. */
class BlockedError extends Error {}

interface ApplyOptions {
  installRoot: string;
  defaultBranch: string;
  /** Save the record before launchd stops this process. On failure the caller records the failed update. */
  writePending(record: Target & { at: string }): Promise<void>;
  exec?: Exec;
  isExecutable?(path: string): Promise<boolean>;
  now?(): Date;
  tempDir?: string;
  uid?: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failed(step: Step, error: unknown): Failure {
  const text = errorMessage(error);
  const output = text.trimEnd().split(/\r?\n/).slice(-20).join("\n");
  return { status: "failed", step, error: `${step}: ${output}` };
}

/** Build and restart at the loop's safe point, after the install check selected a target. */
export function createUpdateApplier(options: ApplyOptions) {
  const exec = options.exec ?? execFile;
  const { installRoot, defaultBranch } = options;

  return async function applyUpdate({ from, to }: Target): Promise<ApplyResult> {
    const nodeDir = dirname(process.execPath);
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
    env.PATH = [nodeDir, env.PATH].filter(Boolean).join(delimiter);
    // Git commands must use the repo in cwd, even if the caller inherited a Git context.
    for (const key of [
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
    ]) {
      delete env[key];
    }

    let step: Step = "pull";
    async function run(cwd: string, cmd: string, ...args: string[]): Promise<string> {
      const { code, stdout, stderr } = await exec(cmd, args, { cwd, env });
      if (code !== 0) {
        throw new Error(
          [stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join("\n") ||
            `${cmd} exited with code ${code}.`,
        );
      }
      return stdout.trim();
    }

    const git = (...args: string[]) => run(installRoot, "git", ...args);

    /** The status lines that block, and whether any tracked path changed (those get stashed). */
    async function checkoutChanges(): Promise<{ blocked: string[]; tracked: boolean }> {
      const result = await exec(
        "git",
        [
          "--no-optional-locks",
          "status",
          "--porcelain",
          "--untracked-files=all",
          "--ignore-submodules=none",
        ],
        { cwd: installRoot, env },
      );
      if (result.code !== 0) throw new Error("Cannot check the install clone for local changes.");
      const lines = result.stdout.split("\n").filter((line) => line.trim() !== "");
      return {
        blocked: blockingLocalChanges(result.stdout),
        tracked: lines.some((line) => !line.startsWith("??")),
      };
    }

    async function checkCheckout(expectedHead: string): Promise<boolean> {
      const { blocked, tracked } = await checkoutChanges();
      if (blocked.length > 0) {
        throw new Error(`Local changes in the install clone:\n${blocked.join("\n")}`);
      }
      for (const marker of [
        "MERGE_HEAD",
        "rebase-merge",
        "rebase-apply",
        "CHERRY_PICK_HEAD",
        "REVERT_HEAD",
        "sequencer",
      ]) {
        const path = await git("rev-parse", "--path-format=absolute", "--git-path", marker);
        try {
          await lstat(path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        throw new Error(`A Git operation is in progress in the install clone (${marker}).`);
      }
      const branch = await git("symbolic-ref", "--quiet", "HEAD");
      if (branch !== `refs/heads/${defaultBranch}`) {
        throw new Error(`The install clone must be on the default branch (${defaultBranch}).`);
      }
      const head = await git("rev-parse", "--verify", "HEAD^{commit}");
      if (head !== expectedHead) {
        throw new Error("The install commit changed during the update.");
      }
      return tracked;
    }

    async function checkInstall(): Promise<boolean> {
      const tracked = await checkCheckout(from);
      const origin = await git(
        "rev-parse",
        "--verify",
        `refs/remotes/origin/${defaultBranch}^{commit}`,
      );
      if (origin !== to) {
        throw new Error("The origin commit changed after the update check.");
      }
      await git("merge-base", "--is-ancestor", from, to);
      return tracked;
    }

    try {
      const uid = options.uid ?? process.getuid?.();
      if (uid === undefined) return failed("restart", "Cannot get the launchd user ID.");
      await checkInstall();
      step = "install";
      const isExecutable = options.isExecutable ?? isExecutableFile;
      let tool = join(nodeDir, "corepack");
      let prefix = ["pnpm"];
      for (const dir of pathDirs(env)) {
        const candidate = join(dir, "pnpm");
        if (await isExecutable(candidate)) {
          tool = candidate;
          prefix = [];
          break;
        }
      }
      async function build(cwd: string): Promise<void> {
        step = "install";
        await run(cwd, tool, ...prefix, "install", "--frozen-lockfile");
        step = "build";
        await run(cwd, tool, ...prefix, "build");
      }

      step = "pull";
      const temp = await mkdtemp(join(options.tempDir ?? tmpdir(), "harnessd-update-"));
      const stage = join(temp, "stage");
      let stageFailure: Failure | undefined;
      try {
        // Use the commit the check verified. The remote-tracking ref can move during a build.
        await git("worktree", "add", "--detach", stage, to);
        await build(stage);
      } catch (error) {
        stageFailure = failed(step, error);
      } finally {
        step = "pull";
        try {
          await git("worktree", "remove", "--force", stage);
        } catch (error) {
          stageFailure ??= failed(step, error);
        } finally {
          await rm(temp, { recursive: true, force: true });
        }
      }
      if (stageFailure) return stageFailure;

      // Keep the old outputs and dependencies on the same filesystem so recovery
      // still works when a build runs out of disk space.
      const cache = join(installRoot, ".turbo");
      await mkdir(cache, { recursive: true });
      const backup = await mkdtemp(join(cache, "self-update-"));
      const saved = new Map<string, string | undefined>();
      let advanced = false;
      let stashed = false;
      let stashCommit: string | undefined;
      const stashMessage = `harnessd self-update ${from.slice(0, 7)}`;
      let keepBackup = false;
      try {
        const workspaceDirs = await readdir(join(installRoot, "packages"), {
          withFileTypes: true,
        }).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return [];
          throw error;
        });
        const roots = [
          installRoot,
          ...workspaceDirs
            .filter((entry) => entry.isDirectory())
            .map((entry) => join(installRoot, "packages", entry.name)),
        ];
        const tracked = await checkInstall();
        for (const root of roots) {
          for (const name of ["dist", "node_modules"]) {
            const path = join(root, name);
            const copy = join(backup, String(saved.size));
            try {
              await rename(path, copy);
              saved.set(path, copy);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
              saved.set(path, undefined);
            }
          }
        }
        // Keep the changes harnessd writes over the fast-forward, as a manual deploy does
        // (D-042). Untracked kept paths stay in place; the merge refuses if it adds one.
        if (tracked) {
          await git("stash", "push", "-m", stashMessage);
          stashed = true;
          // Kept for a rollback: the stash is based on `from`, so it applies cleanly there
          // even after a pop drops its ref.
          stashCommit = await git("rev-parse", "--verify", "refs/stash").catch(() => undefined);
        }
        await git("merge", "--ff-only", "--no-overwrite-ignore", to);
        advanced = true;
        if (stashed) {
          try {
            await git("stash", "pop");
            stashed = false;
          } catch (error) {
            // The change conflicts with the target commit. Go back to the old commit and
            // put the change there, so nothing is lost (D-033).
            const conflicts = (await git("diff", "--name-only", "--diff-filter=U").catch(() => ""))
              .split("\n")
              .map((line) => line.trim())
              .filter(Boolean);
            step = "pull";
            await git("reset", "--hard", from);
            advanced = false;
            try {
              await git("stash", "pop");
              stashed = false;
            } catch {
              throw new BlockedError(
                `Local changes conflict with the update: ${conflicts.join(", ") || errorMessage(error)}. The stash ${stashMessage} is kept.`,
              );
            }
            throw new BlockedError(
              `Local changes conflict with the update: ${conflicts.join(", ") || errorMessage(error)}.`,
            );
          }
        }
        await build(installRoot);
        step = "sync";
        await run(
          installRoot,
          process.execPath,
          join(installRoot, "packages", "cli", "dist", "bin.js"),
          "sync",
          installRoot,
        );
        step = "pull";
        await checkCheckout(to);
        step = "restart";
        await options.writePending({ from, to, at: (options.now?.() ?? new Date()).toISOString() });
        await run(installRoot, "launchctl", "kickstart", "-k", `gui/${uid}/${LAUNCHD_LABEL}`);
        return { status: "restarted" };
      } catch (error) {
        const blocked = error instanceof BlockedError;
        let detail = blocked ? error.message : failed(step, error).error;
        if (advanced) {
          try {
            await checkCheckout(to);
            if (stashCommit !== undefined) {
              // The kept changes are applied over `to`. Take them out of the way, go back to
              // `from`, and put them back there (D-033 never discards a change).
              await git("reset", "--hard", from);
              try {
                await git("stash", "apply", stashCommit);
              } catch (applyError) {
                detail += `\nThe kept changes stay in stash commit ${stashCommit}: ${failed("pull", applyError).error}`;
              }
            } else {
              await git("reset", "--keep", from);
            }
          } catch (rollbackError) {
            detail += `\nRestore the old commit: ${failed("pull", rollbackError).error}`;
          }
        } else if (stashed && !blocked) {
          // The install clone did not advance: put the kept change back.
          try {
            await git("stash", "pop");
            stashed = false;
          } catch (popError) {
            detail += `\nThe kept changes stay in ${stashMessage}: ${failed("pull", popError).error}`;
          }
        }
        for (const [path, copy] of saved) {
          try {
            await rm(path, { recursive: true, force: true });
            if (copy !== undefined) await rename(copy, path);
          } catch (restoreError) {
            keepBackup = true;
            detail += `\nRestore ${path}${copy ? ` from ${copy}` : ""}: ${failed("build", restoreError).error}`;
          }
        }
        return blocked
          ? { status: "blocked", reason: detail }
          : { status: "failed", step, error: detail };
      } finally {
        if (!keepBackup) await rm(backup, { recursive: true, force: true }).catch(() => {});
      }
    } catch (error) {
      return failed(step, error);
    }
  };
}

/** Bind the install check and the applier to the coordinator's safe-point interface. */
export function createSelfUpdater(
  options: ApplyOptions & {
    checkForUpdate(): Promise<Target | undefined>;
    /** The commit the running build came from, so a new process can finish an applying record. */
    runningCommit?: string;
  },
) {
  const applyUpdate = createUpdateApplier(options);
  return {
    ...(options.runningCommit ? { runningCommit: options.runningCommit } : {}),
    checkForUpdate: () => options.checkForUpdate(),
    async applyUpdate(
      target: Target,
    ): Promise<{ status: "applied" } | { status: "blocked"; reason: string } | Failure> {
      const result = await applyUpdate(target);
      return result.status === "restarted" ? { status: "applied" } : result;
    },
  };
}
