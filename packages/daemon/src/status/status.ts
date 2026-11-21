// The status engine (MET-27): one list of checks for `harnessd doctor`, the start of
// `harnessd run` and GET /api/status. Harnesses and GitHub are checked through their
// own CLIs (D-002); Linear through one GraphQL read. Checks run in parallel, each
// group under a short timeout. No secret value ever reaches a detail or a fix.

import { access, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { ConfigError, DEFAULT_SETTINGS, type HarnessId, type MergedConfig } from "@harnessd/shared";
import { loadConfig } from "../config/load.ts";
import { LinearClient, LinearError } from "../linear/client.ts";
import {
  createSecretStore,
  type ResolvedSecret,
  SECRET_ENV,
  SecretError,
  type SecretId,
  type SecretStore,
} from "../secrets/store.ts";
import { missingHookEvents } from "../sync/settings.ts";
import {
  compareSemver,
  type Exec,
  type ExecResult,
  execFile,
  findOnPath,
  isExecutableFile,
  parseSemver,
} from "./detect.ts";
import { launchdPlistPath, parseServicePlist, wrapperExecPath } from "./launchd.ts";
import {
  OPENCODE_AUTH_LIST,
  OPENCODE_INSTALL,
  OPENCODE_MIN_VERSION,
  OPENCODE_UPGRADE,
  opencodeSigninCommand,
  parseAuthProviders,
  requiredProviders,
} from "./opencode.ts";

/**
 * ok: works. warn: works, but something is off; never blocks. fail: present but
 * broken. missing: required and absent (not installed, not set). fail and missing
 * both block `harnessd run` (D-023).
 */
export type CheckState = "ok" | "warn" | "fail" | "missing";

export interface Check {
  /** Stable, dotted: "harness.claude-code.auth". */
  id: string;
  state: CheckState;
  /** One line: what was found. */
  detail: string;
  /** One line: what to do. Empty when the state is ok. */
  fix: string;
}

export interface KnownBadVersion {
  harness: HarnessId;
  /** Versions below this one are bad. */
  below?: string;
  /** These exact versions are bad. */
  versions?: readonly string[];
  reason: string;
}

/** Harness releases harnessd is known not to work with. None is known yet. */
export const KNOWN_BAD_VERSIONS: readonly KnownBadVersion[] = [];

/**
 * The oldest Codex CLI harnessd is tested with. It has `exec --json`, `--ignore-user-config`,
 * `--ignore-rules` and `--dangerously-bypass-hook-trust`. Below it, harness.codex.version warns.
 */
export const CODEX_MIN_VERSION = "0.171.0";

export const STATUS_TIMEOUT_MS = 5_000;

/** The Linear states the loop moves issues through. */
export const REQUIRED_LINEAR_STATES = [
  "Ready",
  "In Progress",
  "In Review",
  "Done",
  "Needs input",
] as const;

export interface StatusOptions {
  repoDir: string;
  globalDir: string;
  env: NodeJS.ProcessEnv;
  exec?: Exec;
  isExecutable?: (path: string) => Promise<boolean>;
  fetch?: typeof fetch;
  /** True when 127.0.0.1:<port> can be bound. Default: tries it. */
  portFree?: (port: number) => Promise<boolean>;
  /** Default process.version and process.execPath. */
  nodeVersion?: string;
  nodePath?: string;
  /** Default process.platform. The service Node is checked on macOS only. */
  platform?: NodeJS.Platform;
  /** The launchd plist. Default ~/Library/LaunchAgents/dev.harnessd.daemon.plist under env.HOME. */
  servicePlist?: string;
  /** Reads a text file; undefined when it cannot be read. Default: fs.readFile. */
  readText?: (path: string) => Promise<string | undefined>;
  /** Per group of checks. Default 5 s. */
  timeoutMs?: number;
  /** Default skill pack names, expected in `<globalDir>/skills/`. */
  packSkills?: readonly string[];
  /** This process serves the API on daemon.port, so the port is in use by design. */
  servingPort?: boolean;
  knownBadVersions?: readonly KnownBadVersion[];
  /** Runs only the checks of these harnesses, whether an agent uses them or not (MET-28). */
  harnessesOnly?: readonly HarnessId[];
  /** Runs only these connections' checks, after a secret is saved (MET-33). */
  connectionsOnly?: readonly ("linear" | "slack")[];
  /** Where the Linear key and the Slack webhook come from. Default: the store in globalDir. */
  secrets?: SecretStore;
}

export function isBlocking(check: Check): boolean {
  return check.state === "fail" || check.state === "missing";
}

const ok = (id: string, detail: string): Check => ({ id, state: "ok", detail, fix: "" });
const bad = (id: string, state: Exclude<CheckState, "ok">, detail: string, fix: string): Check => ({
  id,
  state,
  detail,
  fix,
});
const notChecked = (id: string, first: string): Check =>
  bad(id, "missing", "not checked", `Fix ${first} first.`);

/** The first line of a command's error output, for a detail. */
function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l !== "") ?? ""
  );
}

interface Ctx {
  o: StatusOptions;
  exec: Exec;
  isExec: (path: string) => Promise<boolean>;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  config: MergedConfig | undefined;
  secrets: SecretStore;
}

