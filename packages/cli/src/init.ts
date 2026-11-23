// `harnessd init`: sets up harnessd on this machine. See docs/INSTALL.md.
//
// Idempotent: harness CLIs already on PATH are kept, an existing config.toml is never
// overwritten (init only appends missing skill pins), installed skills stay at their
// pinned commit, and the launchd service is reloaded only when its plist changed.
// Every OS effect goes through InitSystem so the tests run on any platform with fakes.
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import {
  type ExecResult,
  findOnPath,
  isTransientDir,
  LAUNCHD_LABEL,
  launchdPlistPath,
  PACK_MARKER,
  parseConfigText,
  pathDirs,
  readVersion,
  tomlKey,
  tomlString,
} from "@harnessd/daemon";
import { ConfigError, type SkillSettings } from "@harnessd/shared";
import { PACK_MANIFEST, type PackSkill } from "./pack.ts";

export const INIT_USAGE = "Usage: harnessd init [--yes] [--no-service] [--workspace <dir>]";

/** The launchd label, also the plist's file name; the status engine reads the same plist. */
export { LAUNCHD_LABEL };

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
# max_concurrent = 1
# max_parents = 1

# [daemon]
# port = 4747
`;

export type { ExecResult };

export interface InitFs {
  /** undefined when the file does not exist. */
  read(path: string): Promise<string | undefined>;
  write(path: string, data: string): Promise<void>;
  mkdirp(path: string): Promise<void>;
  /** True for a file or a folder. */
  exists(path: string): Promise<boolean>;
  isExecutable(path: string): Promise<boolean>;
  /** Replaces the folder `to` with a copy of `from`. */
  copyDir(from: string, to: string): Promise<void>;
}

export interface InitSystem {
  platform: NodeJS.Platform;
  homedir: string;
  uid: number;
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** The running node binary; its folder goes first on the service's PATH. */
  nodePath: string;
  /** The default skill pack this build ships (dist/pack/, see pack.ts). */
  packDir: string;
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

/** Finds `bin` on PATH, skipping npx's temporary folders (shared with the status engine). */
export function which(sys: InitSystem, bin: string): Promise<string | undefined> {
  return findOnPath(sys.env, bin, sys.fs.isExecutable);
}

async function version(sys: InitSystem, path: string): Promise<string> {
  return (await readVersion((cmd, args) => sys.exec(cmd, args), path)) ?? "version unknown";
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
    ...pathDirs(sys.env).filter((d) => !isTransientDir(d)),
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
  return launchdPlistPath(sys.homedir);
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

const PIN_HEADER =
  '# Default skill pack (docs/CONFIG.md "Skills"). init installs only the pinned commit.';

/** What a pin records: the upstream repo and commit, plus the release when known. */
type SkillPin = Pick<PackSkill, "upstream" | "commit" | "version">;

function pinTable(name: string, pin: SkillPin): string {
  const lines = [`[skills.${tomlKey(name)}]`, `upstream = ${tomlString(pin.upstream)}`];
  lines.push(`commit = ${tomlString(pin.commit)}`);
  if (pin.version !== undefined) lines.push(`version = ${tomlString(pin.version)}`);
  return lines.join("\n");
}

function parseMarker(text: string | undefined): SkillPin | undefined {
  if (text === undefined) return undefined;
  try {
    const m = JSON.parse(text);
    return typeof m?.commit === "string" && typeof m?.upstream === "string" ? m : undefined;
  } catch {
    return undefined;
  }
}

/** The pack format a marker names; a marker from before formats were recorded is 1. */
function markerFormat(text: string | undefined): number {
  try {
    const format = JSON.parse(text ?? "{}")?.format;
    return typeof format === "number" ? format : 1;
  } catch {
    return 1;
  }
}

/** What init does with one pack skill. Pure, so every case reads in one place. */
type SkillPlan =
  | { action: "foreign" }
  | { action: "install" | "update" | "keep" | "skip"; pin?: SkillPin; note?: string };

function planSkill(
  skill: PackSkill,
  present: boolean,
  marker: SkillPin | undefined,
  table: SkillSettings | undefined,
  configFile: string,
  /** True when the installed marker names an older pack format than this build ships. */
  staleMarker = false,
): SkillPlan {
  if (present && marker === undefined) return { action: "foreign" };
  const fix = `Set skills.${skill.name}.commit = "${skill.commit}" in ${configFile}`;
  if (table !== undefined && table.commit === undefined) {
    // A table exists (say `enabled = false`) but has no pin; init cannot append a second one.
    if (marker !== undefined) return { action: "keep" };
    return {
      action: "skip",
      note: `skills: ${skill.name} has no commit in its table. ${fix} to install it.`,
    };
  }
  // No table: record what is installed, or what this build ships.
  const pin = table === undefined ? (marker ?? skill) : undefined;
  const pinned = table?.commit ?? (marker ?? skill).commit;
  const extra = pin === undefined ? {} : { pin };
  if (pinned !== skill.commit) {
    const note = `skills: ${skill.name} is pinned to ${pinned}; this harnessd ships ${skill.commit}. ${fix} to update.`;
    return { action: marker === undefined ? "skip" : "keep", note, ...extra };
  }
  if (marker === undefined) return { action: "install", ...extra };
  return { action: marker.commit === pinned && !staleMarker ? "keep" : "update", ...extra };
}

/**
 * Installs the default skill pack into `<global>/skills/` (D-016) and records a pin in
 * config.toml for each skill that has none. A skill folder changes only when its pin
 * names the commit this build ships, so an upgrade never reaches agents without a
 * config change. Folders init did not install are never touched. false: it failed.
 */
async function installSkills({ io, sys }: Step): Promise<boolean> {
  const globalDir = globalDirFor(sys);
  const skillsDir = join(globalDir, "skills");
  const configFile = join(globalDir, "config.toml");
  const manifest = await sys.fs.read(join(sys.packDir, PACK_MANIFEST));
  if (manifest === undefined) {
    io.err(`harnessd init: no skill pack in ${sys.packDir}; reinstall @harnessd/cli.`);
    return false;
  }
  const pack = JSON.parse(manifest) as PackSkill[];
  const configText = (await sys.fs.read(configFile)) ?? "";
  let tables: Record<string, SkillSettings>;
  try {
    tables = parseConfigText(configText, configFile).skills ?? {};
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    io.err(`harnessd init: ${e.message}`);
    return false;
  }

  const plans: Array<{ skill: PackSkill; dest: string; plan: SkillPlan }> = [];
  for (const skill of pack) {
    const dest = join(skillsDir, skill.name);
    const present = await sys.fs.exists(dest);
    const markerText = await sys.fs.read(join(dest, PACK_MARKER));
    const marker = parseMarker(markerText);
    const shipped = await sys.fs.read(join(sys.packDir, skill.name, PACK_MARKER));
    const stale = markerFormat(shipped) > markerFormat(markerText);
    plans.push({
      skill,
      dest,
      plan: planSkill(skill, present, marker, tables[skill.name], configFile, stale),
    });
  }

  // Pins first: a folder is never installed without its pin on disk.
  const newPins = plans.flatMap(({ skill, plan }) =>
    "pin" in plan && plan.pin !== undefined ? [pinTable(skill.name, plan.pin)] : [],
  );
  if (newPins.length > 0) {
    const sep = configText === "" || configText.endsWith("\n") ? "" : "\n";
    const next = `${configText}${sep}\n${PIN_HEADER}\n${newPins.join("\n\n")}\n`;
    try {
      parseConfigText(next, configFile);
    } catch (e) {
      if (!(e instanceof ConfigError)) throw e;
      io.err(`harnessd init: cannot add skill pins to ${configFile}: ${e.message}`);
      return false;
    }
    await sys.fs.write(configFile, next);
  }

  const done = { install: [] as string[], update: [] as string[], keep: [] as string[] };
  for (const { skill, dest, plan } of plans) {
    if (plan.action === "foreign") {
      io.out(`skills: kept ${dest}; init did not install it`);
      continue;
    }
    if (plan.note !== undefined) io.out(plan.note);
    if (plan.action === "skip") continue;
    if (plan.action !== "keep") {
      await sys.fs.mkdirp(skillsDir);
      await sys.fs.copyDir(join(sys.packDir, skill.name), dest);
    }
    done[plan.action].push(skill.name);
  }
  for (const [verb, names] of [
    ["installed", done.install],
    ["updated", done.update],
    ["kept", done.keep],
  ] as const) {
    if (names.length > 0) io.out(`skills: ${verb} ${names.join(", ")} in ${skillsDir}`);
  }
  const pinned = plans.filter(({ plan }) => "pin" in plan && plan.pin !== undefined);
  if (pinned.length > 0) {
    io.out(`skills: pinned ${pinned.map((p) => p.skill.name).join(", ")} in ${configFile}`);
  }
  return true;
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
  ok = (await installSkills(step)) && ok;

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
    packDir: fileURLToPath(new URL("./pack", import.meta.url)),
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
      copyDir: async (from, to) => {
        // A dot name, so the config loader never reads a half-copied folder as a skill.
        const tmp = join(dirname(to), `.${basename(to)}.harnessd-tmp`);
        await rm(tmp, { recursive: true, force: true });
        await cp(from, tmp, { recursive: true });
        await rm(to, { recursive: true, force: true });
        await rename(tmp, to);
      },
    },
    exec: execNode,
    ...(process.stdin.isTTY && process.stdout.isTTY ? { confirm: askTty } : {}),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}
