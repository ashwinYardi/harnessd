import { resolve } from "node:path";
import { defaultGlobalDir, syncRepo } from "@harnessd/daemon";
import { ConfigError, VERSION } from "@harnessd/shared";

export interface CliIO {
  out: (line: string) => void;
  err: (line: string) => void;
  /** Defaults to process.cwd(). */
  cwd?: string;
  /** Defaults to process.env. `HARNESSD_HOME` overrides the global folder. */
  env?: NodeJS.ProcessEnv;
}

const USAGE = `harnessd ${VERSION}

Usage: harnessd <command>

Commands:
  sync [dir]   Write AGENTS.md and each harness's native files from .harnessd/
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

/** Runs the CLI and returns the process exit code. */
export async function run(argv: readonly string[], io: CliIO): Promise<number> {
  const [command = "help", ...rest] = argv;
  switch (command) {
    case "sync":
      return sync(rest, io);
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