/** A secret, or why it could not be read. The reason never holds the value. */
async function lookup(
  ctx: Ctx,
  id: SecretId,
): Promise<ResolvedSecret | { error: string; reference: boolean } | undefined> {
  try {
    return await ctx.secrets.resolve(id);
  } catch (e) {
    if (e instanceof SecretError) return { error: e.message, reference: true };
    if (e instanceof ConfigError) return { error: e.message, reference: false };
    return { error: `could not read the secret: ${(e as Error).message}`, reference: false };
  }
}

const SOURCE_FIX: Record<SecretId, string> = {
  "linear.api_key": "Settings, Connections, Linear",
  "slack.webhook_url": "Settings, Connections, Slack",
};

/**
 * Checks that run in order inside one group; groups run in parallel. Every command
 * a group runs is killed at the group's deadline, and none starts after it.
 */
interface Group {
  ids: string[];
  run: (deadline: number) => Promise<Check[]>;
}

const timedOut = (ms: number) => `timed out after ${ms / 1000} s`;

/** Runs one command, killed at the deadline. Past the deadline it returns code 124. */
function run(
  ctx: Ctx,
  deadline: number,
  cmd: string,
  args: readonly string[],
): Promise<ExecResult> {
  const left = deadline - Date.now();
  if (left <= 0) return Promise.resolve({ code: 124, stdout: "", stderr: timedOut(ctx.timeoutMs) });
  return ctx.exec(cmd, args, { cwd: ctx.o.repoDir, env: ctx.env, timeoutMs: left });
}

/**
 * The binary `[harnesses.<id>] bin` names in the config, else the one `envBin` names, else
 * `bin` on PATH; or why there is none.
 */
async function locate(
  ctx: Pick<Ctx, "config" | "env" | "isExec">,
  bin: string,
  envBin: string,
  harness?: HarnessId,
): Promise<{ path: string } | { absent: string }> {
  const configured = harness ? ctx.config?.harnesses[harness]?.bin : undefined;
  if (configured) {
    return (await ctx.isExec(configured))
      ? { path: configured }
      : { absent: `${configured} (harnesses.${harness}.bin) is not executable` };
  }
  const override = ctx.env[envBin]?.trim();
  if (override) {
    return (await ctx.isExec(override))
      ? { path: override }
      : { absent: `${override} (${envBin}) is not executable` };
  }
  const path = await findOnPath(ctx.env, bin, ctx.isExec);
  return path === undefined ? { absent: `${bin} is not on PATH` } : { path };
}

async function versionOf(ctx: Ctx, deadline: number, path: string): Promise<string> {
  const res = await run(ctx, deadline, path, ["--version"]);
  const line = `${res.stdout}\n${res.stderr}`.split("\n").find((l) => l.trim() !== "");
  return res.code === 0 && line ? line.trim() : "version unknown";
}

const NODE_FIX_SERVICE = "Run the Install block with Node 24 active, then harnessd init.";

/**
 * The Node the launchd service runs, when it is not this one (MET-38). launchd loads no
 * shell profile and no nvm, so the service can run another Node. Undefined: no plist,
 * not macOS, an unreadable plist or wrapper, or the same Node; the check stays as it is.
 */
async function serviceNode(
  ctx: Ctx,
  current: string,
): Promise<{ path: string } | { absent: string } | undefined> {
  const platform = ctx.o.platform ?? process.platform;
  if (platform !== "darwin") return undefined;
  const home = ctx.env.HOME?.trim();
  const file = ctx.o.servicePlist ?? (home ? launchdPlistPath(home) : undefined);
  if (file === undefined) return undefined;
  const read = ctx.o.readText ?? ((p: string) => readFile(p, "utf8").catch(() => undefined));
  const text = await read(file);
  const plist = text === undefined ? undefined : parseServicePlist(text);
  if (plist === undefined) return undefined;
  const program = await read(plist.program);
  if (program === undefined) return undefined;
  const wrapped = wrapperExecPath(program);
  let path: string | undefined;
  if (wrapped !== undefined) {
    if (wrapped === current) return undefined;
    if (!(await ctx.isExec(wrapped))) return { absent: `the service Node ${wrapped} is missing` };
    path = wrapped;
  } else {
    path = await findOnPath({ PATH: plist.path ?? "" }, "node", ctx.isExec);
    if (path === undefined) return { absent: "the service Node is not on its PATH" };
    if (path === current) return undefined;
  }
  return { path };
}

