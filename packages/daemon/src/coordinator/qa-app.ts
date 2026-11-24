// The product a QA review runs (MET-178, D-051). For each review harnessd runs `build` and
// `seed` in the QA worktree, picks a free port, starts the app with PORT set and waits for
// `health`. A web review also gets a headless browser on a free loopback debug port
// (MET-179). Both run in their own process group, and the whole tree is stopped at teardown
// with the same tree kill as a run (D-048).
//
// The app's commands get a small environment only: the base names, PORT, HARNESSD_QA_AREA and
// the names `qa.env` lists, taken from the daemon's environment. The daemon's own secrets
// never reach the product unless the repo names them.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { QaConfig, QaKind } from "@harnessd/shared";
import { killProcessTree, stopTrackingProcess, trackProcess } from "../adapters/process.ts";
import { findOnPath, isExecutableFile } from "../status/detect.ts";
import { maskEnvSecrets } from "../status/status.ts";
import { type CommandResult, runShellCommand } from "./qa.ts";

/** The step that failed: each is a QA setup error (D-041, D-051). */
export type QaAppStep = "build" | "seed" | "start" | "health" | "browser";

/** How long a browser may take to answer on its debug port. */
export const BROWSER_TIMEOUT_MS = 30_000;
/** How often the browser's debug port is polled. */
export const BROWSER_POLL_MS = 250;
/** The fix named when no browser is found or one does not start (MET-179). */
export const BROWSER_FIX =
  "install Google Chrome, or a Playwright Chromium with `pnpm exec playwright install chromium`";

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
  /** Finds a browser executable; a test injects one (web only). */
  findBrowser?: (env: NodeJS.ProcessEnv) => Promise<string | undefined>;
  /** Launches the headless browser; a test injects one (web only). */
  launchBrowser?: (options: BrowserLaunchOptions) => Promise<QaBrowserStart>;
  browserTimeoutMs?: number;
  browserPollMs?: number;
  signal?: AbortSignal;
}

/** A running app, and how to stop it. */
export interface QaApp {
  kind?: QaKind;
  /** The url with `{port}` replaced; unset for a cli. */
  url?: string;
  port?: number;
  /** The browser's CDP endpoint for a web review; the QA run gets it in HARNESSD_QA_BROWSER. */
  browser?: string;
  stop: () => Promise<void>;
}

/** The headless browser a web review drives over CDP. */
export interface QaBrowser {
  /** `http://127.0.0.1:<port>`, the DevTools endpoint. */
  endpoint: string;
  stop: () => Promise<void>;
}

export interface BrowserLaunchOptions {
  executable: string;
  /** The free loopback port the browser listens on. */
  port: number;
  /** A temporary Chrome profile, removed when the browser stops. */
  profileDir: string;
  /** The daemon's environment, for masking output. */
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  pollMs?: number;
  graceMs?: number;
  signal?: AbortSignal;
}

/** A started browser, or the last output lines plus the fix (or the timeout). */
export type QaBrowserStart =
  | { ok: true; browser: QaBrowser }
  | { ok: false; detail: string; error: string };

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

/** The command names an installed Google Chrome or Chromium may use on PATH. */
export const CHROME_BIN_NAMES = [
  "google-chrome",
  "google-chrome-stable",
  "chromium",
  "chromium-browser",
] as const;

