// `harnessd run`: the autonomy loop in the foreground. See docs/LOOP.md.
import { join, resolve } from "node:path";
import {
  type CoordinatorLoop,
  createClaudeCodeAdapter,
  createCoordinatorLoop,
  createFileLoopStore,
  createGhCli,
  createGitWorktrees,
  DEFAULT_LOOP_INTERVAL_MS,
  defaultGlobalDir,
  LinearClient,
  type ListReadyOptions,
  loadConfig,
} from "@harnessd/daemon";
import { ConfigError } from "@harnessd/shared";

/** Read at the edge only; never written to disk or logs. */
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
}

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

/**
 * Runs the coordinator loop for one repo. The Linear key comes from `LINEAR_API_KEY`
 * and the team from `linear.team_id` in the config; both are checked before anything runs.
 */
export async function runLoop(args: readonly string[], io: LoopIO): Promise<number> {
  const parsed = parseRunArgs(args);
  if (typeof parsed === "string") {
    io.err(`harnessd run: ${parsed}`);
    io.err(RUN_USAGE);
    return 2;
  }
  const env = io.env ?? process.env;
  const apiKey = env[LINEAR_API_KEY_ENV]?.trim();
  if (!apiKey) {
    io.err(
      `harnessd run: ${LINEAR_API_KEY_ENV} is not set. Export a Linear personal API key, e.g. ${LINEAR_API_KEY_ENV}=lin_api_... harnessd run`,
    );
    return 1;
  }
  const repoDir = resolve(io.cwd ?? process.cwd(), parsed.dir ?? ".");
  const globalDir = defaultGlobalDir(env);

  let loop: CoordinatorLoop;
  let teamId: string | undefined;
  try {
    const config = await loadConfig({ globalDir, workspaceDir: join(repoDir, ".harnessd") });
    teamId = config.linear.team_id?.trim();
    if (!teamId) {
      io.err(
        'harnessd run: linear.team_id is not set. Add it to .harnessd/config.toml under [linear], e.g. team_id = "MET".',
      );
      return 1;
    }
    const team: ListReadyOptions = { teamId };
    const project = config.linear.project?.trim();
    if (project) {
      if (UUID.test(project)) team.projectId = project;
      else team.projectName = project;
    }
    loop = createCoordinatorLoop({
      config,
      linear: new LinearClient({ apiKey: async () => apiKey }),
      adapters: {
        "claude-code": createClaudeCodeAdapter({ permissionMode: parsed.permissionMode }),
      },
      worktrees: createGitWorktrees({ repoDir, root: join(globalDir, "worktrees") }),
      github: createGhCli({ cwd: repoDir }),
      store: createFileLoopStore(repoDir),
      repoDir,
      team,
      intervalMs: parsed.intervalMs,
      log: (line) => io.out(`${new Date().toISOString()} ${line}`),
    });
  } catch (e) {
    io.err(`harnessd run: ${e instanceof ConfigError ? e.message : (e as Error).message}`);
    return 1;
  }

  if (parsed.once) {
    try {
      const report = await loop.tick();
      await loop.idle();
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

  io.out(`harnessd run: polling ${teamId} every ${parsed.intervalMs / 1000}s in ${repoDir}`);
  loop.start();
  const signal = await (io.stopSignal ?? untilSignal)();
  loop.stop();
  const running = loop.running();
  io.out(
    `harnessd run: ${signal}, stopped polling` +
      (running.length > 0 ? `; waiting for ${running.join(", ")}` : ""),
  );
  await loop.idle();
  return 0;
}
