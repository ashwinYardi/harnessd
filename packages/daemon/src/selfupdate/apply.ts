import { lstat, mkdir, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { type Exec, execFile, isExecutableFile, pathDirs } from "../status/detect.ts";
import { LAUNCHD_LABEL } from "../status/launchd.ts";

type Target = { from: string; to: string };
type Step = "pull" | "install" | "build" | "restart";
type Failure = { status: "failed"; step: Step; error: string };
type ApplyResult = { status: "restarted" } | Failure;

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

function failed(step: Step, error: unknown): Failure {
  const text = error instanceof Error ? error.message : String(error);
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
    async function checkCheckout(expectedHead: string): Promise<void> {
      const changes = await git(
        "--no-optional-locks",
        "status",
        "--porcelain",
        "--untracked-files=all",
        "--ignore-submodules=none",
      );
      if (changes) throw new Error(`Local changes in the install clone:\n${changes}`);
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
    }

    async function checkInstall(): Promise<void> {
      await checkCheckout(from);
      const origin = await git(
        "rev-parse",
        "--verify",
        `refs/remotes/origin/${defaultBranch}^{commit}`,
      );
      if (origin !== to) {
        throw new Error("The origin commit changed after the update check.");
      }
      await git("merge-base", "--is-ancestor", from, to);
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
        await checkInstall();
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
        await git("merge", "--ff-only", "--no-overwrite-ignore", to);
        advanced = true;
        await build(installRoot);
        step = "pull";
        await checkCheckout(to);
        step = "restart";
        await options.writePending({ from, to, at: (options.now?.() ?? new Date()).toISOString() });
        await run(installRoot, "launchctl", "kickstart", "-k", `gui/${uid}/${LAUNCHD_LABEL}`);
        return { status: "restarted" };
      } catch (error) {
        const failure = failed(step, error);
        if (advanced) {
          try {
            await checkCheckout(to);
            await git("reset", "--keep", from);
          } catch (rollbackError) {
            failure.error += `\nRestore the old commit: ${failed("pull", rollbackError).error}`;
          }
        }
        for (const [path, copy] of saved) {
          try {
            if (advanced) await rm(path, { recursive: true, force: true });
            if (copy !== undefined) await rename(copy, path);
          } catch (restoreError) {
            keepBackup = true;
            failure.error += `\nRestore ${path}${copy ? ` from ${copy}` : ""}: ${failed("build", restoreError).error}`;
          }
        }
        return failure;
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
  options: ApplyOptions & { checkForUpdate(): Promise<Target | undefined> },
) {
  const applyUpdate = createUpdateApplier(options);
  return {
    checkForUpdate: () => options.checkForUpdate(),
    async applyUpdate(target: Target): Promise<{ status: "applied" } | Failure> {
      const result = await applyUpdate(target);
      return result.status === "restarted" ? { status: "applied" } : result;
    },
  };
}
