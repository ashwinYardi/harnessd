import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readlink,
  rename,
  rm,
  stat as statFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { SyncFile } from "./generate.ts";

/** A file whose bytes are known: sync resolves merged settings files before writing. */
export type WritableFile = Exclude<SyncFile, { settings: unknown }>;

function inside(root: string, path: string): string {
  const full = resolve(root, path);
  const rel = relative(root, full);
  if (rel === "" || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) {
    throw new Error(`harnessd sync: refusing to write outside ${root}: ${path}`);
  }
  return full;
}

async function lstatOptional(path: string) {
  try {
    return await lstat(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}

/**
 * Writes `files` under `root`, touching only those whose content or link target
 * differs. Returns the changed paths in input order; an up-to-date tree gives [].
 * Files are written via a temp file and rename, so a reader never sees half a file.
 */
export async function writeSyncFiles(
  root: string,
  files: readonly WritableFile[],
): Promise<string[]> {
  const changed: string[] = [];
  for (const file of files) {
    const full = inside(root, file.path);
    const stat = await lstatOptional(full);
    if (stat?.isDirectory()) {
      throw new Error(`harnessd sync: ${file.path} is a directory, expected a file`);
    }

    if ("symlinkTarget" in file) {
      if (stat?.isSymbolicLink() && (await readlink(full)) === file.symlinkTarget) continue;
      await mkdir(dirname(full), { recursive: true });
      if (stat !== undefined) await rm(full);
      await symlink(file.symlinkTarget, full);
    } else {
      let content: string | Buffer;
      let mode: number | undefined;
      if ("copyFrom" in file) {
        content = await readFile(file.copyFrom);
        mode = (await statFile(file.copyFrom)).mode & 0o777;
        const same =
          stat?.isFile() && (stat.mode & 0o777) === mode && content.equals(await readFile(full));
        if (same) continue;
      } else {
        content = file.content;
        if (stat?.isFile() && (await readFile(full, "utf8")) === content) continue;
      }
      await mkdir(dirname(full), { recursive: true });
      // A symlink here would make writeFile follow it; replace the link itself.
      if (stat?.isSymbolicLink()) await rm(full);
      const tmp = `${full}.harnessd-tmp`;
      await writeFile(tmp, content);
      if (mode !== undefined) await chmod(tmp, mode);
      await rename(tmp, full);
    }
    changed.push(file.path);
  }
  return changed;
}
