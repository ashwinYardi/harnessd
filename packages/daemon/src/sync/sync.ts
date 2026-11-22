import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { OpenCodePermission } from "@harnessd/shared";
import { loadConfig } from "../config/load.ts";
import {
  CLAUDE_AGENTS_DIR,
  GENERATED_NOTE,
  generateSyncFiles,
  SKILL_ROOTS,
  type SyncFile,
} from "./generate.ts";
import { mergeSettings } from "./settings.ts";
import { type WritableFile, writeSyncFiles } from "./write.ts";

export interface SyncOptions {
  /** Where the native files land: the repo root, or a worktree of it. */
  repoDir: string;
  /**
   * The workspace layer, a `.harnessd/` folder. Default `<repoDir>/.harnessd`. The loop
   * sets it to the main repo's folder when it syncs into a worktree (MET-55); the
   * memory server then reads the vault of the repo that holds it.
   */
  workspaceDir?: string;
  /** The global folder (see `defaultGlobalDir`). Read only: sync never writes to it. */
  globalDir: string;
  /** Only used to print paths as `~/...` in errors. */
  home?: string;
  /** The run agent’s OpenCode permission overrides, when syncing a worktree. */
  opencodePermission?: OpenCodePermission;
}

export interface SyncResult {
  /** Repo-relative paths that were written; [] when everything was up to date. */
  changed: string[];
  /**
   * Skill folders and agent files left alone because sync did not generate them, such as
   * `.claude/skills/tdd` or `.claude/agents/impeccable-finish-reviewer.md`.
   */
  skipped: string[];
  /** Every repo-relative path sync owns in `repoDir`, written or already up to date. */
  paths: string[];
}

/** The skill folder a path belongs to, such as `.claude/skills/tdd`, or undefined. */
function skillFolder(path: string): string | undefined {
  for (const root of SKILL_ROOTS) {
    if (!path.startsWith(`${root}/`)) continue;
    const name = path.slice(root.length + 1).split("/")[0];
    return `${root}/${name}`;
  }
  return undefined;
}

/**
 * A skill folder is sync's own when it is absent or its SKILL.md has the generated note
 * right after the frontmatter.
 * Anything else (a hand-vendored skill, say) is never written into.
 */
async function isOwnSkillFolder(repoDir: string, folder: string): Promise<boolean> {
  const exists = await stat(join(repoDir, folder)).then(
    () => true,
    () => false,
  );
  if (!exists) return true;
  const md = await readFile(join(repoDir, folder, "SKILL.md"), "utf8").catch(() => "");
  // The note sits right after the frontmatter, exactly where skillMd puts it.
  return md.includes(`\n---\n<!-- ${GENERATED_NOTE} -->\n`);
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}

/** An agent file is sync's own when it is absent or has the generated note after its frontmatter. */
async function isOwnAgentFile(repoDir: string, path: string): Promise<boolean> {
  const text = await readOptional(join(repoDir, path));
  if (text === undefined) return true;
  const note = `<!-- ${GENERATED_NOTE} -->\n`;
  if (text.startsWith(note)) return true;
  // The note sits right after the frontmatter, exactly where agentMd puts it.
  const end = text.startsWith("---\n") ? text.indexOf("\n---\n", 3) : -1;
  return end !== -1 && text.startsWith(note, end + "\n---\n".length);
}

/** The unit sync owns or not: a skill folder, an agent file, or undefined for the rest. */
function ownedUnit(path: string): { unit: string; kind: "skill" | "agent" } | undefined {
  const folder = skillFolder(path);
  if (folder !== undefined) return { unit: folder, kind: "skill" };
  if (path.startsWith(`${CLAUDE_AGENTS_DIR}/`)) return { unit: path, kind: "agent" };
  return undefined;
}

async function dropForeign(repoDir: string, files: SyncFile[]) {
  const own = new Map<string, boolean>();
  const kept: SyncFile[] = [];
  for (const file of files) {
    const owned = ownedUnit(file.path);
    const folder = owned?.unit;
    if (folder !== undefined) {
      if (!own.has(folder)) {
        own.set(
          folder,
          owned?.kind === "agent"
            ? await isOwnAgentFile(repoDir, folder)
            : await isOwnSkillFolder(repoDir, folder),
        );
      }
      if (!own.get(folder)) continue;
    }
    kept.push(file);
  }
  const skipped = [...own].filter(([, mine]) => !mine).map(([folder]) => folder);
  return { files: kept, skipped };
}

/** Loads global + workspace config, generates every native file and writes what changed. */
export async function syncRepo(options: SyncOptions): Promise<SyncResult> {
  const ownLayer = join(options.repoDir, ".harnessd");
  const workspaceDir = options.workspaceDir ?? ownLayer;
  const isDir = await stat(workspaceDir).then(
    (s) => s.isDirectory(),
    () => false,
  );
  if (!isDir) {
    throw new Error(
      `harnessd sync: no .harnessd/ folder in ${dirname(workspaceDir)}. Create it (it may be empty) to let harnessd own AGENTS.md and the harness files here.`,
    );
  }
  const config = await loadConfig({
    globalDir: options.globalDir,
    workspaceDir,
    ...(options.home === undefined ? {} : { home: options.home }),
  });
  // Another repo's layer: point the memory server at that repo's vault.
  const elsewhere = resolve(workspaceDir) !== resolve(ownLayer);
  const generated = generateSyncFiles(config, {
    ...(elsewhere ? { memoryWorkspace: dirname(resolve(workspaceDir)) } : {}),
    ...(options.opencodePermission === undefined
      ? {}
      : { opencodePermission: options.opencodePermission }),
  });
  const { files, skipped } = await dropForeign(options.repoDir, generated);
  // Read every settings file before writing any, so a bad one stops sync with nothing written.
  const writable: WritableFile[] = [];
  for (const file of files) {
    if (!("settings" in file)) {
      writable.push(file);
      continue;
    }
    const existing = await readOptional(join(options.repoDir, file.path));
    writable.push({ path: file.path, content: mergeSettings(existing, file.settings, file.path) });
  }
  const changed = await writeSyncFiles(options.repoDir, writable);
  return { changed, skipped, paths: writable.map((f) => f.path) };
}
