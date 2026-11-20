// Small state files under the global folder: `~/.harnessd/state/` (or `$HARNESSD_HOME/state/`).
import { randomBytes } from "node:crypto";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** `<globalDir>/state`: machine-wide state such as the pause flag and the daemon's url. */
export function globalStateDir(globalDir: string): string {
  return join(globalDir, "state");
}

/**
 * Writes `value` as JSON: tmp file, fsync, rename, so readers see the old or the new
 * file, never half of one. The folder is created with a `.gitignore` of `*`.
 */
export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const dir = dirname(file);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, ".gitignore"), "*\n", { flag: "wx" }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const handle = await open(tmp, "w");
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
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
