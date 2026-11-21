// The harness worktree-write check (MET-115): inside the harness's own sandbox, can a
// run write one file in a worktree? It starts no model and spends no tokens (D-023).
//
// A harness with no OS sandbox writes as the daemon user, which is what its runs do.
// Codex reads its sandbox mode from the adapter's argv. A sandboxed Codex runs the
// write through `codex sandbox`, with a fixed argv and no shell.
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { HarnessId } from "@harnessd/shared";
import { codexArgs } from "../adapters/codex.ts";
import { type Exec, firstLine, timedOut } from "./detect.ts";
import type { Check } from "./status.ts";

/** The file the check writes, and then deletes, in the scratch worktree. */
export const WORKTREE_WRITE_FILE = "harnessd-write-check";
/** How long a result is reused on the polling routes. Doctor and Start always run fresh. */
export const WORKTREE_WRITE_CACHE_MS = 10 * 60 * 1000;

interface CachedResult {
  check: Check;
  at: number;
}

const cache = new Map<string, CachedResult>();

function messageOf(error: unknown): string {
  return firstLine(error instanceof Error ? error.message : String(error));
}

/**
 * The sandbox mode the Codex adapter runs with, read from its fixed argv (D-032).
 * Codex is sandboxed by default, so an absent flag means workspace-write.
 */
export function codexSandboxMode(): string {
  const args = codexArgs({ id: "", title: "", prompt: "", budgetMs: 0 });
  const index = args.indexOf("--sandbox");
  const mode = index === -1 ? "" : (args[index + 1] ?? "");
  return mode.trim() === "" ? "workspace-write" : mode.trim();
}

/**
 * The built-in Codex permission profile that matches a sandbox mode. `:workspace`
 * makes the folder `-C` names writable. `:read-only` reports the denial the run
 * would meet. Any other sandboxed mode is checked as `:workspace`.
 */
export function codexSandboxProfile(mode: string): ":read-only" | ":workspace" {
  return mode === "read-only" ? ":read-only" : ":workspace";
}

/**
 * The fixed argv of the Codex sandbox check. `-C` names the scratch folder, so the
 * `:workspace` profile treats it as the writable root. No shell runs: `touch` is one argv.
 */
function codexSandboxArgv(mode: string, dir: string): string[] {
  return [
    "sandbox",
    "--permission-profile",
    codexSandboxProfile(mode),
    "-C",
    dir,
    "--",
    "/usr/bin/touch",
    join(dir, WORKTREE_WRITE_FILE),
  ];
}

export interface WorktreeWriteOptions {
  /** The check id, such as "harness.codex.worktree_write". */
  id: string;
  harness: HarnessId;
  /** The harness binary, which is part of the cache key. */
  bin: string;
  /** The harness version, which is part of the cache key. */
  version: string;
  /** The worktrees root the daemon uses. Default: `<globalDir>/worktrees`. */
  root: string;
  /** The folder name the scratch worktree is filed under, usually the repo name. */
  name: string;
  exec: Exec;
  /** Time left for the sandbox command, in ms. */
  timeoutMs: number;
  /** The environment for the sandbox command, as the adapter would get. Default: this process. */
  env?: NodeJS.ProcessEnv;
  /** Codex only: the mode from the adapter's argv. Undefined: no OS sandbox. */
  sandboxMode?: string;
  /** True: run the check, not the cache. Default true; the polling routes set false. */
  fresh?: boolean;
  /** Default Date.now. Tests move it to reach the cache's end. */
  now?: () => number;
}

async function checkWrite(options: WorktreeWriteOptions): Promise<Check> {
  const { id, root } = options;
  const sandboxed =
    options.sandboxMode !== undefined && options.sandboxMode !== "danger-full-access";
  const fix = sandboxed
    ? `Set Codex --sandbox danger-full-access (D-032), or make ${root} writable in the ${options.sandboxMode} sandbox.`
    : `Make ${root} writable by the daemon user.`;

  let dir: string | undefined;
  try {
    await mkdir(root, { recursive: true });
    dir = await mkdtemp(join(root, `${options.name}-check-`));
    const file = join(dir, WORKTREE_WRITE_FILE);

    if (sandboxed) {
      const result = await options.exec(
        options.bin,
        codexSandboxArgv(options.sandboxMode ?? "", dir),
        {
          cwd: dir,
          ...(options.env !== undefined ? { env: options.env } : {}),
          timeoutMs: options.timeoutMs,
        },
      );
      if (result.code !== 0) {
        const reason =
          result.code === 124
            ? timedOut(options.timeoutMs)
            : firstLine(result.stderr) || firstLine(result.stdout) || `exited ${result.code}`;
        return { id, state: "fail", detail: reason, fix };
      }
      // The command can succeed without leaving a file when the sandbox denies the write.
      await access(file);
    } else {
      await writeFile(file, "harnessd\n");
    }
    await rm(file, { force: true });

    const where = sandboxed ? ` (codex sandbox ${options.sandboxMode})` : "";
    return { id, state: "ok", detail: `wrote and deleted a file in ${root}${where}`, fix: "" };
  } catch (error) {
    return { id, state: "fail", detail: messageOf(error), fix };
  } finally {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Checks that one harness can write a file in a scratch worktree under the root.
 * A fresh check is the default. When `fresh` is false, a cached result is reused for
 * ten minutes per binary, version, root and mode.
 */
export async function worktreeWriteCheck(options: WorktreeWriteOptions): Promise<Check> {
  const key = [
    options.harness,
    options.bin,
    options.version,
    options.root,
    options.sandboxMode ?? "",
  ].join("\n");
  const now = (options.now ?? Date.now)();
  if (options.fresh === false) {
    const hit = cache.get(key);
    if (hit !== undefined && now - hit.at < WORKTREE_WRITE_CACHE_MS) {
      return hit.check;
    }
    cache.delete(key);
  }
  const result = await checkWrite(options);
  cache.set(key, { check: result, at: now });
  return result;
}