function nodeGroup(ctx: Ctx): Group {
  return {
    ids: ["node"],
    run: async (deadline) => {
      const version = ctx.o.nodeVersion ?? process.version;
      const path = ctx.o.nodePath ?? process.execPath;
      const major = parseSemver(version)?.[0] ?? 0;
      if (major < 24) {
        return [
          bad(
            "node",
            "fail",
            `${version} (${path}); harnessd needs 24 or newer`,
            "Install Node 24: nvm install 24 && nvm alias default 24, or brew install node@24.",
          ),
        ];
      }
      const here = `${version} (${path})`;
      const service = await serviceNode(ctx, path);
      if (service === undefined) return [ok("node", here)];
      if ("absent" in service) {
        return [bad("node", "fail", `${here}; ${service.absent}`, NODE_FIX_SERVICE)];
      }
      const res = await run(ctx, deadline, service.path, ["--version"]);
      const line = firstLine(res.stdout);
      if (res.code !== 0 || line === "") {
        return [
          bad(
            "node",
            "fail",
            `${here}; the service Node ${service.path} does not run`,
            NODE_FIX_SERVICE,
          ),
        ];
      }
      const uses = `${here}; the service uses ${line} (${service.path})`;
      if ((parseSemver(line)?.[0] ?? 0) >= 24) return [ok("node", uses)];
      return [bad("node", "fail", `${uses}; harnessd needs 24 or newer`, NODE_FIX_SERVICE)];
    },
  };
}

interface HarnessSpec {
  bin: string;
  envBin: string;
  /** How the CLI installs and updates: an npm package, or a command to copy and its own upgrade. */
  setup:
    | { kind: "npm"; pkg: string }
    | {
        kind: "self";
        /** The official installer, to copy into a terminal. */
        install: string;
        /** The fix when the CLI is not found. */
        missing: string;
        /** argv after the binary that updates it. */
        updateArgs: readonly string[];
      };
  /** argv that reports sign-in without spending tokens. */
  status: readonly string[];
  signedIn: (
    stdout: string,
    code: number,
    config: MergedConfig | undefined,
  ) => { state: "ok" | "fail" | "warn"; detail: string; fix?: string };
  login: string;
  /** The oldest tested version. Below it, or when unreadable, the version check warns. */
  minVersion?: string;
  /** argv of the CLI's own login, run by Settings sign-in (D-031). Undefined: no app sign-in. */
  loginArgs?: string[];
}

/** The OpenCode sign-in check: every provider an opencode agent names must be signed in. */
function opencodeSignedIn(
  stdout: string,
  code: number,
  config: MergedConfig | undefined,
): { state: "ok" | "fail" | "warn"; detail: string; fix?: string } {
  const signed = code === 0 ? parseAuthProviders(stdout) : undefined;
  if (signed === undefined) {
    return {
      state: "warn",
      detail: "could not read the signed-in providers",
      fix: "Run: opencode auth list",
    };
  }
  const required = requiredProviders(config);
  const missing = required.filter((p) => !signed.includes(p));
  if (missing.length > 0) {
    return {
      state: "fail",
      detail: `not signed in: ${missing.join(", ")}`,
      fix: `Sign in each in Settings, Harnesses, OpenCode, or run: ${opencodeSigninCommand(missing[0] ?? "")}`,
    };
  }
  if (required.length > 0) return { state: "ok", detail: `signed in: ${required.join(", ")}` };
  if (signed.length > 0) return { state: "ok", detail: `signed in: ${signed.join(", ")}` };
  return {
    state: "warn",
    detail: "no provider is signed in, and no opencode agent names one",
    fix: 'Set model = "<provider>/<model>" on the agent, then sign that provider in.',
  };
}

const HARNESS_SPECS: Partial<Record<HarnessId, HarnessSpec>> = {
  "claude-code": {
    bin: "claude",
    envBin: "HARNESSD_CLAUDE_BIN",
    setup: { kind: "npm", pkg: "@anthropic-ai/claude-code" },
    status: ["auth", "status", "--json"],
    signedIn: (stdout) => {
      let parsed: { loggedIn?: unknown; authMethod?: unknown };
      try {
        parsed = JSON.parse(stdout);
      } catch {
        return { state: "warn", detail: "could not read the sign-in status" };
      }
      if (parsed.loggedIn !== true) return { state: "fail", detail: "not signed in" };
      const method = typeof parsed.authMethod === "string" ? ` (${parsed.authMethod})` : "";
      return { state: "ok", detail: `signed in${method}` };
    },
    login: "Run: claude auth login",
    loginArgs: ["auth", "login"],
  },
  codex: {
    bin: "codex",
    envBin: "HARNESSD_CODEX_BIN",
    setup: { kind: "npm", pkg: "@openai/codex" },
    status: ["login", "status"],
    // Its output can name a masked key, so only the exit code is read.
    signedIn: (_stdout, code) =>
      code === 0
        ? { state: "ok", detail: "signed in" }
        : { state: "fail", detail: "not signed in" },
    login: "Run: codex login",
    minVersion: CODEX_MIN_VERSION,
    loginArgs: ["login"],
  },
  opencode: {
    bin: "opencode",
    envBin: "HARNESSD_OPENCODE_BIN",
    setup: {
      kind: "self",
      install: OPENCODE_INSTALL,
      missing: `Install it: ${OPENCODE_INSTALL}. It goes in ~/.opencode/bin; add that to PATH or set [harnesses.opencode] bin.`,
      updateArgs: OPENCODE_UPGRADE,
    },
    // Only provider ids are read from this list; never a credential field.
    status: OPENCODE_AUTH_LIST,
    signedIn: opencodeSignedIn,
    login: "Run: opencode auth login <provider>",
    minVersion: OPENCODE_MIN_VERSION,
  },
};

