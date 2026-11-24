// The product a QA review runs (MET-178, D-051). For each review harnessd runs `build` and
// `seed` in the QA worktree, picks a free port, starts the app with PORT set and waits for
// `health`. The start runs in its own process group, and the whole tree is stopped at teardown
// with the same tree kill as a run (D-048).
//
// The app's commands get a small environment only: the base names, PORT, HARNESSD_QA_AREA and
// the names `qa.env` lists, taken from the daemon's environment. The daemon's own secrets
// never reach the product unless the repo names them.
import { type ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:net";
import type { QaConfig, QaKind } from "@harnessd/shared";
import { killProcessTree, stopTrackingProcess, trackProcess } from "../adapters/process.ts";
import { maskEnvSecrets } from "../status/status.ts";
import { type CommandResult, runShellCommand } from "./qa.ts";

/** The step that failed: each is a QA setup error (D-041, D-051). */
export type QaAppStep = "build" | "seed" | "start" | "health";

/** Health is polled once a second for this long (D-051). */
export const APP_HEALTH_TIMEOUT_MS = 2 * 60_000;
/** Each health probe has this limit. */
export const APP_PROBE_TIMEOUT_MS = 5_000;
export const APP_POLL_MS = 1_000;
/** Time between SIGTERM and SIGKILL when the app is stopped (D-048). */
export const APP_KILL_GRACE_MS = 5_000;
/** Build and seed get the round's remaining budget; this bounds them without one. */
export const APP_STEP_TIMEOUT_MS = 10 * 60_000;
/** The tail kept per command, as for checks. */
export const MAX_APP_OUTPUT = 64 * 1024;

/** The names every app command gets from the daemon's environment (D-051). */
export const BASE_APP_ENV = ["PATH", "HOME", "USER", "SHELL", "TMPDIR", "LANG", "TERM"] as const;

export interface QaAppInput {
  /** The repo's `[qa]` table; `kind` is set for a live review. */
  qa: QaConfig;
  /** The QA worktree. */
  cwd: string;
  /** `HARNESSD_QA_AREA`: the part's role. */
  area: "backend" | "frontend";
  /** The round's remaining budget, which bounds build, seed and health (D-014). */
  budgetMs?: number;
  /** Where `qa.env` names are read from; default the daemon's environment. */
  env?: NodeJS.ProcessEnv;
  /** One line for each `qa.env` name that is not set. */
  log?: (line: string) => void;
  /** Test hooks. */
  run?: typeof runShellCommand;
  now?: () => number;
  healthTimeoutMs?: number;
  probeTimeoutMs?: number;
  pollMs?: number;
  graceMs?: number;
  signal?: AbortSignal;
}

/** A running app, and how to stop it. */
export interface QaApp {
  kind?: QaKind;
  /** The url with `{port}` replaced; unset for a cli. */
  url?: string;
  port?: number;
  stop: () => Promise<void>;
}

export type QaAppStart =
  | { ok: true; app: QaApp }
  | {
      ok: false;
      step: QaAppStep;
      /** The last 5 masked output lines, joined by " | ". */
      detail: string;
      error?: string;
    };

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The environment build, seed, start and health get (D-051). */
export function appEnvironment(
  qa: Pick<QaConfig, "env">,
  area: "backend" | "frontend",
  env: NodeJS.ProcessEnv = process.env,
  log?: (line: string) => void,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of BASE_APP_ENV) {
    const value = env[name];
    if (value !== undefined) out[name] = value;
  }
  out.HARNESSD_QA_AREA = area;
  for (const name of qa.env ?? []) {
    const value = env[name];
    if (value === undefined) {
      log?.(`qa.env ${name} is not set, skipped`);
      continue;
    }
    out[name] = value;
  }
  return out;
}

/** Listens on 127.0.0.1 port 0 and returns the port it got. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => {
        if (port > 0) resolve(port);
        else reject(new Error("could not pick a free port"));
      });
    });
  });
}

/** The last `count` output lines, masked and joined by " | ", as the log line shows them. */
export function lastOutputLines(output: string, env: NodeJS.ProcessEnv, count = 5): string {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .slice(-count);
  const text = maskEnvSecrets(lines.join(" | "), env);
  return text === "" ? "(no output)" : text;
}

