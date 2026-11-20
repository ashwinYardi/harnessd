// `harnessd doctor`: every harness and connection checked, as one dense table (MET-27).
// `harnessd run` uses the same checks at start and refuses to start on a blocking one.
import { resolve } from "node:path";
import {
  type Check,
  defaultGlobalDir,
  isBlocking,
  runStatus,
  type StatusOptions,
} from "@harnessd/daemon";
import { PACK } from "./pack.ts";

export const DOCTOR_USAGE = "Usage: harnessd doctor [dir] [--json]";

/** Runs the checks. Tests replace it to fake the machine. */
export type RunChecks = (options: StatusOptions) => Promise<Check[]>;

export interface DoctorIO {
  out: (line: string) => void;
  err: (line: string) => void;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  checks?: RunChecks;
}

/** The status options for one workspace, as doctor and run use them. */
export function statusOptions(repoDir: string, env: NodeJS.ProcessEnv): StatusOptions {
  return { repoDir, globalDir: defaultGlobalDir(env), env, packSkills: PACK.map((s) => s.name) };
}

const DETAIL_WIDTH = 60;

/** One row per check: state, id, detail, fix. Columns are padded; nothing is cut. */
export function formatChecks(checks: readonly Check[]): string[] {
  const idWidth = Math.max(5, ...checks.map((c) => c.id.length));
  const detailWidth = Math.min(DETAIL_WIDTH, Math.max(6, ...checks.map((c) => c.detail.length)));
  const row = (state: string, id: string, detail: string, fix: string) =>
    `${state.padEnd(7)} ${id.padEnd(idWidth)}  ${fix ? `${detail.padEnd(detailWidth)}  ${fix}` : detail}`.trimEnd();
  const lines = [row("STATE", "CHECK", "DETAIL", "FIX")];
  for (const c of checks) lines.push(row(c.state, c.id, c.detail, c.fix));
  const count = (s: Check["state"]) => checks.filter((c) => c.state === s).length;
  lines.push(
    "",
    `${checks.length} checks: ${count("ok")} ok, ${count("warn")} warn, ${count("fail")} fail, ${count("missing")} missing`,
  );
  return lines;
}

export async function runDoctor(args: readonly string[], io: DoctorIO): Promise<number> {
  let json = false;
  let dir: string | undefined;
  for (const arg of args) {
    if (arg === "--json") json = true;
    else if (arg === "--help" || arg === "-h") {
      io.out(DOCTOR_USAGE);
      return 0;
    } else if (arg.startsWith("-") || dir !== undefined) {
      io.err(`harnessd doctor: unexpected argument "${arg}"`);
      io.err(DOCTOR_USAGE);
      return 2;
    } else dir = arg;
  }
  const env = io.env ?? process.env;
  const repoDir = resolve(io.cwd ?? process.cwd(), dir ?? ".");
  const checks = await (io.checks ?? runStatus)(statusOptions(repoDir, env));
  const blocking = checks.some(isBlocking);
  if (json) io.out(JSON.stringify({ checks }, null, 2));
  else {
    for (const line of formatChecks(checks)) io.out(line);
    if (blocking) io.out('harnessd run will not start until every "fail" and "missing" is fixed.');
  }
  return blocking ? 1 : 0;
}

/** The error lines `harnessd run` prints when it refuses to start. */
export function refusalLines(checks: readonly Check[], outcome = "not starting"): string[] {
  const blocking = checks.filter(isBlocking);
  return [
    `harnessd run: ${blocking.length} check${blocking.length === 1 ? "" : "s"} failed; ${outcome}. Run "harnessd doctor" for the full list.`,
    ...blocking.map((c) => `  ${c.id} (${c.state}): ${c.detail}. Fix: ${c.fix}`),
  ];
}