/** One setup command: the argv the daemon runs, and the text a person would type. */
export interface SetupCommand {
  /** "npm", or undefined for the harness's own binary. */
  cmd?: "npm";
  args: string[];
  text: string;
}

export interface HarnessSetupSpec {
  bin: string;
  /** Undefined when the app does not run the install: the person copies `installText`. */
  install?: SetupCommand;
  installText: string;
  update: SetupCommand;
  login: string;
  /** Undefined when sign-in is not one fixed command, as for OpenCode providers. */
  loginArgs?: string[];
}

/**
 * The fixed setup commands of a harness, for the commands the app runs (MET-28). Undefined
 * for a harness harnessd has no checks for yet.
 */
export function harnessSetupSpec(harness: HarnessId): HarnessSetupSpec | undefined {
  const spec = HARNESS_SPECS[harness];
  if (!spec) return undefined;
  const login = spec.login.replace(/^Run: /, "");
  const loginArgs = spec.loginArgs === undefined ? {} : { loginArgs: [...spec.loginArgs] };
  if (spec.setup.kind === "self") {
    const args = [...spec.setup.updateArgs];
    return {
      bin: spec.bin,
      installText: spec.setup.install,
      update: { args, text: [spec.bin, ...args].join(" ") },
      login,
      ...loginArgs,
    };
  }
  const pkg = spec.setup.pkg;
  return {
    bin: spec.bin,
    install: { cmd: "npm", args: ["install", "-g", pkg], text: `npm install -g ${pkg}` },
    installText: `npm install -g ${pkg}`,
    update: {
      cmd: "npm",
      args: ["install", "-g", `${pkg}@latest`],
      text: `npm install -g ${pkg}@latest`,
    },
    login,
    ...loginArgs,
  };
}

/**
 * Finds a harness CLI the way the status engine does: `[harnesses.<id>] bin`, then the
 * `HARNESSD_*_BIN` variable, then PATH (D-026). Sign-in runs this same file (D-031).
 */
/** Where to look for each harness CLI. OpenCode has the lookup before its checks (MET-71). */
const HARNESS_LOOKUP: Partial<Record<HarnessId, { bin: string; envBin: string }>> = {
  ...HARNESS_SPECS,
  opencode: { bin: "opencode", envBin: "HARNESSD_OPENCODE_BIN" },
};

export async function locateHarness(
  harness: HarnessId,
  o: {
    config: MergedConfig | undefined;
    env: NodeJS.ProcessEnv;
    isExecutable?: (path: string) => Promise<boolean>;
  },
): Promise<{ path: string } | { absent: string }> {
  const spec = HARNESS_LOOKUP[harness];
  if (!spec) return { absent: `harnessd has no checks for ${harness} yet` };
  const ctx = { config: o.config, env: o.env, isExec: o.isExecutable ?? isExecutableFile };
  return locate(ctx, spec.bin, spec.envBin, harness);
}

/** The fix that updates a harness CLI. */
function updateFix(spec: HarnessSpec): string {
  return spec.setup.kind === "npm"
    ? `Run npm install -g ${spec.setup.pkg}@latest.`
    : `Run: ${[spec.bin, ...spec.setup.updateArgs].join(" ")}`;
}

/** The short update fix, as the auth and known-bad checks word it. */
function updateItFix(spec: HarnessSpec): string {
  return spec.setup.kind === "npm"
    ? `Update it: npm i -g ${spec.setup.pkg}@latest`
    : updateFix(spec);
}

function harnessGroup(ctx: Ctx, harness: HarnessId): Group {
  const p = `harness.${harness}`;
  const ids = [`${p}.cli`, `${p}.auth`, `${p}.version`];
  const spec = HARNESS_SPECS[harness];
  if (spec === undefined) {
    return {
      ids: [`${p}.cli`],
      run: async () => [
        bad(
          `${p}.cli`,
          "warn",
          "harnessd has no checks for this harness yet",
          "Use claude-code, codex or opencode.",
        ),
      ],
    };
  }
  const install =
    spec.setup.kind === "npm" ? `Install it: npm i -g ${spec.setup.pkg}` : spec.setup.missing;
  return {
    ids,
    run: async (deadline) => {
      const found = await locate(ctx, spec.bin, spec.envBin, harness);
      if ("absent" in found) {
        return [
          bad(`${p}.cli`, "missing", found.absent, install),
          notChecked(`${p}.auth`, `${p}.cli`),
          notChecked(`${p}.version`, `${p}.cli`),
        ];
      }
      const path = found.path;
      const version = await versionOf(ctx, deadline, path);
      const cli = ok(`${p}.cli`, `${version} (${path})`);

      const res = await run(ctx, deadline, path, spec.status);
      const signed =
        res.code === 124
          ? { state: "fail" as const, detail: `sign-in check ${timedOut(ctx.timeoutMs)}` }
          : spec.signedIn(res.stdout, res.code, ctx.config);
      const auth =
        signed.state === "ok"
          ? ok(`${p}.auth`, signed.detail)
          : bad(
              `${p}.auth`,
              signed.state,
              signed.detail,
              ("fix" in signed ? signed.fix : undefined) ??
                (signed.state === "warn" ? updateItFix(spec) : spec.login),
            );
      return [cli, auth, versionCheck(ctx, harness, `${p}.version`, version, spec)];
    },
  };
}