interface AppProcess {
  child: ChildProcess;
  output: () => string;
  exit: () => { code: number | null; signal: NodeJS.Signals | null } | undefined;
}

function launch(
  command: string,
  cwd: string,
  env: Record<string, string>,
): { proc: AppProcess } | { error: string } {
  let child: ChildProcess;
  try {
    // detached: the app leads its own process group, so the whole tree can be signalled.
    child = spawn("sh", ["-c", command], {
      cwd,
      detached: true,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    return { error: message(error) };
  }
  let output = "";
  const append = (chunk: string) => {
    output = (output + chunk).slice(-MAX_APP_OUTPUT);
  };
  child.stdout?.setEncoding("utf8").on("data", append);
  child.stderr?.setEncoding("utf8").on("data", append);
  let spawnError: string | undefined;
  child.on("error", (error) => {
    spawnError = message(error);
  });
  let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  child.on("exit", (code, signal) => {
    exited = { code, signal };
  });
  if (child.pid === undefined) return { error: spawnError ?? "the process did not start" };
  // Registered so a daemon exit stops the app too (D-048, MET-178).
  trackProcess(child);
  return { proc: { child, output: () => output, exit: () => exited } };
}

async function stopProcess(proc: AppProcess, graceMs: number): Promise<void> {
  const pid = proc.child.pid;
  try {
    // The group kill still reaches descendants that outlived a root that already exited.
    if (pid !== undefined) await killProcessTree(pid, graceMs);
  } finally {
    stopTrackingProcess(pid);
    proc.child.stdout?.destroy();
    proc.child.stderr?.destroy();
  }
}

function passed(result: CommandResult): boolean {
  return result.exitCode === 0 && !result.timedOut && result.error === undefined;
}

function describeCommand(result: CommandResult, timeoutMs: number): string {
  if (result.error !== undefined) return result.error;
  if (result.timedOut) return `timed out after ${Math.round(timeoutMs / 1000)}s`;
  return `exited with code ${result.exitCode ?? "null (killed)"}`;
}

/** A health value that starts with "/" is a path; anything else is a shell command (D-051). */
function isHealthPath(health: string): boolean {
  return health.startsWith("/");
}

async function probeUrl(url: string, timeoutMs: number): Promise<boolean> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
      redirect: "manual",
    });
    void res.body?.cancel().catch(() => {});
    return res.status >= 200 && res.status < 400;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(1, ms));
  });
}

/**
 * Runs the lifecycle for one review: build, seed, a free port, start and health. A step that
 * fails returns the step and its last output lines; the caller turns it into a setup error
 * (D-041). The app is stopped before a failure returns, and by `stop` on success.
 */
