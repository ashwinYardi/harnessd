// `harnessd run`: the autonomy loop in the foreground. See docs/LOOP.md.
import { join, resolve } from "node:path";
import {
  agentsView,
  type CoordinatorLoop,
  createBoardSource,
  createClaudeCodeAdapter,
  createCodexAdapter,
  createCoordinatorLoop,
  createFileLoopStore,
  createFilePauseStore,
  createGhCli,
  createGitWorktrees,
  createLogBuffer,
  createPauseController,
  createSecretStore,
  createUiApi,
  createVisibility,
  type Daemon,
  type DaemonInfo,
  DEFAULT_LOOP_INTERVAL_MS,
  defaultGlobalDir,
  detectSelfUpdate,
  HttpError,
  isBlocking,
  LinearClient,
  type ListReadyOptions,
  loadConfig,
  mergeLayers,
  type Route,
  removeDaemonInfo,
  runStatus,
  SecretError,
  type SecretStore,
  type SelfUpdateRunner,
  type SelfUpdater,
  type SetupRunner,
  type SlackFetch,
  secretRoutes,
  setupRoutes,
  startDaemon,
  staticRoutes,
  statusRoutes,
  type Visibility,
  writeDaemonInfo,
} from "@harnessd/daemon";
import {
  ConfigError,
  type HarnessAdapter,
  type HarnessId,
  type MergedConfig,
} from "@harnessd/shared";
import { UI_DIR } from "@harnessd/ui";
import { type RunChecks, refusalLines, statusOptions } from "./doctor.ts";

/** The fallback after the secret store (D-030). Read at the edge only; never logged. */
export const LINEAR_API_KEY_ENV = "LINEAR_API_KEY";

export const RUN_USAGE =
  "Usage: harnessd run [dir] [--once] [--interval <seconds>] [--permission-mode <mode>]";

/** Agents run unattended in their own worktree, so they must not stop to ask. */
export const DEFAULT_PERMISSION_MODE = "auto";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RunArgs {
  dir?: string;
  once: boolean;
  intervalMs: number;
  permissionMode: string;
}

/** Parses `run` arguments; a string is a usage error. */
export function parseRunArgs(args: readonly string[]): RunArgs | string {
  const out: RunArgs = {
    once: false,
    intervalMs: DEFAULT_LOOP_INTERVAL_MS,
    permissionMode: DEFAULT_PERMISSION_MODE,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--once") {
      out.once = true;
    } else if (arg === "--interval") {
      const seconds = Number(args[++i]);
      if (!Number.isFinite(seconds) || seconds < 1) return "--interval: expected seconds >= 1";
      out.intervalMs = Math.round(seconds * 1000);
    } else if (arg === "--permission-mode") {
      const mode = args[++i];
      if (!mode || mode.startsWith("-")) return "--permission-mode: expected a mode";
      out.permissionMode = mode;
    } else if (arg.startsWith("-") || out.dir !== undefined) {
      return `unexpected argument "${arg}"`;
    } else {
      out.dir = arg;
    }
  }
  return out;
}

export interface LoopIO {
  out: (line: string) => void;
  err: (line: string) => void;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Resolves when the loop should stop. Default: SIGINT or SIGTERM. */
  stopSignal?: () => Promise<string>;
  /** The built UI. Default: the one in @harnessd/ui. */
  uiDir?: string;
  /** Slack posts go through it. Default globalThis.fetch. */
  fetch?: SlackFetch;
  /** Runs the status checks (MET-27). Default: the real machine. */
  checks?: RunChecks;
  /** Runs the fixed setup commands (install, update, sign in). Default: the real machine. */
  setupRunner?: SetupRunner;
  /**
   * Rebuilds and restarts harnessd after a merge into its own repo (MET-63). Used unless
   * `[daemon] self_update = false`. Default: none, so the loop never updates itself.
   */
  selfUpdater?: SelfUpdater;
  /** URL of the CLI entry point. */
  cliUrl?: string;
  /** Runs the startup self-update checks. Default: the real machine. */
  selfUpdateRunner?: SelfUpdateRunner;
}

/** How often a due daily summary is looked for. */
const SUMMARY_CHECK_MS = 60_000;

