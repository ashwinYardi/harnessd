// `harnessd init`: sets up harnessd on this machine. See docs/INSTALL.md.
//
// Idempotent: harness CLIs already on PATH are kept, an existing config.toml is never
// overwritten, and the launchd service is reloaded only when its plist changed.
// Every OS effect goes through InitSystem so the tests run on any platform with fakes.
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

export const INIT_USAGE = "Usage: harnessd init [--yes] [--no-service] [--workspace <dir>]";

/** The launchd label, also the plist's file name. */
export const LAUNCHD_LABEL = "dev.harnessd.daemon";

/** The CLIs init checks, in order. `harnessd` itself must be installed for the service. */
export const TOOLS = [
  { bin: "harnessd", pkg: "@harnessd/cli", label: "harnessd" },
  { bin: "claude", pkg: "@anthropic-ai/claude-code", label: "Claude Code" },
  { bin: "codex", pkg: "@openai/codex", label: "Codex" },
] as const;

/** Written to config.toml only when the file is absent. Comments only, so it loads as {}. */
export const CONFIG_TEMPLATE = `# harnessd global config. Every key is optional; reference: docs/CONFIG.md.
# A repo's .harnessd/config.toml overrides this file.

# [linear]
# team_id = "MET"
# project = "harnessd"

# [limits]
# max_concurrent = 3

# [daemon]
# port = 4747
`;

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface InitFs {
  /** undefined when the file does not exist. */
  read(path: string): Promise<string | undefined>;
  write(path: string, data: string): Promise<void>;
  mkdirp(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  isExecutable(path: string): Promise<boolean>;
}

export interface InitSystem {
  platform: NodeJS.Platform;
  homedir: string;
  uid: number;
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** The running node binary; its folder goes first on the service's PATH. */
  nodePath: string;
  fs: InitFs;
  /** `inherit` streams the command's output to the terminal (installs). */
  exec(cmd: string, args: readonly string[], options?: { inherit?: boolean }): Promise<ExecResult>;
  /** undefined when there is no terminal to ask on. */
  confirm?: (question: string) => Promise<boolean>;
  sleep(ms: number): Promise<void>;
}

export interface InitIO {
  out: (line: string) => void;
  err: (line: string) => void;
}

export interface InitArgs {
  yes: boolean;
  service: boolean;
  workspace?: string;
  help: boolean;
}

/** Parses `init` arguments; a string is a usage error. */
export function parseInitArgs(args: readonly string[]): InitArgs | string {
  const out: InitArgs = { yes: false, service: true, help: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--yes" || arg === "-y") out.yes = true;
    else if (arg === "--no-service") out.service = false;
    else if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--workspace") {
      const dir = args[++i];
      if (!dir || dir.startsWith("-")) return "--workspace: expected a directory";
      out.workspace = dir;
    } else return `unexpected argument "${arg}"`;
  }
  return out;
}

/** The command line as printed: arguments with spaces or quotes are single-quoted. */
export function formatCommand(cmd: string, args: readonly string[]): string {
  return [cmd, ...args]
    .map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replaceAll("'", "'\\''")}'`))
    .join(" ");
}

/** PATH entries npx adds for its own run; a service must not depend on them. */
function isTransient(dir: string): boolean {
  return dir.includes("/_npx/") || dir.includes("/node_modules/.bin");
}

function pathDirs(env: NodeJS.ProcessEnv): string[] {
  return (env.PATH ?? "").split(delimiter).filter((d) => d !== "");
}

/** Finds `bin` on PATH, skipping npx's temporary folders. */
export async function which(sys: InitSystem, bin: string): Promise<string | undefined> {
  for (const dir of pathDirs(sys.env)) {
    if (isTransient(dir)) continue;
    const candidate = join(dir, bin);
    if (await sys.fs.isExecutable(candidate)) return candidate;
  }
  return undefined;
}

async function version(sys: InitSystem, path: string): Promise<string> {
  const res = await sys.exec(path, ["--version"]);
  const line = `${res.stdout}\n${res.stderr}`.split("\n").find((l) => l.trim() !== "");
  return res.code === 0 && line ? line.trim() : "version unknown";
}

function xml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export interface PlistOptions {
  harnessd: string;
  workspace: string;
  logsDir: string;
  path: string;
  /** Set when HARNESSD_HOME was set for init, so the service uses the same folder. */
  harnessdHome?: string;
}

