// The native files an agent run sees (MET-55, docs/LOOP.md "What a run sees"). Before a
// part or QA agent starts, the loop runs `harnessd sync` into its worktree: the global
// layer, then the main repo's `.harnessd/`. The written files stay out of the agent's
// commits: untracked ones through a per-run excludes file passed in the run's env, tracked
// ones through `git update-index --skip-worktree` in that worktree only. The shared
// `.git/info/exclude` and the repo config are never touched.
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ResolvedAgentConfig } from "@harnessd/shared";
import { globalStateDir } from "../control/files.ts";
import { syncRepo } from "../sync/sync.ts";

const run = promisify(execFile);

export interface WorktreeSyncInput {
  /** The main repo: its `.harnessd/` is the workspace layer and holds the workspace vault. */
  repoDir: string;
  /** The global folder (`~/.harnessd` or `$HARNESSD_HOME`). The excludes file goes under its state/. */
  globalDir: string;
  /** Where the files are written. */
  worktree: string;
  /** Names the excludes file, e.g. the task id. */
  runId: string;
  /** The agent assigned to this run. */
  agent?: Pick<ResolvedAgentConfig, "opencode_permission">;
  /** The daemon's environment. Default process.env. */
  env?: NodeJS.ProcessEnv;
}

export interface WorktreeSyncResult {
  /** Paths sync wrote this time, relative to the worktree. */
  changed: string[];
  /** The run's excludes file. */
  excludesFile: string;
  /** Merge into the run's env: points `core.excludesFile` at `excludesFile`. */
  env: Record<string, string>;
}

async function git(cwd: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await run("git", ["-C", cwd, "--literal-pathspecs", ...args], {
    env,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

function expandHome(path: string, env: NodeJS.ProcessEnv): string {
  if (path === "~" || path.startsWith("~/")) return join(env.HOME ?? homedir(), path.slice(1));
  return path;
}

/** The owner's own excludes: `core.excludesFile`, else git's default `<XDG>/git/ignore`. */
async function ownerExcludes(worktree: string, env: NodeJS.ProcessEnv): Promise<string> {
  let path = (
    await git(worktree, ["config", "--path", "--get", "core.excludesFile"], env).catch(() => "")
  ).trim();
  if (path === "") {
    const xdg = env.XDG_CONFIG_HOME?.trim() || join(env.HOME ?? homedir(), ".config");
    path = join(xdg, "git", "ignore");
  }
  const text = await readFile(expandHome(path, env), "utf8").catch(() => "");
  return text === "" || text.endsWith("\n") ? text : `${text}\n`;
}

/** One excludes line that matches exactly `path`, from the worktree root. */
export function excludeLine(path: string): string {
  return `/${path.replace(/[\\*?[\]!# ]/g, (c) => `\\${c}`)}`;
}

/** `GIT_CONFIG_*` entries that set core.excludesFile after any the daemon already has. */
function excludesEnv(file: string, env: NodeJS.ProcessEnv): Record<string, string> {
  const count = Number.parseInt(env.GIT_CONFIG_COUNT ?? "", 10);
  const n = Number.isInteger(count) && count > 0 ? count : 0;
  return {
    GIT_CONFIG_COUNT: String(n + 1),
    [`GIT_CONFIG_KEY_${n}`]: "core.excludesFile",
    [`GIT_CONFIG_VALUE_${n}`]: file,
  };
}

/**
 * Syncs the merged native files into `worktree` and hides them from git for this run.
 * Throws when sync fails; the caller fails the run before the agent starts.
 */
export async function syncWorktree(input: WorktreeSyncInput): Promise<WorktreeSyncResult> {
  const env = input.env ?? process.env;
  // Read before the run's env exists, so this is the owner's own setting.
  const owner = await ownerExcludes(input.worktree, env);
  const { changed, paths } = await syncRepo({
    repoDir: input.worktree,
    workspaceDir: join(input.repoDir, ".harnessd"),
    globalDir: input.globalDir,
    ...(input.agent?.opencode_permission === undefined
      ? {}
      : { opencodePermission: input.agent.opencode_permission }),
  });

  const listed =
    paths.length === 0 ? "" : await git(input.worktree, ["ls-files", "-z", "--", ...paths], env);
  const tracked = new Set(listed.split("\0").filter(Boolean));
  const untracked = paths.filter((p) => !tracked.has(p));
  const hide = changed.filter((p) => tracked.has(p));
  if (hide.length > 0) {
    await git(input.worktree, ["update-index", "--skip-worktree", "--", ...hide], env);
  }

  const dir = join(globalStateDir(input.globalDir), "excludes");
  await mkdir(dir, { recursive: true });
  const excludesFile = join(dir, `${input.runId.replace(/[^A-Za-z0-9._-]/g, "_")}.gitignore`);
  const lines = untracked.map(excludeLine);
  await writeFile(
    excludesFile,
    `${owner}# harnessd: files sync wrote into ${input.worktree}\n${lines.join("\n")}\n`,
  );
  return { changed, excludesFile, env: excludesEnv(excludesFile, env) };
}