/** How long a stop waits for queued Slack posts. */
const SLACK_FLUSH_MS = 5_000;

function untilSignal(): Promise<string> {
  return new Promise((resolve) => {
    const on = (signal: string) => {
      process.off("SIGINT", on);
      process.off("SIGTERM", on);
      resolve(signal);
    };
    process.on("SIGINT", on);
    process.on("SIGTERM", on);
  });
}

interface Built {
  loop: CoordinatorLoop;
  linear: LinearClient;
  team: ListReadyOptions;
  teamId: string;
  config: MergedConfig;
  visibility: Visibility;
}

/** What the loop needs that is not a status check. */
interface Deps {
  parsed: RunArgs;
  io: LoopIO;
  repoDir: string;
  globalDir: string;
  pauseStore: ReturnType<typeof createFilePauseStore>;
  logs: ReturnType<typeof createLogBuffer>;
  secrets: SecretStore;
  log: (line: string) => void;
}

/** Why the loop cannot be built: the status check it stands for, and the text to print. */
interface Blocker {
  check: "linear.key" | "linear.team" | "config";
  message: string;
}

const blocked = (check: Blocker["check"], message: string): Blocker => ({ check, message });

const isBlocker = <T extends object>(b: T | Blocker): b is Blocker => "check" in b;

/** What the loop is built from, once nothing blocks it. */
interface Ready {
  config: MergedConfig;
  teamId: string;
  team: ListReadyOptions;
}

/**
 * Says what blocks the loop: the Linear key, the config or linear.team_id. It builds no
 * Linear client, notifier or loop, so it is safe to run on each read.
 */
async function findBlocker(
  deps: Pick<Deps, "repoDir" | "globalDir" | "secrets">,
): Promise<Ready | Blocker> {
  const { repoDir, globalDir, secrets } = deps;
  // Saved value or reference first, then LINEAR_API_KEY (D-030).
  try {
    if ((await secrets.value("linear.api_key")) === undefined) {
      return blocked(
        "linear.key",
        `No Linear key is saved and ${LINEAR_API_KEY_ENV} is not set. Paste a Linear personal API key in Settings, Connections, Linear.`,
      );
    }
  } catch (e) {
    if (e instanceof SecretError || e instanceof ConfigError) {
      return blocked("linear.key", `Linear key: ${e.message}`);
    }
    throw e;
  }
  let config: MergedConfig;
  try {
    config = await loadConfig({ globalDir, workspaceDir: join(repoDir, ".harnessd") });
  } catch (e) {
    return blocked("config", e instanceof ConfigError ? e.message : (e as Error).message);
  }
  const teamId = config.linear.team_id?.trim();
  if (!teamId) {
    return blocked(
      "linear.team",
      'linear.team_id is not set. Add it to .harnessd/config.toml under [linear], e.g. team_id = "MET".',
    );
  }
  const team: ListReadyOptions = { teamId };
  const project = config.linear.project?.trim();
  if (project) {
    if (UUID.test(project)) team.projectId = project;
    else team.projectName = project;
  }
  return { config, teamId, team };
}

/**
 * The harness adapters the loop dispatches to, by `agents.<name>.harness`.
 * The path set in Settings → Harnesses wins over HARNESSD_<HARNESS>_BIN and PATH.
 * `--permission-mode` is a Claude Code flag; Codex runs use their own sandbox flags (D-032).
 */
export function harnessAdapters(
  config: MergedConfig,
  permissionMode: string,
): Partial<Record<HarnessId, HarnessAdapter>> {
  const claudeBin = config.harnesses["claude-code"]?.bin;
  const codexBin = config.harnesses.codex?.bin;
  return {
    "claude-code": createClaudeCodeAdapter({
      permissionMode,
      ...(claudeBin ? { bin: claudeBin } : {}),
    }),
    codex: createCodexAdapter(codexBin ? { bin: codexBin } : {}),
  };
}

