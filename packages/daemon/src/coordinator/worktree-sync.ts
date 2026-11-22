// The native files an agent run sees (MET-55, docs/LOOP.md "What a run sees"). Before a
// part or QA agent starts, the loop runs `harnessd sync` into its worktree: the global
// layer, then the main repo's `.harnessd/`. The written files stay out of the agent's
// commits: untracked ones through a per-run excludes file passed in the run's env, tracked
// ones through `git update-index --skip-worktree` in that worktree only. The shared
// `.git/info/exclude` and the repo config are never touched. A skill the run's role leaves
// out is removed from the worktree, committed or not, and the removal is hidden the same
// way (D-040).
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { ResolvedAgentConfig } from "@harnessd/shared";
import { globalStateDir } from "../control/files.ts";
import { SKILL_ROOTS } from "../sync/generate.ts";
import { syncRepo } from "../sync/sync.ts";
import { excludesEnv } from "../worktrees/excludes.ts";

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
  agent?: Pick<ResolvedAgentConfig, "opencode_permission" | "role">;
  /** The daemon's environment. Default process.env. */
  env?: NodeJS.ProcessEnv;
}

export interface WorktreeSyncResult {
  /** Paths sync wrote this time, relative to the worktree. */
  changed: string[];
  /** Skill folders this run removed from the worktree, relative to it (D-040). */
  removed: string[];
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

/** Where a run's excludes file lives. It needs no sync, so the loop can save it first. */
export function excludesFileFor(globalDir: string, runId: string): string {
  return join(
    globalStateDir(globalDir),
    "excludes",
    `${runId.replace(/[^A-Za-z0-9._-]/g, "_")}.gitignore`,
  );
}

/** Skill names a non-UI worktree run leaves out of the pack. The UI agent gets the full pack. */
export const SKILLS_WITHHELD_FROM_NON_UI_RUNS = ["impeccable"] as const;

/**
 * Skills only the coordinator uses (D-043). Builder and QA runs never grill, model the
 * domain, research or prototype, so their turn does not carry those bodies.
 */
export const SKILLS_WITHHELD_FROM_NON_COORDINATOR_RUNS = [
  "grilling",
  "domain-modeling",
  "research",
  "prototype",
] as const;

/** Builder and QA runs do not grill; the coordinator does (D-044). */
export const SKILLS_WITHHELD_FROM_NON_COORDINATOR_READING = ["grill-with-docs"] as const;

/** QA reviews; every other role drops code-review (D-044). */
export const SKILLS_WITHHELD_FROM_NON_QA_RUNS = ["code-review"] as const;

/** Every skill a worktree run can leave out, so a run that does not withhold it can put it back. */
const RESTORABLE_SKILLS = [
  ...SKILLS_WITHHELD_FROM_NON_UI_RUNS,
  ...SKILLS_WITHHELD_FROM_NON_COORDINATOR_RUNS,
  ...SKILLS_WITHHELD_FROM_NON_COORDINATOR_READING,
  ...SKILLS_WITHHELD_FROM_NON_QA_RUNS,
];

/** The skills a run with this role omits (D-040, D-043, D-044). No config key: `enabled = false` still wins. */
export function withheldSkills(role: ResolvedAgentConfig["role"] | undefined): string[] {
  // D-040: only the frontend role does UI work. D-043: only the coordinator grills.
  // D-044: only QA reviews; builders and the coordinator do not carry code-review.
  if (role === "frontend") {
    return [
      ...SKILLS_WITHHELD_FROM_NON_COORDINATOR_RUNS,
      ...SKILLS_WITHHELD_FROM_NON_COORDINATOR_READING,
      ...SKILLS_WITHHELD_FROM_NON_QA_RUNS,
    ];
  }
  if (role === "coordinator") {
    return [...SKILLS_WITHHELD_FROM_NON_UI_RUNS, ...SKILLS_WITHHELD_FROM_NON_QA_RUNS];
  }
  if (role === "qa") {
    return RESTORABLE_SKILLS.filter((name) => name !== "code-review");
  }
  return [...RESTORABLE_SKILLS];
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/** Every file git tracks under `folder`, so its removal can stay invisible. */
async function trackedUnder(
  worktree: string,
  folder: string,
  env: NodeJS.ProcessEnv,
): Promise<string[]> {
  const listed = await git(worktree, ["ls-files", "-z", "--", folder], env);
  return listed.split("\0").filter(Boolean);
}

/**
 * Removes a withheld skill folder from the worktree, committed or not (D-040). A worktree
 * cut from `main` already holds the skill folders the repo commits, so leaving the skill
 * off the generated pack is not enough. The main checkout is never touched.
 */
async function withholdSkill(
  worktree: string,
  folder: string,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  if (!(await exists(join(worktree, folder)))) return undefined;
  const tracked = await trackedUnder(worktree, folder, env);
  if (tracked.length > 0) {
    await git(worktree, ["update-index", "--skip-worktree", "--", ...tracked], env);
  }
  await rm(join(worktree, folder), { recursive: true, force: true });
  return folder;
}

/**
 * Puts back a committed skill folder that an earlier withheld run removed, so a frontend
 * run that reuses the worktree gets the full pack again.
 */
async function restoreSkill(
  worktree: string,
  folder: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  if (await exists(join(worktree, folder))) return;
  const tracked = await trackedUnder(worktree, folder, env);
  if (tracked.length === 0) return;
  // The files stay skip-worktree: they equal HEAD, so git sees no change either way.
  await git(
    worktree,
    ["checkout-index", "-f", "--ignore-skip-worktree-bits", "--", ...tracked],
    env,
  );
}

/** Builder roles get the OpenCode compaction and tool-output cap (D-045). */
export function isBuilderRole(role: ResolvedAgentConfig["role"] | undefined): boolean {
  return role === "backend" || role === "frontend";
}

/**
 * Syncs the merged native files into `worktree` and hides them from git for this run.
 * Throws when sync fails; the caller fails the run before the agent starts.
 */
export async function syncWorktree(input: WorktreeSyncInput): Promise<WorktreeSyncResult> {
  const env = input.env ?? process.env;
  // Read before the run's env exists, so this is the owner's own setting.
  const owner = await ownerExcludes(input.worktree, env);
  const withheld = withheldSkills(input.agent?.role);
  // Before sync: a full-pack run may reuse a worktree that a withheld run cut down.
  for (const name of RESTORABLE_SKILLS) {
    if (withheld.includes(name)) continue;
    for (const root of SKILL_ROOTS) await restoreSkill(input.worktree, `${root}/${name}`, env);
  }
  const { changed, paths } = await syncRepo({
    repoDir: input.worktree,
    workspaceDir: join(input.repoDir, ".harnessd"),
    globalDir: input.globalDir,
    omitSkills: withheld,
    memoryMcpOnly: true,
    ...(isBuilderRole(input.agent?.role) ? { builderLimits: true } : {}),
    ...(input.agent?.opencode_permission === undefined
      ? {}
      : { opencodePermission: input.agent.opencode_permission }),
  });
  // After sync: remove the folders that are already in the worktree, committed or generated.
  const removed: string[] = [];
  for (const name of withheld) {
    for (const root of SKILL_ROOTS) {
      const folder = await withholdSkill(input.worktree, `${root}/${name}`, env);
      if (folder !== undefined) removed.push(folder);
    }
  }

  const listed =
    paths.length === 0 ? "" : await git(input.worktree, ["ls-files", "-z", "--", ...paths], env);
  const tracked = new Set(listed.split("\0").filter(Boolean));
  const untracked = paths.filter((p) => !tracked.has(p));
  const hide = changed.filter((p) => tracked.has(p));
  if (hide.length > 0) {
    await git(input.worktree, ["update-index", "--skip-worktree", "--", ...hide], env);
  }

  const excludesFile = excludesFileFor(input.globalDir, input.runId);
  await mkdir(dirname(excludesFile), { recursive: true });
  const lines = untracked.map(excludeLine);
  await writeFile(
    excludesFile,
    `${owner}# harnessd: files sync wrote into ${input.worktree}\n${lines.join("\n")}\n`,
  );
  return { changed, removed, excludesFile, env: excludesEnv(excludesFile, env) };
}