/** The launchd agent: `harnessd run` in the workspace, restarted when it exits with an error. */
export function renderPlist(o: PlistOptions): string {
  const env = [["PATH", o.path]];
  if (o.harnessdHome !== undefined) env.push(["HARNESSD_HOME", o.harnessdHome]);
  const s = (v: string) => `<string>${xml(v)}</string>`;
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    `  <key>Label</key>`,
    `  ${s(LAUNCHD_LABEL)}`,
    `  <key>ProgramArguments</key>`,
    `  <array>`,
    `    ${s(o.harnessd)}`,
    `    ${s("run")}`,
    `  </array>`,
    `  <key>WorkingDirectory</key>`,
    `  ${s(o.workspace)}`,
    `  <key>EnvironmentVariables</key>`,
    `  <dict>`,
    ...env.flatMap(([k = "", v = ""]) => [`    <key>${xml(k)}</key>`, `    ${s(v)}`]),
    `  </dict>`,
    `  <key>RunAtLoad</key>`,
    `  <true/>`,
    `  <key>KeepAlive</key>`,
    `  <dict>`,
    `    <key>SuccessfulExit</key>`,
    `    <false/>`,
    `  </dict>`,
    `  <key>ThrottleInterval</key>`,
    `  <integer>30</integer>`,
    `  <key>StandardOutPath</key>`,
    `  ${s(join(o.logsDir, "daemon.out.log"))}`,
    `  <key>StandardErrorPath</key>`,
    `  ${s(join(o.logsDir, "daemon.err.log"))}`,
    `</dict>`,
    `</plist>`,
    ``,
  ].join("\n");
}

/** The service PATH: node's folder, harnessd's folder, then the caller's PATH without npx dirs. */
export function servicePath(sys: InitSystem, harnessd: string): string {
  const dirs = [
    dirname(sys.nodePath),
    dirname(harnessd),
    ...pathDirs(sys.env).filter((d) => !isTransient(d)),
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];
  return [...new Set(dirs)].join(":");
}

export function globalDirFor(sys: InitSystem): string {
  const override = sys.env.HARNESSD_HOME?.trim();
  return override ? resolve(sys.cwd, override) : join(sys.homedir, ".harnessd");
}