/** Builds the loop from the config and the Linear key, or says what blocks it. */
async function buildLoop(deps: Deps): Promise<Built | Blocker> {
  const { parsed, io, repoDir, globalDir, pauseStore, logs, secrets, log } = deps;
  const ready = await findBlocker(deps);
  if (isBlocker(ready)) return ready;
  const { config, teamId, team } = ready;
  // Read on each request, so a key replaced in Settings is used on the next tick.
  const linear = new LinearClient({
    apiKey: async () => {
      const key = await secrets.value("linear.api_key");
      if (key === undefined) throw new Error("No Linear key. Save one in Settings, Connections.");
      return key;
    },
  });
  let loop: CoordinatorLoop | undefined;
  const visibility = createVisibility({
    webhookUrl: () => secrets.value("slack.webhook_url"),
    slack: config.slack,
    repoDir,
    inProgress: () => (loop?.running() ?? []).map((key) => ({ key })),
    log,
    ...(io.fetch ? { fetch: io.fetch } : {}),
  });
  loop = createCoordinatorLoop({
    config,
    linear,
    adapters: harnessAdapters(config, parsed.permissionMode),
    worktrees: createGitWorktrees({ repoDir, root: join(globalDir, "worktrees") }),
    github: createGhCli({ cwd: repoDir }),
    store: createFileLoopStore(repoDir),
    repoDir,
    skillsDir: join(globalDir, "skills"),
    // Each part and QA run gets the synced harness files and the vaults (MET-55).
    globalDir,
    team,
    intervalMs: parsed.intervalMs,
    paused: async () => (await pauseStore.read()).paused,
    ...(io.selfUpdater && config.daemon.self_update
      ? {
          selfUpdate: {
            updater: io.selfUpdater,
            pause: (reason: string) => pauseStore.pause(reason),
          },
        }
      : {}),
    notifier: visibility.notifier,
    log,
    // The UI's live log shows each tool call (MET-18); stdout stays one line per step.
    onAgentEvent: (run, event) => {
      if (event.type === "tool") {
        logs.push(`${event.name} ${event.summary}`, {
          source: run.agent,
          issueKey: run.issueKey,
        });
      }
    },
  });
  return { loop, linear, team, teamId, config, visibility };
}

/**
 * Runs the coordinator loop for one repo. The Linear key comes from the secret store,
 * then `LINEAR_API_KEY` (D-030), and the team from `linear.team_id` in the config.
 *
 * With `--once`, a missing key, team or a blocking check stops it with exit 1. Without
 * `--once`, it serves the app anyway, in setup: the loop waits until every required check
 * passes and the owner presses Start (POST /api/start, D-026).
 */