/** Where an installed Google Chrome may sit, before PATH is searched. */
export function chromeCandidates(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string[] {
  if (platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      join(home, "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
    ];
  }
  if (platform === "win32") {
    const roots = [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA].filter(
      (root): root is string => root !== undefined && root !== "",
    );
    return roots.map((root) => join(root, "Google", "Chrome", "Application", "chrome.exe"));
  }
  return [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
  ];
}

/** The Playwright browser cache: `PLAYWRIGHT_BROWSERS_PATH`, then the platform default. */
export function playwrightCacheDir(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const override = env.PLAYWRIGHT_BROWSERS_PATH?.trim();
  if (override !== undefined && override !== "") return override;
  if (platform === "darwin") return join(home, "Library", "Caches", "ms-playwright");
  if (platform === "win32") {
    return join(env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "ms-playwright");
  }
  return join(env.XDG_CACHE_HOME ?? join(home, ".cache"), "ms-playwright");
}

/** Executables inside one Playwright Chromium folder, by platform. */
function chromiumExecutables(dir: string, platform: NodeJS.Platform): string[] {
  if (platform === "darwin") {
    const arches = ["chrome-mac-arm64", "chrome-mac-x64", "chrome-mac"];
    const apps = [
      ["Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"],
      ["Chromium.app", "Contents", "MacOS", "Chromium"],
    ];
    return arches.flatMap((arch) => apps.map((app) => join(dir, arch, ...app)));
  }
  if (platform === "win32") {
    return ["chrome-win64", "chrome-win"].flatMap((arch) => [
      join(dir, arch, "chrome.exe"),
      join(dir, arch, "headless_shell.exe"),
    ]);
  }
  return ["chrome-linux64", "chrome-linux", "chrome-linux-arm64"].flatMap((arch) => [
    join(dir, arch, "chrome"),
    join(dir, arch, "headless_shell"),
  ]);
}

/** Finds any installed Playwright Chromium under the cache, newest first. */
export async function scanPlaywrightCache(
  dir: string,
  platform: NodeJS.Platform = process.platform,
): Promise<string | undefined> {
  let names: string[];
  try {
    names = (await readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return undefined;
  }
  const versions = (prefix: string) =>
    names
      .filter((name) => name.startsWith(prefix))
      .map((name) => ({ name, version: Number(name.slice(prefix.length)) || 0 }))
      .sort((a, b) => b.version - a.version);
  // A full Chromium first; the headless shell only when no full build is present.
  for (const entry of [...versions("chromium-"), ...versions("chromium_headless_shell-")]) {
    for (const candidate of chromiumExecutables(join(dir, entry.name), platform)) {
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

/** The Playwright Chromium this install knows, then any other in its cache. Nothing is downloaded. */
export async function playwrightChromiumPath(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): Promise<string | undefined> {
  try {
    const { chromium } = await import("playwright-core");
    const path = chromium.executablePath();
    if (existsSync(path)) return path;
  } catch {
    // No browser for this playwright-core, or it is not installed: try the cache below.
  }
  return scanPlaywrightCache(playwrightCacheDir(platform, env, home), platform);
}

/** Installed Google Chrome first, then a Playwright Chromium. Downloads nothing (MET-179). */
export async function findBrowserExecutable(
  options: {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    home?: string;
    isExecutable?: (path: string) => Promise<boolean>;
    playwright?: () => Promise<string | undefined>;
  } = {},
): Promise<string | undefined> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const isExecutable = options.isExecutable ?? isExecutableFile;
  for (const path of chromeCandidates(platform, env, home)) {
    if (await isExecutable(path)) return path;
  }
  for (const bin of CHROME_BIN_NAMES) {
    const path = await findOnPath(env, bin, isExecutable);
    if (path !== undefined) return path;
  }
  return (options.playwright ?? (() => playwrightChromiumPath(platform, env, home)))();
}

/**
 * Starts one headless Chrome with remote debugging on `port`. It is detached with its own
 * process group so `stop` can kill its whole tree (D-048), and its profile is temporary.
 * A missing executable, a crash before it answers and a debug port that stays quiet are
 * failures that name the fix (MET-179).
 */
export async function launchQaBrowser(options: BrowserLaunchOptions): Promise<QaBrowserStart> {
  const { executable, port, profileDir } = options;
  const env = options.env ?? process.env;
  const graceMs = options.graceMs ?? APP_KILL_GRACE_MS;
  const timeoutMs = options.timeoutMs ?? BROWSER_TIMEOUT_MS;
  const pollMs = options.pollMs ?? BROWSER_POLL_MS;
  const endpoint = `http://127.0.0.1:${port}`;
  const args = [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    "--remote-debugging-address=127.0.0.1",
    "--remote-allow-origins=*",
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "about:blank",
  ];
  let child: ChildProcess;
  try {
    child = spawn(executable, args, {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    await rm(profileDir, { recursive: true, force: true }).catch(() => {});
    return {
      ok: false,
      detail: `could not start the browser: ${message(error)}; ${BROWSER_FIX}`,
      error: "browser did not start",
    };
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
  const pid = child.pid;
  if (pid !== undefined) trackProcess(child);

  const stop = async () => {
    try {
      if (pid !== undefined) await killProcessTree(pid, graceMs);
    } finally {
      stopTrackingProcess(pid);
      child.stdout?.destroy();
      child.stderr?.destroy();
      await rm(profileDir, { recursive: true, force: true }).catch(() => {});
    }
  };
  const failed = async (detail: string, error: string): Promise<QaBrowserStart> => {
    await stop();
    return { ok: false, detail, error };
  };

  const deadline = Date.now() + Math.max(timeoutMs, 1);
  for (;;) {
    if (options.signal?.aborted === true) return failed("cancelled", "cancelled");
    if (spawnError !== undefined) {
      return failed(
        `could not start the browser: ${spawnError}; ${BROWSER_FIX}`,
        "browser did not start",
      );
    }
    if (exited !== undefined) {
      const why =
        exited.code !== null
          ? `exited with code ${exited.code}`
          : `exited on ${exited.signal ?? "a signal"}`;
      return failed(
        `${lastOutputLines(output, env)}; the browser ${why}. ${BROWSER_FIX}`,
        `browser ${why}`,
      );
    }
    if (
      await probeUrl(
        `${endpoint}/json/version`,
        Math.min(APP_PROBE_TIMEOUT_MS, Math.max(deadline - Date.now(), 1)),
      )
    ) {
      return { ok: true, browser: { endpoint, stop } };
    }
    const left = deadline - Date.now();
    if (left <= 0) {
      return failed(
        `the browser did not answer at ${endpoint} within ${Math.round(timeoutMs / 1000)}s; ${BROWSER_FIX}`,
        "browser did not start",
      );
    }
    await sleep(Math.min(pollMs, left));
  }
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

  /**
   * The browser step: a web review gets one headless Chrome after health passes (MET-179).
   * A missing browser, a failed launch and a silent debug port are `browser` setup errors
   * whose detail names the fix (D-041).
   */
  const withBrowser = async (): Promise<QaAppStart> => {
    if (kind !== "web") return { ok: true, app: started };
    const findExecutable =
      input.findBrowser ?? ((daemon: NodeJS.ProcessEnv) => findBrowserExecutable({ env: daemon }));
    let executable: string | undefined;
    try {
      executable = await findExecutable(daemonEnv);
    } catch {
      executable = undefined;
    }
    if (executable === undefined) {
      await started.stop();
      return {
        ok: false,
        step: "browser",
        detail: `no browser found; ${BROWSER_FIX}`,
        error: "no browser found",
      };
    }
    let port: number;
    try {
      port = await freePort();
    } catch (error) {
      await started.stop();
      return { ok: false, step: "browser", detail: message(error), error: message(error) };
    }
    let profileDir: string;
    try {
      profileDir = await mkdtemp(join(tmpdir(), "harnessd-qa-browser-"));
    } catch (error) {
      await started.stop();
      return { ok: false, step: "browser", detail: message(error), error: message(error) };
    }
    const launchBrowser = input.launchBrowser ?? launchQaBrowser;
    let result: QaBrowserStart;
    try {
      result = await launchBrowser({
        executable,
        port,
        profileDir,
        env: daemonEnv,
        timeoutMs: input.browserTimeoutMs ?? BROWSER_TIMEOUT_MS,
        pollMs: input.browserPollMs ?? BROWSER_POLL_MS,
        graceMs,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
    } catch (error) {
      result = { ok: false, detail: message(error), error: "browser did not start" };
    }
    if (!result.ok) {
      await rm(profileDir, { recursive: true, force: true }).catch(() => {});
      await started.stop();
      return { ok: false, step: "browser", detail: result.detail, error: result.error };
    }
    const browser = result.browser;
    return {
      ok: true,
      app: {
        ...started,
        browser: browser.endpoint,
        stop: async () => {
          await browser.stop();
          await started.stop();
        },
      },
    };
  };

  const health = (qa.health ?? "").trim();
  const healthTimeout =
    input.healthTimeoutMs ?? Math.min(APP_HEALTH_TIMEOUT_MS, Math.max(deadline - now(), 1));
  const healthDeadline = now() + healthTimeout;
  const healthUrl = isHealthPath(health) ? `${new URL(url).origin}${health}` : undefined;
  if (healthUrl === undefined && health === "") return withBrowser();

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
    if (passedProbe) return withBrowser();
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