function versionCheck(
  ctx: Ctx,
  harness: HarnessId,
  id: string,
  line: string,
  spec: HarnessSpec,
): Check {
  const min = spec.minVersion;
  const update = updateFix(spec);
  const v = parseSemver(line);
  if (v === undefined) {
    if (min !== undefined) return bad(id, "warn", `version unknown; the minimum is ${min}`, update);
    const reinstall =
      spec.setup.kind === "npm" ? `Reinstall it: npm i -g ${spec.setup.pkg}` : spec.setup.missing;
    return bad(id, "warn", "version unknown", reinstall);
  }
  const text = v.join(".");
  const floor = min === undefined ? undefined : parseSemver(min);
  if (floor !== undefined && compareSemver(v, floor) < 0) {
    return bad(id, "warn", `${text} is below the minimum ${min}`, update);
  }
  for (const known of ctx.o.knownBadVersions ?? KNOWN_BAD_VERSIONS) {
    if (known.harness !== harness) continue;
    const below = known.below === undefined ? undefined : parseSemver(known.below);
    const hit =
      (below !== undefined && compareSemver(v, below) < 0) || (known.versions ?? []).includes(text);
    if (hit) {
      return bad(id, "warn", `${text} is known bad: ${known.reason}`, updateItFix(spec));
    }
  }
  return ok(id, `${text} has no known problems`);
}

const WRITE_PERMISSIONS = new Set(["ADMIN", "MAINTAIN", "WRITE"]);

function githubGroup(ctx: Ctx): Group {
  const ids = ["github.cli", "github.auth", "github.push", "github.ci"];
  return {
    ids,
    run: async (deadline) => {
      const found = await locate(ctx, "gh", "HARNESSD_GH_BIN");
      if ("absent" in found) {
        return [
          bad("github.cli", "missing", found.absent, "Install it: brew install gh"),
          ...ids.slice(1).map((id) => notChecked(id, "github.cli")),
        ];
      }
      const gh = found.path;
      const out: Check[] = [ok("github.cli", `${await versionOf(ctx, deadline, gh)} (${gh})`)];

      // gh can print a masked token here, so only the exit code is read.
      const auth = await run(ctx, deadline, gh, ["auth", "status", "--active"]);
      if (auth.code !== 0) {
        const detail = auth.code === 124 ? timedOut(ctx.timeoutMs) : "not signed in";
        out.push(bad("github.auth", "fail", detail, "Run: gh auth login"));
        return [
          ...out,
          notChecked("github.push", "github.auth"),
          notChecked("github.ci", "github.auth"),
        ];
      }
      out.push(ok("github.auth", "signed in"));

      const view = await run(ctx, deadline, gh, [
        "repo",
        "view",
        "--json",
        "nameWithOwner,viewerPermission,defaultBranchRef",
      ]);
      let repo: {
        nameWithOwner?: string;
        viewerPermission?: string;
        defaultBranchRef?: { name?: string };
      };
      try {
        if (view.code !== 0) throw new Error(firstLine(view.stderr) || `gh exited ${view.code}`);
        repo = JSON.parse(view.stdout);
      } catch (e) {
        out.push(
          bad(
            "github.push",
            "fail",
            `no GitHub repo for ${ctx.o.repoDir}: ${(e as Error).message}`,
            "Run harnessd in a clone with a GitHub remote named origin.",
          ),
        );
        return [...out, notChecked("github.ci", "github.push")];
      }
      const name = repo.nameWithOwner ?? "the repo";
      const permission = repo.viewerPermission ?? "NONE";
      out.push(
        WRITE_PERMISSIONS.has(permission)
          ? ok("github.push", `${permission} on ${name}`)
          : bad(
              "github.push",
              "fail",
              `${permission} on ${name}; harnessd needs WRITE`,
              `Ask an admin of ${name} for write access, or sign gh in as another account.`,
            ),
      );
      out.push(await ciCheck(ctx, deadline, gh, repo.defaultBranchRef?.name ?? "main"));
      return out;
    },
  };
}

/**
 * The status checks the default branch requires, from its rulesets and from classic
 * branch protection. Classic protection needs admin rights to read, so its errors
 * are ignored.
 */
