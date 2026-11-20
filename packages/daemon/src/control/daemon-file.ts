// `~/.harnessd/state/daemon.json`: where the running daemon listens, so the CLI can reach it.
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { globalStateDir, writeJsonAtomic } from "./files.ts";

export interface DaemonInfo {
  /** Base url of the HTTP API, such as `http://127.0.0.1:4747`. */
  url: string;
  pid: number;
  startedAt: string;
}

export function daemonInfoPath(globalDir: string): string {
  return join(globalStateDir(globalDir), "daemon.json");
}

function isDaemonInfo(value: unknown): value is DaemonInfo {
  const v = value as Partial<DaemonInfo> | null;
  return (
    typeof v === "object" &&
    v !== null &&
    typeof v.url === "string" &&
    /^http:\/\//.test(v.url) &&
    typeof v.pid === "number" &&
    typeof v.startedAt === "string"
  );
}

export function writeDaemonInfo(globalDir: string, info: DaemonInfo): Promise<void> {
  return writeJsonAtomic(daemonInfoPath(globalDir), info);
}

/** The recorded daemon, or undefined when the file is missing or not valid. */
export async function readDaemonInfo(globalDir: string): Promise<DaemonInfo | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(daemonInfoPath(globalDir), "utf8"));
    return isDaemonInfo(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Removes daemon.json, but only while it still names this daemon (another may have started). */
export async function removeDaemonInfo(globalDir: string, info: DaemonInfo): Promise<void> {
  const current = await readDaemonInfo(globalDir);
  if (current === undefined || current.url !== info.url || current.pid !== info.pid) return;
  await rm(daemonInfoPath(globalDir), { force: true });
}
