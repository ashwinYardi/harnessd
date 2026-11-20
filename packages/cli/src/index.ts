import { resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { defaultGlobalDir, findRepoRoot, serveMemory, syncRepo, vaultDirs } from "@harnessd/daemon";
import { ConfigError, VERSION } from "@harnessd/shared";
import { runLoop } from "./loop.ts";
import { runPause, runResume } from "./pause.ts";

export interface CliIO {
  out: (line: string) => void;
  err: (line: string) => void;
  /** Defaults to process.cwd(). */
  cwd?: string;
  /** Defaults to process.env. `HARNESSD_HOME` overrides the global folder. */
  env?: NodeJS.ProcessEnv;
  /** Protocol streams for `mcp` servers. Default to process.stdin and process.stdout. */
  stdin?: Readable;
  stdout?: Writable;
}

const USAGE = `harnessd ${VERSION}

Usage: harnessd <command>

Commands:
  sync [dir]   Write AGENTS.md and each harness's native files from .harnessd/
  run [dir] [--once] [--interval <seconds>] [--permission-mode <mode>]
               Run the coordinator loop: split Ready issues and dispatch agents.
               Needs LINEAR_API_KEY and linear.team_id (docs/LOOP.md)
  pause [--reason <text>]
               Stop every agent in every workspace; worktrees are kept
  resume       Let the loop dispatch again
  mcp memory [--workspace <dir>]
               Serve the memory vaults over MCP on stdio (sync registers it)
  version      Print the version
  help         Show this help`;

async function sync(args: readonly string[], io: CliIO): Promise<number> {
  if (args.length > 1 || args[0]?.startsWith("-")) {
    io.err("Usage: harnessd sync [dir]");
    return 2;
  }
  const repoDir = resolve(io.cwd ?? process.cwd(), args[0] ?? ".");
  try {
    const { changed } = await syncRepo({ repoDir, globalDir: defaultGlobalDir(io.env) });
    for (const path of changed) io.out(`wrote ${path}`);
    io.out(changed.length === 0 ? "no changes" : `${changed.length} changed`);
    return 0;
  } catch (e) {
    io.err(e instanceof ConfigError ? `harnessd sync: ${e.message}` : String((e as Error).message));
    return 1;
  }
}

const MCP_USAGE = "Usage: harnessd mcp memory [--workspace <dir>]";

/**
 * `harnessd mcp memory`: stdout carries only protocol messages, so every
 * diagnostic goes to `io.err`. The workspace defaults to the nearest folder
 * above the cwd with a `.harnessd/`.
 */
async function mcp(args: readonly string[], io: CliIO): Promise<number> {
  const [server, ...rest] = args;
  const withWorkspace = rest.length === 2 && rest[0] === "--workspace";
  if (server !== "memory" || (rest.length > 0 && !withWorkspace)) {
    io.err(MCP_USAGE);
    return 2;
  }
  const workspace = withWorkspace ? rest[1] : undefined;
  const cwd = io.cwd ?? process.cwd();
  const globalDir = defaultGlobalDir(io.env);
  const repoDir =
    workspace === undefined ? await findRepoRoot(cwd, globalDir) : resolve(cwd, workspace);
  await serveMemory({
    vaults: vaultDirs(globalDir, repoDir),
    input: io.stdin ?? process.stdin,
    output: io.stdout ?? process.stdout,
  });
  return 0;
}

/** Runs the CLI and returns the process exit code. */
export async function run(argv: readonly string[], io: CliIO): Promise<number> {
  const [command = "help", ...rest] = argv;
  switch (command) {
    case "sync":
      return sync(rest, io);
    case "mcp":
      return mcp(rest, io);
    case "run":
      return runLoop(rest, io);
    case "pause":
      return runPause(rest, io);
    case "resume":
      return runResume(rest, io);
    case "version":
    case "--version":
    case "-v":
      io.out(VERSION);
      return 0;
    case "help":
    case "--help":
    case "-h":
      io.out(USAGE);
      return 0;
    default:
      io.err(`harnessd: unknown command "${command}". Run "harnessd help".`);
      return 2;
  }
}