export async function startQaApp(input: QaAppInput): Promise<QaAppStart> {
  const { qa, cwd, area } = input;
  const kind = qa.kind;
  const daemonEnv = input.env ?? process.env;
  const log = input.log ?? (() => {});
  const run = input.run ?? runShellCommand;
  const now = input.now ?? Date.now;
  const probeTimeoutMs = input.probeTimeoutMs ?? APP_PROBE_TIMEOUT_MS;
  const pollMs = input.pollMs ?? APP_POLL_MS;
  const graceMs = input.graceMs ?? APP_KILL_GRACE_MS;
  const budget = input.budgetMs ?? APP_STEP_TIMEOUT_MS;
  const deadline = now() + Math.max(budget, 1);
  const env = appEnvironment(qa, area, daemonEnv, log);
  const noop: QaApp = { ...(kind === undefined ? {} : { kind }), stop: async () => {} };

  const failed = (step: QaAppStep, result: CommandResult, timeoutMs: number): QaAppStart => ({
    ok: false,
    step,
    detail: lastOutputLines(result.output, daemonEnv),
    error: describeCommand(result, timeoutMs),
  });

  /** Build and seed run before the port is picked; they get no PORT. */
  for (const step of ["build", "seed"] as const) {
    const command = qa[step]?.trim();
    if (command === undefined || command === "") continue;
    const stepTimeout = Math.max(deadline - now(), 1);
    const result = await run(command, cwd, stepTimeout, input.signal, env);
    if (input.signal?.aborted === true)
      return { ok: false, step, detail: "cancelled", error: "cancelled" };
    if (!passed(result)) return failed(step, result, stepTimeout);
  }

  // A cli is a command QA calls, not a server: harnessd runs no start and no port (MET-177).
  if (kind === "cli") {
    const health = qa.health?.trim();
    if (health !== undefined && health !== "") {
      const timeout = Math.max(deadline - now(), 1);
      const result = await run(health, cwd, timeout, input.signal, env);
      if (!passed(result)) return failed("health", result, timeout);
    }
    return { ok: true, app: noop };
  }
  if (kind === undefined) return { ok: true, app: noop };

  const urlTemplate = qa.url ?? "";
  const commandTemplate = qa.start ?? "";
  if (urlTemplate === "" || commandTemplate === "") {
    return {
      ok: false,
      step: "start",
      detail: "(no output)",
      error: "qa.start and qa.url are required for a live app",
    };
  }
  // Validate the url once; the real origin is taken after the port is picked.
  try {
    new URL(urlTemplate.replaceAll("{port}", "1"));
  } catch (error) {
    return { ok: false, step: "start", detail: "(no output)", error: `qa.url: ${message(error)}` };
  }
  let port: number;
  try {
    port = await freePort();
  } catch (error) {
    return { ok: false, step: "start", detail: "(no output)", error: message(error) };
  }
  const url = urlTemplate.replaceAll("{port}", String(port));
  const command = commandTemplate.replaceAll("{port}", String(port));
  const appEnv = { ...env, PORT: String(port) };
  const launched = launch(command, cwd, appEnv);
  if ("error" in launched) {
    return { ok: false, step: "start", detail: "(no output)", error: launched.error };
  }
  const proc = launched.proc;
  const started: QaApp = {
    kind,
    url,
    port,
    stop: async () => {
      await stopProcess(proc, graceMs);
    },
  };

  const health = (qa.health ?? "").trim();
  const healthTimeout =
    input.healthTimeoutMs ?? Math.min(APP_HEALTH_TIMEOUT_MS, Math.max(deadline - now(), 1));
  const healthDeadline = now() + healthTimeout;
  const healthUrl = isHealthPath(health) ? `${new URL(url).origin}${health}` : undefined;
  if (healthUrl === undefined && health === "") return { ok: true, app: started };

  for (;;) {
    if (input.signal?.aborted === true) {
      await started.stop();
      return { ok: false, step: "health", detail: "cancelled", error: "cancelled" };
    }
    const exit = proc.exit();
    if (exit !== undefined) {
      await started.stop();
      return {
        ok: false,
        step: "start",
        detail: lastOutputLines(proc.output(), daemonEnv),
        error:
          exit.code !== null
            ? `exited with code ${exit.code}`
            : `exited on ${exit.signal ?? "a signal"}`,
      };
    }
    const passedProbe =
      healthUrl !== undefined
        ? await probeUrl(healthUrl, probeTimeoutMs)
        : passed(await run(health, cwd, probeTimeoutMs, input.signal, appEnv));
    if (passedProbe) return { ok: true, app: started };
    // The app may have died while the probe ran; that is a start failure, not a timeout.
    const late = proc.exit();
    if (late !== undefined) {
      await started.stop();
      return {
        ok: false,
        step: "start",
        detail: lastOutputLines(proc.output(), daemonEnv),
        error:
          late.code !== null
            ? `exited with code ${late.code}`
            : `exited on ${late.signal ?? "a signal"}`,
      };
    }
    const left = healthDeadline - now();
    if (left <= 0) {
      await started.stop();
      return {
        ok: false,
        step: "health",
        detail: lastOutputLines(proc.output(), daemonEnv),
        error: `did not pass within ${Math.round(healthTimeout / 1000)}s`,
      };
    }
    await sleep(Math.min(pollMs, left));
  }
}
