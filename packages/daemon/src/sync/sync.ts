import { stat } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../config/load.ts";
import { generateSyncFiles } from "./generate.ts";
import { writeSyncFiles } from "./write.ts";

export interface SyncOptions {
  /** Repo root; its `.harnessd/` is the workspace layer and native files land here. */
  repoDir: string;
  /** The global folder (see `defaultGlobalDir`). Read only: sync never writes to it. */
  globalDir: string;
  /** Only used to print paths as `~/...` in errors. */
  home?: string;
}

export interface SyncResult {
  /** Repo-relative paths that were written; [] when everything was up to date. */
  changed: string[];
}

/** Loads global + workspace config, generates every native file and writes what changed. */
export async function syncRepo(options: SyncOptions): Promise<SyncResult> {
  const workspaceDir = join(options.repoDir, ".harnessd");
  const isDir = await stat(workspaceDir).then(
    (s) => s.isDirectory(),
    () => false,
  );
  if (!isDir) {
    throw new Error(
      `harnessd sync: no .harnessd/ folder in ${options.repoDir}. Create it (it may be empty) to let harnessd own AGENTS.md and the harness files here.`,
    );
  }
  const config = await loadConfig({
    globalDir: options.globalDir,
    workspaceDir,
    ...(options.home === undefined ? {} : { home: options.home }),
  });
  return { changed: await writeSyncFiles(options.repoDir, generateSyncFiles(config)) };
}