async function ciCheck(ctx: Ctx, deadline: number, gh: string, branch: string): Promise<Check> {
  const fix = `Require the CI check on ${branch} in a ruleset; the merge gate trusts CI (D-013).`;
  const rules = await run(ctx, deadline, gh, [
    "api",
    `repos/{owner}/{repo}/rules/branches/${branch}`,
  ]);
  if (rules.code !== 0) {
    return bad(
      "github.ci",
      "warn",
      `could not read the rules for ${branch}: ${firstLine(rules.stderr)}`,
      fix,
    );
  }
  const names = new Set<string>();
  try {
    const parsed = JSON.parse(rules.stdout) as Array<{
      type?: string;
      parameters?: { required_status_checks?: Array<{ context?: string }> };
    }>;
    for (const rule of Array.isArray(parsed) ? parsed : []) {
      if (rule.type !== "required_status_checks") continue;
      for (const c of rule.parameters?.required_status_checks ?? []) {
        if (typeof c.context === "string") names.add(c.context);
      }
    }
  } catch {
    return bad("github.ci", "warn", `could not read the rules for ${branch}`, fix);
  }
  const classic = await run(ctx, deadline, gh, [
    "api",
    `repos/{owner}/{repo}/branches/${branch}/protection/required_status_checks`,
  ]);
  if (classic.code === 0) {
    try {
      const parsed = JSON.parse(classic.stdout) as { contexts?: unknown };
      for (const c of Array.isArray(parsed.contexts) ? parsed.contexts : []) {
        if (typeof c === "string") names.add(c);
      }
    } catch {
      // Not JSON: count it as no classic protection.
    }
  }
  if (names.size === 0) return bad("github.ci", "warn", `no required checks on ${branch}`, fix);
  return ok("github.ci", `${branch} requires: ${[...names].sort().join(", ")}`);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const LINEAR_VIEWER_QUERY = "query HarnessdStatus { viewer { id } }";
const LINEAR_TEAM_QUERY = `query HarnessdStatusTeam($filter: TeamFilter) {
  viewer { id }
  teams(filter: $filter, first: 1) { nodes { id key states(first: 100) { nodes { name } } } }
}`;

interface LinearStatus {
  viewer?: { id: string };
  teams?: { nodes: Array<{ key: string; states: { nodes: Array<{ name: string }> } }> };
}

function linearGroup(ctx: Ctx): Group {
  const ids = ["linear.key", "linear.team", "linear.states"];
  return {
    ids,
    run: async (deadline) => {
      const secret = await lookup(ctx, "linear.api_key");
      const teamId = ctx.config?.linear.team_id?.trim();
      const waiting = [
        notChecked("linear.team", "linear.key"),
        notChecked("linear.states", "linear.key"),
      ];
      if (secret === undefined) {
        return [
          bad(
            "linear.key",
            "missing",
            `no key is saved and ${SECRET_ENV["linear.api_key"]} is not set`,
            `Paste a Linear personal API key in ${SOURCE_FIX["linear.api_key"]}.`,
          ),
          ...waiting,
        ];
      }
      if ("error" in secret) {
        return [
          bad(
            "linear.key",
            "fail",
            secret.error,
            secret.reference
              ? `Fix the 1Password reference, or replace it in ${SOURCE_FIX["linear.api_key"]}.`
              : "Fix the key named above; see docs/CONFIG.md.",
          ),
          ...waiting,
        ];
      }
      const key = secret.value;
      const source = secret.source;
      const baseFetch = ctx.o.fetch ?? fetch;
      const client = new LinearClient({
        apiKey: async () => key,
        fetch: ((url, init) =>
          baseFetch(url, {
            ...init,
            signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
          })) as typeof fetch,
        maxRetryWaitMs: 0,
      });
      let data: LinearStatus;
      try {
        data = teamId
          ? await client.request<LinearStatus>(LINEAR_TEAM_QUERY, {
              filter: UUID.test(teamId)
                ? { id: { eq: teamId } }
                : { key: { eqIgnoreCase: teamId } },
            })
          : await client.request<LinearStatus>(LINEAR_VIEWER_QUERY, {});
      } catch (e) {
        const auth = e instanceof LinearError && e.code === "auth";
        return [
          bad(
            "linear.key",
            "fail",
            auth
              ? `Linear rejected the key (${source})`
              : `Linear unreachable: ${(e as Error).message}`,
            auth
              ? `Create a new personal API key in Linear, then replace it in ${SOURCE_FIX["linear.api_key"]}.`
              : "Check the network, then run harnessd doctor again.",
          ),
          notChecked("linear.team", "linear.key"),
          notChecked("linear.states", "linear.key"),
        ];
      }
      const out: Check[] = [ok("linear.key", `accepted (${source})`)];
      if (!teamId) {
        return [
          ...out,
          bad(
            "linear.team",
            "missing",
            "linear.team_id is not set",
            'Add team_id = "MET" (your team key) under [linear] in .harnessd/config.toml.',
          ),
          notChecked("linear.states", "linear.team"),
        ];
      }
      const team = data.teams?.nodes[0];
      if (team === undefined) {
        return [
          ...out,
          bad(
            "linear.team",
            "fail",
            `no team ${teamId} for this key`,
            "Set linear.team_id to a team key or id this key can read.",
          ),
          notChecked("linear.states", "linear.team"),
        ];
      }
      out.push(ok("linear.team", team.key));
      const have = new Set(team.states.nodes.map((s) => s.name.toLowerCase()));
      const missing = REQUIRED_LINEAR_STATES.filter((s) => !have.has(s.toLowerCase()));
      out.push(
        missing.length === 0
          ? ok("linear.states", REQUIRED_LINEAR_STATES.join(", "))
          : bad(
              "linear.states",
              "fail",
              `missing: ${missing.join(", ")}`,
              `Add the states in Linear: Settings, Teams, ${team.key}, Workflow.`,
            ),
      );
      return out;
    },
  };
}

function slackGroup(ctx: Ctx): Group {
  const fix = `Create a Slack incoming webhook, then paste its url in ${SOURCE_FIX["slack.webhook_url"]}.`;
  return {
    ids: ["slack.webhook"],
    run: async () => {
      const secret = await lookup(ctx, "slack.webhook_url");
      if (secret === undefined) {
        return [
          bad(
            "slack.webhook",
            "warn",
            `no webhook is saved and ${SECRET_ENV["slack.webhook_url"]} is not set; no Slack lines are sent`,
            fix,
          ),
        ];
      }
      if ("error" in secret) {
        return [bad("slack.webhook", "warn", `${secret.error}; no Slack lines are sent`, fix)];
      }
      if (!secret.value.startsWith("https://")) {
        return [
          bad(
            "slack.webhook",
            "warn",
            `the webhook (${secret.source}) is not an https url; no Slack lines are sent`,
            fix,
          ),
        ];
      }
      return [ok("slack.webhook", `set (${secret.source})`)];
    },
  };
}

function gitGroup(ctx: Ctx): Group {
  return {
    ids: ["git.worktrees"],
    run: async (deadline) => {
      const git = await findOnPath(ctx.env, "git", ctx.isExec);
      if (git === undefined) {
        return [
          bad(
            "git.worktrees",
            "missing",
            "git is not on PATH",
            "Install git: xcode-select --install",
          ),
        ];
      }
      const res = await run(ctx, deadline, git, ["worktree", "list", "--porcelain"]);
      if (res.code === 0) {
        const count = res.stdout.split("\n").filter((l) => l.startsWith("worktree ")).length;
        return [
          ok("git.worktrees", `${count} worktree${count === 1 ? "" : "s"} in ${ctx.o.repoDir}`),
        ];
      }
      return [
        bad(
          "git.worktrees",
          "fail",
          firstLine(res.stderr) || `git worktree exited ${res.code}`,
          "Run harnessd in a git clone, with git 2.5 or newer.",
        ),
      ];
    },
  };
}

function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

/** True when a harnessd API answers /health on the port. */
async function harnessdOn(ctx: Ctx, deadline: number, port: number): Promise<boolean> {
  try {
    const res = await (ctx.o.fetch ?? fetch)(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
    });
    const body = (await res.json()) as { ok?: unknown; version?: unknown };
    return body.ok === true && typeof body.version === "string";
  } catch {
    return false;
  }
}

