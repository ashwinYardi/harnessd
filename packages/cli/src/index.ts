import { VERSION } from "@harnessd/shared";

export interface CliIO {
  out: (line: string) => void;
  err: (line: string) => void;
}

const USAGE = `harnessd ${VERSION}

Usage: harnessd <command>

Commands:
  version   Print the version
  help      Show this help`;

/** Runs the CLI and returns the process exit code. */
export async function run(argv: readonly string[], io: CliIO): Promise<number> {
  const [command = "help"] = argv;
  switch (command) {
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
