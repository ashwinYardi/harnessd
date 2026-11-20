// Finds a CLI on PATH and reads its version. Shared by `harnessd init` and the status
// engine, so both see the same binary (MET-27).
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, join } from "node:path";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Kills the command after this many ms and returns code 124. */
  timeoutMs?: number;
}

/** Runs one command without a shell. A command that cannot start returns code 127. */
export type Exec = (
  cmd: string,
  args: readonly string[],
  options?: ExecOptions,
) => Promise<ExecResult>;

/** PATH entries npx adds for its own run; a service must not depend on them. */
export function isTransientDir(dir: string): boolean {
  return dir.includes("/_npx/") || dir.includes("/node_modules/.bin");
}

export function pathDirs(env: NodeJS.ProcessEnv): string[] {
  return (env.PATH ?? "").split(delimiter).filter((d) => d !== "");
}

export function isExecutableFile(path: string): Promise<boolean> {
  return access(path, constants.X_OK).then(
    () => true,
    () => false,
  );
}

/** Finds `bin` on PATH, skipping npx's temporary folders. */
export async function findOnPath(
  env: NodeJS.ProcessEnv,
  bin: string,
  isExecutable: (path: string) => Promise<boolean> = isExecutableFile,
): Promise<string | undefined> {
  for (const dir of pathDirs(env)) {
    if (isTransientDir(dir)) continue;
    const candidate = join(dir, bin);
    if (await isExecutable(candidate)) return candidate;
  }
  return undefined;
}

/** The first non-empty line of `<path> --version`, or undefined when it fails. */
export async function readVersion(
  exec: Exec,
  path: string,
  options?: ExecOptions,
): Promise<string | undefined> {
  const res = await exec(path, ["--version"], options);
  const line = `${res.stdout}\n${res.stderr}`.split("\n").find((l) => l.trim() !== "");
  return res.code === 0 && line ? line.trim() : undefined;
}

/** The first `x.y.z` in a version line, such as "2.1.3 (Claude Code)". */
export function parseSemver(text: string): [number, number, number] | undefined {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

/** Negative when a < b, 0 when equal, positive when a > b. */
export function compareSemver(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number {
  for (let i = 0; i < 3; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** The real `Exec`: output is captured, never streamed, and the child is killed on timeout. */
export const execFile: Exec = (cmd, args, options = {}) =>
  new Promise((done) => {
    const child = spawn(cmd, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (r: ExecResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      done(r);
    };
    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            child.kill("SIGKILL");
            finish({ code: 124, stdout, stderr: `timed out after ${options.timeoutMs} ms` });
          }, options.timeoutMs);
    child.stdout?.on("data", (d) => {
      stdout += d;
    });
    child.stderr?.on("data", (d) => {
      stderr += d;
    });
    child.on("error", (e) => finish({ code: 127, stdout, stderr: e.message }));
    child.on("close", (code) => finish({ code: code ?? 1, stdout, stderr }));
  });