function portGroup(ctx: Ctx): Group {
  return {
    ids: ["daemon.port"],
    run: async (deadline) => {
      const port = ctx.config?.daemon.port ?? DEFAULT_SETTINGS.daemon.port;
      if (port === 0) return [ok("daemon.port", "0: a free port is picked at start")];
      if (ctx.o.servingPort) return [ok("daemon.port", `${port} is served by this daemon`)];
      if (await (ctx.o.portFree ?? portIsFree)(port)) return [ok("daemon.port", `${port} is free`)];
      if (await harnessdOn(ctx, deadline, port)) {
        return [
          bad(
            "daemon.port",
            "warn",
            `${port} is in use by a running harnessd`,
            "To start another harnessd run, give it its own daemon.port in .harnessd/config.toml.",
          ),
        ];
      }
      return [
        bad(
          "daemon.port",
          "fail",
          `${port} is in use`,
          "Stop the other harnessd run, or set daemon.port in .harnessd/config.toml.",
        ),
      ];
    },
  };
}

const CLAUDE_SETTINGS = ".claude/settings.json";

/** Enabled skills whose Claude Code hooks the repo's settings file lacks (docs/SYNC.md). */
async function skillsWithoutHook(ctx: Ctx): Promise<string[]> {
  const skills = (ctx.config?.skills ?? []).filter((s) => s.native?.claudeHooks !== undefined);
  if (skills.length === 0) return [];
  const text = await readFile(join(ctx.o.repoDir, CLAUDE_SETTINGS), "utf8").catch(() => undefined);
  return skills
    .filter((s) => missingHookEvents(text, s.native?.claudeHooks ?? {}).length > 0)
    .map((s) => s.name);
}

function skillsGroup(ctx: Ctx, names: readonly string[]): Group {
  return {
    ids: ["skills.pack"],
    run: async () => {
      const dir = join(ctx.o.globalDir, "skills");
      const present = await Promise.all(
        names.map((n) =>
          access(join(dir, n, "SKILL.md")).then(
            () => true,
            () => false,
          ),
        ),
      );
      const missing = names.filter((_, i) => !present[i]);
      const found = names.length - missing.length;
      if (missing.length === 0) {
        const inPlace = `${found} of ${names.length} skills in place`;
        const unhooked = await skillsWithoutHook(ctx);
        if (unhooked.length === 0) return [ok("skills.pack", inPlace)];
        return [
          bad(
            "skills.pack",
            "warn",
            `${inPlace}; ${unhooked.join(", ")} hook missing from ${CLAUDE_SETTINGS}`,
            "Run: harnessd sync",
          ),
        ];
      }
      const list =
        missing.length > 3
          ? `${missing.slice(0, 3).join(", ")} and ${missing.length - 3} more`
          : missing.join(", ");
      return [
        bad(
          "skills.pack",
          "warn",
          `${found} of ${names.length} skills in place; missing ${list}`,
          "Run: harnessd init",
        ),
      ];
    },
  };
}