export function plistPathFor(sys: InitSystem): string {
  return join(sys.homedir, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

interface Step {
  io: InitIO;
  sys: InitSystem;
}

/** Prints and runs one command. */
async function runCommand(
  { io, sys }: Step,
  cmd: string,
  args: readonly string[],
  inherit = false,
): Promise<ExecResult> {
  io.out(`run: ${formatCommand(cmd, args)}`);
  return sys.exec(cmd, args, { inherit });
}

type Found = Map<string, string | undefined>;

async function detect(step: Step): Promise<Found> {
  const found: Found = new Map();
  for (const tool of TOOLS) {
    const path = await which(step.sys, tool.bin);
    found.set(tool.bin, path);
    if (path === undefined) step.io.out(`${tool.label}: not found`);
    else step.io.out(`${tool.label}: ${await version(step.sys, path)} (${path})`);
  }
  return found;
}

/** Installs missing CLIs after --yes or an interactive yes. false: an install failed. */
async function installMissing(step: Step, args: InitArgs, found: Found): Promise<boolean> {
  const { io, sys } = step;
  const missing = TOOLS.filter((t) => found.get(t.bin) === undefined);
  if (missing.length === 0) return true;
  const npm = await which(sys, "npm");
  const commands = missing.map((t) => ({ tool: t, args: ["i", "-g", t.pkg] }));
  io.out("To install the missing CLIs, init will run:");
  for (const c of commands) io.out(`  ${formatCommand("npm", c.args)}`);
  if (npm === undefined) {
    io.err("harnessd init: npm is not on PATH; install Node 24 (see docs/INSTALL.md).");
    return false;
  }
  let consent = args.yes;
  if (!consent && sys.confirm !== undefined) consent = await sys.confirm("Run these now? [y/N] ");
  if (!consent) {
    io.out("Skipped installs. Re-run with --yes to install them.");
    return true;
  }
  let ok = true;
  for (const c of commands) {
    const res = await runCommand(step, npm, c.args, true);
    if (res.code !== 0) {
      io.err(`harnessd init: "${formatCommand("npm", c.args)}" exited ${res.code}.`);
      if (res.stderr.trim() !== "") io.err(res.stderr.trim());
      ok = false;
      continue;
    }
    const path = await which(sys, c.tool.bin);
    found.set(c.tool.bin, path);
    io.out(
      path === undefined
        ? `${c.tool.label}: installed, but not on PATH; check "npm prefix -g".`
        : `${c.tool.label}: ${await version(sys, path)} (${path})`,
    );
  }
  return ok;
}

async function writeConfig({ io, sys }: Step): Promise<void> {
  const globalDir = globalDirFor(sys);
  const file = join(globalDir, "config.toml");
  await sys.fs.mkdirp(join(globalDir, "logs"));
  if (await sys.fs.exists(file)) {
    io.out(`config: kept existing ${file}`);
    return;
  }
  await sys.fs.write(file, CONFIG_TEMPLATE);
  io.out(`config: wrote ${file}`);
}

const BOOTSTRAP_ATTEMPTS = 3;

/** Writes the plist and (re)loads it. false: launchctl failed. */
async function installService(step: Step, args: InitArgs, harnessd: string): Promise<boolean> {
  const { io, sys } = step;
  const workspace = resolve(sys.cwd, args.workspace ?? ".");
  if (!(await sys.fs.exists(join(workspace, ".git")))) {
    io.out(
      `note: ${workspace} is not a git repo; harnessd run needs one. Re-run with --workspace <repo>.`,
    );
  }
  const home = sys.env.HARNESSD_HOME?.trim();
  const plist = renderPlist({
    harnessd,
    workspace,
    logsDir: join(globalDirFor(sys), "logs"),
    path: servicePath(sys, harnessd),
    ...(home ? { harnessdHome: globalDirFor(sys) } : {}),
  });
  const file = plistPathFor(sys);
  const domain = `gui/${sys.uid}`;
  const target = `${domain}/${LAUNCHD_LABEL}`;
  const unchanged = (await sys.fs.read(file)) === plist;
  const loaded = (await sys.exec("launchctl", ["print", target])).code === 0;
  if (unchanged && loaded) {
    io.out(`service: unchanged, ${LAUNCHD_LABEL} already loaded (${file})`);
    return true;
  }
  if (unchanged) io.out(`service: kept ${file}`);
  else {
    await sys.fs.mkdirp(dirname(file));
    await sys.fs.write(file, plist);
    io.out(`service: wrote ${file}`);
  }
  if (loaded) await runCommand(step, "launchctl", ["bootout", target]);
  // bootout returns before launchd has let go of the label, so bootstrap may need a retry.
  let res: ExecResult = { code: 1, stdout: "", stderr: "" };
  for (let attempt = 1; attempt <= BOOTSTRAP_ATTEMPTS; attempt++) {
    res = await runCommand(step, "launchctl", ["bootstrap", domain, file]);
    if (res.code === 0) break;
    if (attempt < BOOTSTRAP_ATTEMPTS) await sys.sleep(1000);
  }
  if (res.code !== 0) {
    io.err(`harnessd init: launchctl bootstrap exited ${res.code}. ${res.stderr.trim()}`.trim());
    return false;
  }
  io.out(`service: loaded ${LAUNCHD_LABEL}; logs in ${join(globalDirFor(sys), "logs")}`);
  return true;
}

export async function runInit(
  argv: readonly string[],
  io: InitIO,
  sys: InitSystem = nodeSystem(),
): Promise<number> {
  const args = parseInitArgs(argv);
  if (typeof args === "string") {
    io.err(`harnessd init: ${args}`);
    io.err(INIT_USAGE);
    return 2;
  }
  if (args.help) {
    io.out(INIT_USAGE);
    return 0;
  }
  const step = { io, sys };
  const found = await detect(step);
  let ok = await installMissing(step, args, found);
  await writeConfig(step);

  if (!args.service) io.out("service: skipped (--no-service)");
  else if (sys.platform !== "darwin")
    io.out("service: skipped; the launchd service is macOS-only in v0.1");
  else {
    const harnessd = found.get("harnessd");
    if (harnessd === undefined)
      io.out("service: skipped; harnessd is not installed globally (re-run with --yes)");
    else ok = (await installService(step, args, harnessd)) && ok;
  }

  const missing = TOOLS.filter((t) => found.get(t.bin) === undefined).map((t) => t.bin);
  if (!ok) io.out("init: finished with errors (see above). Re-running is safe.");
  else if (missing.length > 0) io.out(`init: done; not installed: ${missing.join(", ")}`);
  else io.out("init: done");
  return ok ? 0 : 1;
}

function execNode(
  cmd: string,
  args: readonly string[],
  options?: { inherit?: boolean },
): Promise<ExecResult> {
  return new Promise((done) => {
    const child = spawn(cmd, args, {
      stdio: options?.inherit ? ["inherit", "inherit", "pipe"] : ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => {
      stdout += d;
    });
    child.stderr?.on("data", (d) => {
      const text = String(d);
      stderr += text;
      if (options?.inherit) process.stderr.write(text);
    });
    child.on("error", (e) => done({ code: 127, stdout, stderr: e.message }));
    child.on("close", (code) => done({ code: code ?? 1, stdout, stderr }));
  });
}

async function askTty(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

/** The real machine. */
export function nodeSystem(): InitSystem {
  return {
    platform: process.platform,
    homedir: homedir(),
    uid: process.getuid?.() ?? 0,
    cwd: process.cwd(),
    env: process.env,
    nodePath: process.execPath,
    fs: {
      read: (path) => readFile(path, "utf8").catch(() => undefined),
      write: (path, data) => writeFile(path, data, "utf8"),
      mkdirp: async (path) => {
        await mkdir(path, { recursive: true });
      },
      exists: (path) =>
        access(path).then(
          () => true,
          () => false,
        ),
      isExecutable: (path) =>
        access(path, constants.X_OK).then(
          () => true,
          () => false,
        ),
    },
    exec: execNode,
    ...(process.stdin.isTTY && process.stdout.isTTY ? { confirm: askTty } : {}),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}