export async function runLoop(args: readonly string[], io: LoopIO): Promise<number> {
  const parsed = parseRunArgs(args);
  if (typeof parsed === "string") {
    io.err(`harnessd run: ${parsed}`);
    io.err(RUN_USAGE);
    return 2;
  }
  const env = io.env ?? process.env;
  const repoDir = resolve(io.cwd ?? process.cwd(), parsed.dir ?? ".");
  const globalDir = defaultGlobalDir(env);
  const pauseStore = createFilePauseStore(globalDir);
  const logs = createLogBuffer();
  const checks = io.checks ?? runStatus;
  // One store for the loop, the checks and Settings, so they share the op cache.
  const secrets = createSecretStore({ globalDir, env });
  const options = { ...statusOptions(repoDir, env), secrets };
  const log = (line: string) => {
    io.out(`${new Date().toISOString()} ${line}`);
    logs.push(line);
  };
  const deps: Deps = { parsed, io, repoDir, globalDir, pauseStore, logs, secrets, log };

  const built = await buildLoop(deps);
  if (isBlocker(built) && parsed.once) {
    io.err(`harnessd run: ${built.message}`);
    return 1;
  }
  // The port is read on its own, so a missing key or team still serves the app.
  let port: number;
  let fallback: MergedConfig;
  let selfUpdate: boolean | undefined;
  try {
    fallback = await loadConfig({ globalDir, workspaceDir: join(repoDir, ".harnessd") });
    port = fallback.daemon.port;
    selfUpdate = fallback.daemon.self_update;
  } catch (e) {
    if (parsed.once) {
      io.err(`harnessd run: ${e instanceof ConfigError ? e.message : (e as Error).message}`);
      return 1;
    }
    fallback = mergeLayers([]);
    port = fallback.daemon.port;
  }

  // Every harness and connection, before anything is dispatched (MET-27, D-023).
  const startChecks = await checks(options);
  const startIds = startChecks.filter(isBlocking).map((c) => c.id);
  const blocking = isBlocker(built) ? [...new Set([built.check, ...startIds])] : startIds;
  if (blocking.length > 0 && parsed.once) {
    for (const line of refusalLines(startChecks)) io.err(line);
    return 1;
  }
  if (isBlocker(built)) io.err(`harnessd run: ${built.message}`);
  if (startChecks.some(isBlocking)) {
    for (const line of refusalLines(startChecks, "the loop waits")) io.err(line);
  }
  for (const c of startChecks.filter((c) => c.state === "warn")) {
    io.err(`harnessd run: warn ${c.id}: ${c.detail}`);
  }

  // The local API (docs/API.md), so `harnessd pause` and the UI reach this loop at once.
  const loops: CoordinatorLoop[] = [];
  const pause = createPauseController({ store: pauseStore, loops });
  let active: Built | undefined;
  let started: (() => void) | undefined;
  const ui = createUiApi({
    board: createBoardSource({
      read: () =>
        active
          ? active.linear.listBoard(active.team)
          : Promise.reject(new Error("The loop has not started. Finish setup in Settings.")),
      loop: () => (active ? active.loop.snapshot() : { lastPollAt: null, runs: [], blocked: [] }),
    }),
    agents: () =>
      active
        ? agentsView(active.config, active.loop.snapshot())
        : agentsView(fallback, { lastPollAt: null, runs: [], blocked: [] }),
    logs,
    pause,
  });

  // The blocking ids from the checks as they are now, the loop's own blocker first.
  const currentBlocking = async (): Promise<{ blocking: string[]; blocker?: Blocker }> => {
    const now = await checks({ ...options, servingPort: true });
    const ready = await findBlocker(deps);
    const ids = now.filter(isBlocking).map((c) => c.id);
    if (!isBlocker(ready)) return { blocking: ids };
    return { blocking: [...new Set([ready.check, ...ids])], blocker: ready };
  };

  const loopRoutes: Route[] = [
    {
      method: "GET",
      path: "/api/loop",
      // Only reads: in setup it runs the checks again, so a saved key or a setup action
      // shows at once (D-026). It never starts the loop. `selfUpdate` is the last
      // self-update, once there was one (docs/API.md).
      handler: async () => {
        if (!active) return { state: "setup", blocking: (await currentBlocking()).blocking };
        const { selfUpdate } = active.loop.snapshot();
        return { state: "running", blocking: [], ...(selfUpdate ? { selfUpdate } : {}) };
      },
    },
    {
      method: "POST",
      path: "/api/start",
      handler: async () => {
        if (active) return { state: "running", blocking: [] };
        const now = await currentBlocking();
        if (now.blocking.length > 0) {
          throw new HttpError(
            409,
            "setup_incomplete",
            `Fix these first: ${now.blocking.join(", ")}.${now.blocker ? ` ${now.blocker.message}` : ""}`,
          );
        }
        const next = await buildLoop(deps);
        if (isBlocker(next)) {
          throw new HttpError(
            409,
            "setup_incomplete",
            `Fix these first: ${next.check}. ${next.message}`,
          );
        }
        if (active) return { state: "running", blocking: [] };
        active = next;
        loops.push(next.loop);
        started?.();
        return { state: "running", blocking: [] };
      },
    },
  ];

  let selfUpdateLine = "Self-update is off. Cannot read the daemon config.";
  if (selfUpdate !== undefined) {
    const update = await detectSelfUpdate(
      {
        cliUrl: io.cliUrl ?? import.meta.url,
        workspace: repoDir,
        selfUpdate,
        log: (line) => {
          selfUpdateLine = line;
        },
      },
      io.selfUpdateRunner,
    );
    if (update.kind === "on") selfUpdateLine = "Self-update detected the install clone.";
  }

  let daemon: Daemon;
  let page: Awaited<ReturnType<typeof staticRoutes>>;
  try {
    page = await staticRoutes(io.uiDir ?? UI_DIR);
    const status = statusRoutes(() => checks({ ...options, servingPort: true }));
    const setup = setupRoutes({
      repoDir,
      globalDir,
      env,
      checks: (o) => checks({ ...options, ...o, servingPort: true }),
      ...(io.setupRunner ? { runner: io.setupRunner } : {}),
    });
    const secretApi = secretRoutes({
      store: secrets,
      checks: (o) => checks({ ...options, ...o, servingPort: true }),
      log,
    });
    daemon = await startDaemon({
      port,
      pause,
      routes: [...ui.routes, ...status, ...loopRoutes, ...setup.routes, ...secretApi, ...page],
    });
  } catch (e) {
    const busy = (e as NodeJS.ErrnoException).code === "EADDRINUSE";
    io.err(
      busy
        ? `harnessd run: port ${port} is in use (another harnessd run?). Stop it or set daemon.port in .harnessd/config.toml.`
        : `harnessd run: could not start the API: ${(e as Error).message}`,
    );
    return 1;
  }
  const info: DaemonInfo = {
    url: daemon.url,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
  try {
    await writeDaemonInfo(globalDir, info);
    io.out(
      page.length > 0
        ? `harnessd run: UI and API at ${daemon.url}`
        : `harnessd run: API at ${daemon.url} (UI not built)`,
    );
    const paused = await pauseStore.read();
    if (paused.paused) io.out(pausedLine(paused.since, paused.reason));
    log(selfUpdateLine);
    if (blocking.length === 0 && !isBlocker(built)) {
      active = built;
      loops.push(built.loop);
      return await drive(active, parsed, io);
    }
    io.out(`harnessd run: Finish setup at ${daemon.url}/#/settings, then press Start.`);
    // Wait for Start or the stop signal, whichever comes first.
    const stop = (io.stopSignal ?? untilSignal)();
    const start = new Promise<void>((resolve) => {
      started = resolve;
    });
    const first = await Promise.race([
      stop.then((s) => ({ stop: s })),
      start.then(() => ({ stop: "" })),
    ]);
    if (first.stop || !active) {
      io.out(`harnessd run: ${first.stop || "stopped"}, the loop never started`);
      return 0;
    }
    return await drive(active, parsed, io, stop);
  } finally {
    ui.close();
    await daemon.close();
    await removeDaemonInfo(globalDir, info).catch(() => undefined);
  }
}

export function pausedLine(since: string | undefined, reason: string | undefined): string {
  const when = since ? ` since ${since}` : "";
  const why = reason ? ` (${reason})` : "";
  return `harnessd run: paused${when}${why}. Run "harnessd resume" to dispatch again.`;
}

/** Runs one tick (`--once`) or polls until the stop signal. */
async function drive(
  built: Built,
  parsed: RunArgs,
  io: LoopIO,
  stopSignal?: Promise<string>,
): Promise<number> {
  const { loop, visibility } = built;
  io.out(`harnessd run: ${await visibility.status()}`);
  // A summary missed while the daemon was off goes out now, once (D-021).
  await visibility.checkSummary();
  const summaries = parsed.once
    ? undefined
    : setInterval(() => void visibility.checkSummary(), SUMMARY_CHECK_MS);
  try {
    if (parsed.once) {
      try {
        const report = await loop.tick();
        await loop.idle();
        if (report.paused) {
          io.out("paused: nothing dispatched");
          return 0;
        }
        io.out(
          `split ${report.split.length}, dispatched ${report.dispatched.length}, ` +
            `escalated ${report.escalated.length}, re-queued ${report.requeued.length}`,
        );
        return 0;
      } catch (e) {
        io.err(`harnessd run: ${(e as Error).message}`);
        return 1;
      }
    }
    io.out(`harnessd run: polling ${built.teamId} every ${parsed.intervalMs / 1000}s`);
    loop.start();
    const signal = await (stopSignal ?? (io.stopSignal ?? untilSignal)());
    loop.stop();
    const running = loop.running();
    io.out(
      `harnessd run: ${signal}, stopped polling` +
        (running.length > 0 ? `; waiting for ${running.join(", ")}` : ""),
    );
    await loop.idle();
    return 0;
  } finally {
    clearInterval(summaries);
    await visibility.flush(SLACK_FLUSH_MS);
  }
}