/** Extra time for a group to report after its deadline killed a command. */
const GUARD_GRACE_MS = 250;

/**
 * Runs a group with a deadline. A group reports its own timeouts; only a group that
 * still has not answered after the grace fails every check it owns.
 */
async function guarded(group: Group, timeoutMs: number): Promise<Check[]> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<Check[]>((resolve) => {
    timer = setTimeout(
      () =>
        resolve(
          group.ids.map((id) =>
            bad(id, "fail", timedOut(timeoutMs), "Run harnessd doctor again; check the network."),
          ),
        ),
      timeoutMs + GUARD_GRACE_MS,
    );
  });
  try {
    return await Promise.race([
      group
        .run(Date.now() + timeoutMs)
        .catch((e: unknown) =>
          group.ids.map((id) =>
            bad(id, "fail", `check failed: ${(e as Error).message}`, "Run harnessd doctor again."),
          ),
        ),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Env values that must never be printed: keys, tokens, secrets, passwords, webhooks. */
function secretsIn(env: NodeJS.ProcessEnv): string[] {
  return Object.entries(env)
    .filter(
      ([name, v]) =>
        /KEY|TOKEN|SECRET|PASSWORD|WEBHOOK/i.test(name) && v !== undefined && v.trim().length >= 6,
    )
    .map(([, v]) => (v ?? "").trim())
    .sort((a, b) => b.length - a.length);
}

/** Replaces each env secret value in `text` with `***`, as the checks do (MET-58). */
export function maskEnvSecrets(text: string, env: NodeJS.ProcessEnv): string {
  return redact(text, secretsIn(env));
}

function redact(text: string, secrets: readonly string[]): string {
  let out = text.replaceAll(/\r?\n/g, " ");
  for (const s of secrets) out = out.replaceAll(s, "***");
  return out;
}

/**
 * Runs every check for the workspace at `repoDir` and returns them in a fixed order:
 * node, config, each configured harness, GitHub, Linear, Slack, git, the port, skills.
 * It never throws: a broken part is a check, not an exception.
 */
export async function runStatus(options: StatusOptions): Promise<Check[]> {
  const env = options.env;
  const timeoutMs = options.timeoutMs ?? STATUS_TIMEOUT_MS;
  let config: MergedConfig | undefined;
  let configCheck: Check;
  try {
    config = await loadConfig({
      globalDir: options.globalDir,
      workspaceDir: join(options.repoDir, ".harnessd"),
    });
    configCheck = ok("config", `${Object.keys(config.agents).length} agents`);
  } catch (e) {
    configCheck = bad(
      "config",
      "fail",
      e instanceof ConfigError ? e.message : `could not load the config: ${(e as Error).message}`,
      "Fix the key named above; see docs/CONFIG.md.",
    );
  }
  const ctx: Ctx = {
    o: options,
    exec: options.exec ?? execFile,
    isExec: options.isExecutable ?? isExecutableFile,
    env,
    timeoutMs,
    config,
    secrets:
      options.secrets ??
      createSecretStore({
        globalDir: options.globalDir,
        env,
        exec: options.exec ?? execFile,
      }),
  };
  const harnesses = [...new Set(Object.values(config?.agents ?? {}).map((a) => a.harness))];
  if (harnesses.length === 0) harnesses.push("claude-code");
  harnesses.sort((a, b) =>
    a === "claude-code" ? -1 : b === "claude-code" ? 1 : a.localeCompare(b),
  );

  // Values read from the store are masked too; they are known once the groups have run.
  const clean = (c: Check): Check => {
    const secrets = [...ctx.secrets.known(), ...secretsIn(env)].sort((a, b) => b.length - a.length);
    return { ...c, detail: redact(c.detail, secrets), fix: redact(c.fix, secrets) };
  };
  if (options.harnessesOnly) {
    const only = await Promise.all(
      options.harnessesOnly.map((h) => guarded(harnessGroup(ctx, h), timeoutMs)),
    );
    return only.flat().map(clean);
  }
  if (options.connectionsOnly) {
    const groups = { linear: linearGroup, slack: slackGroup };
    const only = await Promise.all(
      options.connectionsOnly.map((g) => guarded(groups[g](ctx), timeoutMs)),
    );
    return only.flat().map(clean);
  }

  const groups: Group[] = [
    nodeGroup(ctx),
    ...harnesses.map((h) => harnessGroup(ctx, h)),
    githubGroup(ctx),
    linearGroup(ctx),
    slackGroup(ctx),
    gitGroup(ctx),
    portGroup(ctx),
    ...(options.packSkills ? [skillsGroup(ctx, options.packSkills)] : []),
  ];
  const results = await Promise.all(groups.map((g) => guarded(g, timeoutMs)));
  const [node = [], ...rest] = results;
  return [...node, configCheck, ...rest.flat()].map(clean);
}
