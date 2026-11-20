// `harnessd pause` and `harnessd resume`: the global kill switch (D-014). See docs/LOOP.md.
//
// The flag file is written first, so it applies even with no daemon running. Then the
// running daemon, if daemon.json names one, is told over HTTP so the effect is immediate.
import {
  createFilePauseStore,
  defaultGlobalDir,
  type PauseResult,
  pauseStatePath,
  readDaemonInfo,
} from "@harnessd/daemon";

export const PAUSE_USAGE = "Usage: harnessd pause [--reason <text>]";
export const RESUME_USAGE = "Usage: harnessd resume";

/** Long enough for a SIGKILL after the 5 s grace, plus the Linear updates. */
export const DAEMON_REQUEST_TIMEOUT_MS = 20_000;

export interface PauseIO {
  out: (line: string) => void;
  err: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  /** Defaults to the global fetch. */
  fetch?: typeof fetch;
}

/** Parses `pause` arguments; a string is a usage error. */
export function parsePauseArgs(args: readonly string[]): { reason?: string } | string {
  if (args.length === 0) return {};
  if (args[0] !== "--reason") return `unexpected argument "${args[0]}"`;
  const reason = args[1];
  if (reason === undefined || reason.trim() === "") return "--reason: expected text";
  if (args.length > 2) return `unexpected argument "${args[2]}"`;
  return { reason };
}

type Reply = { ok: true; body: unknown } | { ok: false; why: string } | undefined;

/** POSTs to the daemon named by daemon.json. undefined: no daemon is recorded. */
async function tellDaemon(
  io: PauseIO,
  globalDir: string,
  path: string,
  body: object,
): Promise<Reply> {
  const info = await readDaemonInfo(globalDir);
  if (info === undefined) return undefined;
  try {
    const res = await (io.fetch ?? fetch)(`${info.url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(DAEMON_REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, why: `${info.url} answered ${res.status}` };
    return { ok: true, body: await res.json() };
  } catch (error) {
    const cause = (error as { cause?: { code?: string } }).cause?.code;
    // A refused connection is a daemon that stopped without cleaning up: none is running.
    if (cause === "ECONNREFUSED") return undefined;
    return { ok: false, why: `${info.url} did not answer: ${(error as Error).message}` };
  }
}

function runs(n: number): string {
  return n === 1 ? "1 run" : `${n} runs`;
}

export async function runPause(args: readonly string[], io: PauseIO): Promise<number> {
  const parsed = parsePauseArgs(args);
  if (typeof parsed === "string") {
    io.err(`harnessd pause: ${parsed}`);
    io.err(PAUSE_USAGE);
    return 2;
  }
  const globalDir = defaultGlobalDir(io.env);
  try {
    await createFilePauseStore(globalDir).pause(parsed.reason);
  } catch (error) {
    io.err(
      `harnessd pause: could not write ${pauseStatePath(globalDir)}: ${(error as Error).message}`,
    );
    return 1;
  }
  const reply = await tellDaemon(io, globalDir, "/api/pause", parsed);
  if (reply === undefined) {
    io.out("Paused. No daemon running; the flag applies at the next start.");
  } else if (!reply.ok) {
    io.out(`Paused. Could not tell the daemon (${reply.why}); it stops its runs within 10 s.`);
  } else {
    const cancelled = (reply.body as Partial<PauseResult>).cancelled ?? 0;
    io.out(`Paused. ${runs(cancelled)} cancelled; worktrees kept.`);
  }
  return 0;
}

export async function runResume(args: readonly string[], io: PauseIO): Promise<number> {
  if (args.length > 0) {
    io.err(`harnessd resume: unexpected argument "${args[0]}"`);
    io.err(RESUME_USAGE);
    return 2;
  }
  const globalDir = defaultGlobalDir(io.env);
  try {
    await createFilePauseStore(globalDir).resume();
  } catch (error) {
    io.err(
      `harnessd resume: could not remove ${pauseStatePath(globalDir)}: ${(error as Error).message}`,
    );
    return 1;
  }
  const reply = await tellDaemon(io, globalDir, "/api/resume", {});
  if (reply === undefined) io.out("Resumed. No daemon running.");
  else if (!reply.ok)
    io.out(`Resumed. Could not tell the daemon (${reply.why}); it dispatches at its next tick.`);
  else io.out("Resumed.");
  return 0;
}
