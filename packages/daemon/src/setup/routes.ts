// Settings routes (MET-28): harness cards with fixed setup commands, the binary path, and
// the team. The daemon runs only the fixed command for each harness and action; no text
// from a request reaches a command line. Writes go through the config validator first.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type AgentRole,
  ConfigError,
  DEFAULT_AGENTS,
  type HarnessId,
  harnessName,
  hasControlChar,
  parseConfigFile,
  type TeamRow,
  validateTeam,
} from "@harnessd/shared";
import { parse } from "smol-toml";
import { applyTableKey, withFileLock } from "../config/edit.ts";
import { loadConfig } from "../config/load.ts";
import { applyTeam, type TeamChange, TeamEditError } from "../config/team.ts";
import { EventStream, HttpError, type Route, type SendEvent } from "../server/router.ts";
import { isExecutableFile } from "../status/detect.ts";
import {
  type Check,
  harnessSetupSpec,
  locateHarness,
  maskEnvSecrets,
  type StatusOptions,
} from "../status/status.ts";
import { type SyncResult, syncRepo } from "../sync/sync.ts";
import { parseLoginPrompt } from "./login-prompt.ts";

/** The harnesses the Settings page shows a card for. */
export const SETUP_HARNESSES = ["claude-code", "codex"] as const satisfies readonly HarnessId[];
type SetupHarness = (typeof SETUP_HARNESSES)[number];

export type HarnessAction = "install" | "update" | "signin";
const ACTIONS: readonly HarnessAction[] = ["install", "update", "signin"];

/** Runs one command without a shell and calls `onLine` for each output line. Resolves the exit code. */
export type SetupRunner = (
  cmd: string,
  args: readonly string[],
  onLine: (line: string) => void,
) => Promise<number>;

export interface SetupOptions {
  repoDir: string;
  globalDir: string;
  env: NodeJS.ProcessEnv;
  /** The status engine, with options merged over the daemon's own. */
  checks: (options: Partial<StatusOptions>) => Promise<Check[]>;
  runner?: SetupRunner;
  isExecutable?: (path: string) => Promise<boolean>;
  sync?: (options: { repoDir: string; globalDir: string }) => Promise<SyncResult>;
}

export interface JobView {
  id: string;
  harness: SetupHarness;
  action: HarnessAction;
  /** The command as a person would type it. */
  command: string;
  state: "running" | "ok" | "failed";
  exitCode?: number;
  lines: string[];
  startedAt: string;
  /** Sign-in only: the first https URL in the output, for the app to open on a click. */
  url?: string;
  /** Sign-in only: the first device code in the output, for the person to copy. */
  code?: string;
}

const MAX_LINES = 200;
const JOB_TIMEOUT_MS = 10 * 60_000;

/** The real runner: no shell, inherited environment, killed after ten minutes. */
export const spawnRunner: SetupRunner = (cmd, args, onLine) =>
  new Promise((resolve) => {
    const child = spawn(cmd, [...args], { stdio: ["ignore", "pipe", "pipe"], shell: false });
    // At the deadline: SIGTERM, then SIGKILL 5 s later if it still runs.
    let hard: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      hard = setTimeout(() => child.kill("SIGKILL"), 5_000);
    }, JOB_TIMEOUT_MS);
    for (const stream of [child.stdout, child.stderr]) {
      let rest = "";
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => {
        const parts = (rest + chunk).split(/\r?\n/);
        rest = parts.pop() ?? "";
        for (const line of parts) if (line.trim() !== "") onLine(line);
      });
      stream.on("end", () => {
        if (rest.trim() !== "") onLine(rest);
      });
    }
    child.on("error", (e) => {
      onLine(e.message);
      clearTimeout(timer);
      resolve(127);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      clearTimeout(hard);
      resolve(code ?? 1);
    });
  });

/**
 * The fixed argv of each action. Sign-in runs the CLI's own login as a child process, at
 * the path the status engine uses (D-031). No other app is started or driven.
 */
function commandFor(
  harness: SetupHarness,
  action: HarnessAction,
  bin: string | undefined,
): { cmd: string; args: string[]; text: string } {
  const spec = harnessSetupSpec(harness);
  if (!spec) throw new HttpError(404, "not_found");
  if (action === "install") {
    return { cmd: "npm", args: ["install", "-g", spec.pkg], text: `npm install -g ${spec.pkg}` };
  }
  if (action === "update") {
    const pkg = `${spec.pkg}@latest`;
    return { cmd: "npm", args: ["install", "-g", pkg], text: `npm install -g ${pkg}` };
  }
  return { cmd: bin ?? spec.bin, args: spec.loginArgs, text: spec.login };
}

function manualCommands(harness: SetupHarness): Record<HarnessAction, string> {
  const spec = harnessSetupSpec(harness);
  return {
    install: `npm install -g ${spec?.pkg}`,
    update: `npm install -g ${spec?.pkg}@latest`,
    signin: spec?.login ?? "",
  };
}

/** A POST body with no keys, so no request text can reach a command. */
function emptyBody(body: unknown): void {
  if (body === undefined || body === null) return;
  if (typeof body === "object" && !Array.isArray(body) && Object.keys(body).length === 0) return;
  throw new HttpError(400, "invalid_body", "this action takes no options; send {}");
}

async function readText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw e;
  }
}

/** Writes through a temp file and a rename, so a reader never sees half a file. */
async function writeAtomic(path: string, text: string): Promise<void> {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, text);
  await rename(tmp, path);
}

/** Runs config edits one at a time, so two saves never read and write over each other. */
function serial() {
  let last: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const next = last.then(task, task);
    last = next.catch(() => undefined);
    return next;
  };
}

/** Checks a whole config file before it is written; a problem is a 400 that names it. */
function validateConfigText(text: string, file: string): void {
  try {
    parseConfigFile(parse(text), file);
  } catch (e) {
    const message = e instanceof ConfigError || e instanceof Error ? e.message : String(e);
    throw new HttpError(400, "invalid_body", message);
  }
}

/** Sets or clears `bin` in `[harnesses.<id>]`, keeping every other line. */
export function applyHarnessBin(text: string, harness: HarnessId, bin: string | null): string {
  return applyTableKey(text, `harnesses.${harness}`, "bin", bin);
}

interface TeamAgentView {
  name: string;
  role: AgentRole;
  harness: HarnessId;
  model: string;
  removable: boolean;
}

export function setupRoutes(options: SetupOptions): { routes: Route[] } {
  const runner = options.runner ?? spawnRunner;
  const isExec = options.isExecutable ?? isExecutableFile;
  const sync = options.sync ?? syncRepo;
  const workspaceFile = join(options.repoDir, ".harnessd", "config.toml");
  const globalFile = join(options.globalDir, "config.toml");
  const jobs = new Map<SetupHarness, JobView>();
  const queue = serial();
  const listeners = new Set<SendEvent>();
  const emit = (job: JobView) => {
    for (const send of listeners) send("job", job);
  };

  const mergedConfig = () =>
    loadConfig({
      globalDir: options.globalDir,
      workspaceDir: join(options.repoDir, ".harnessd"),
    }).catch((e: unknown) => {
      // A broken config is named, not hidden behind "no agent uses it".
      if (e instanceof ConfigError) throw new HttpError(400, "invalid_config", e.message);
      throw e;
    });

  async function harnesses() {
    const [checks, config] = await Promise.all([
      options.checks({ harnessesOnly: SETUP_HARNESSES }),
      mergedConfig(),
    ]);
    const used = new Set(Object.values(config?.agents ?? {}).map((a) => a.harness));
    return {
      harnesses: SETUP_HARNESSES.map((id) => ({
        id,
        name: harnessName(id),
        required: used.has(id),
        bin: config?.harnesses[id]?.bin ?? null,
        checks: checks.filter((c) => c.id.startsWith(`harness.${id}.`)),
        commands: manualCommands(id),
        job: jobs.get(id) ?? null,
      })),
    };
  }

  /** Sign-in runs the file the status engine checks: config bin, then HARNESSD_*_BIN, then PATH. */
  async function loginBin(harness: SetupHarness): Promise<string> {
    const found = await locateHarness(harness, {
      config: await mergedConfig(),
      env: options.env,
      isExecutable: isExec,
    });
    if ("absent" in found) {
      throw new HttpError(
        400,
        "not_installed",
        `${found.absent}. Install ${NAMES[harness]} first.`,
      );
    }
    return found.path;
  }

  async function start(harness: SetupHarness, action: HarnessAction): Promise<JobView> {
    const bin = action === "signin" ? await loginBin(harness) : undefined;
    // Checked after the await, so two clicks never start two commands.
    if (jobs.get(harness)?.state === "running") {
      throw new HttpError(
        409,
        "busy",
        `${harnessName(harness)} is already running a command. Wait for it to end.`,
      );
    }
    const { cmd, args, text } = commandFor(harness, action, bin);
    const job: JobView = {
      id: randomUUID(),
      harness,
      action,
      command: text,
      state: "running",
      lines: [],
      startedAt: new Date().toISOString(),
    };
    jobs.set(harness, job);
    emit(job);
    // Output stays in the job view only; it never goes to the daemon log.
    void runner(cmd, args, (raw) => {
      const line = maskEnvSecrets(raw, options.env);
      job.lines = [...job.lines, line].slice(-MAX_LINES);
      if (action === "signin") {
        const prompt = parseLoginPrompt(line);
        if (job.url === undefined && prompt.url !== undefined) job.url = prompt.url;
        if (job.code === undefined && prompt.code !== undefined) job.code = prompt.code;
      }
      emit({ ...job });
    }).then((code) => {
      job.state = code === 0 ? "ok" : "failed";
      job.exitCode = code;
      emit({ ...job });
    });
    return { ...job };
  }

  async function setBin(harness: SetupHarness, body: unknown): Promise<{ bin: string | null }> {
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new HttpError(
        400,
        "invalid_body",
        'send { "path": "/absolute/path" } or { "path": null }',
      );
    }
    const keys = Object.keys(body);
    const path = (body as { path?: unknown }).path;
    if (keys.length !== 1 || keys[0] !== "path" || (path !== null && typeof path !== "string")) {
      throw new HttpError(
        400,
        "invalid_body",
        'send { "path": "/absolute/path" } or { "path": null }',
      );
    }
    let bin: string | null = null;
    if (typeof path === "string" && path.trim() !== "") {
      bin = path.trim();
      if (!bin.startsWith("/") || bin.length > 1024 || hasControlChar(bin)) {
        throw new HttpError(
          400,
          "invalid_body",
          "Enter an absolute path, such as /opt/homebrew/bin/claude.",
        );
      }
      if (!(await isExec(bin))) {
        throw new HttpError(400, "invalid_body", `${bin} is not an executable file.`);
      }
      // The status engine and the loop run this file, so it must be the harness's own CLI.
      const name = harnessSetupSpec(harness)?.bin ?? harness;
      if (bin.split("/").at(-1) !== name) {
        throw new HttpError(400, "invalid_body", `The path must end in /${name}.`);
      }
    }
    // The secret store edits the same file; the lock keeps either from losing the other.
    await withFileLock(globalFile, async () => {
      const text = applyHarnessBin(await readText(globalFile), harness, bin);
      validateConfigText(text, "~/.harnessd/config.toml");
      await writeAtomic(globalFile, text);
    });
    return { bin };
  }

  async function team(): Promise<{ agents: TeamAgentView[] }> {
    try {
      return await readTeam();
    } catch (e) {
      if (e instanceof ConfigError) throw new HttpError(400, "invalid_config", e.message);
      throw e;
    }
  }

  async function readTeam(): Promise<{ agents: TeamAgentView[] }> {
    const [merged, base, file] = await Promise.all([
      loadConfig({
        globalDir: options.globalDir,
        workspaceDir: join(options.repoDir, ".harnessd"),
      }),
      loadConfig({ globalDir: options.globalDir }),
      readText(workspaceFile),
    ]);
    const tables =
      file === "" ? {} : (parseConfigFile(parse(file), ".harnessd/config.toml").agents ?? {});
    return {
      agents: Object.values(merged.agents).map((a) => ({
        name: a.name,
        role: a.role,
        harness: a.harness,
        model: a.model ?? "",
        removable: a.name in tables && !(a.name in base.agents),
      })),
    };
  }

  function rowsOf(body: unknown): TeamRow[] {
    const agents = (body as { agents?: unknown } | null)?.agents;
    const ok =
      typeof body === "object" &&
      body !== null &&
      Object.keys(body).length === 1 &&
      Array.isArray(agents) &&
      agents.length <= 50 &&
      agents.every(
        (a) =>
          typeof a === "object" &&
          a !== null &&
          Object.keys(a).every((k) => ["name", "role", "harness", "model"].includes(k)) &&
          ["name", "role", "harness"].every(
            (k) => typeof (a as Record<string, unknown>)[k] === "string",
          ) &&
          ["undefined", "string"].includes(typeof (a as { model?: unknown }).model),
      );
    if (!ok) {
      throw new HttpError(
        400,
        "invalid_body",
        'send { "agents": [{ "name", "role", "harness", "model"? }] }',
      );
    }
    return (agents as TeamRow[]).map((a) => ({
      ...a,
      name: a.name.trim(),
      model: (a.model ?? "").trim(),
    }));
  }

  async function saveTeam(body: unknown) {
    const rows = rowsOf(body);
    const fields = validateTeam(rows);
    if (Object.keys(fields).length > 0) {
      throw new HttpError(400, "invalid_body", Object.values(fields)[0] ?? "invalid team", fields);
    }
    const current = await team();
    const merged = new Map(current.agents.map((a) => [a.name, a]));
    const wanted = new Set(rows.map((r) => r.name));
    const change: TeamChange = { set: {}, remove: [] };
    for (const agent of current.agents) {
      if (wanted.has(agent.name)) continue;
      if (!agent.removable) {
        const why =
          agent.name in DEFAULT_AGENTS
            ? "is a default agent"
            : "is set outside this repo's config.toml";
        throw new HttpError(
          400,
          "invalid_body",
          `${agent.name} ${why}; it cannot be removed here.`,
          {
            team: `${agent.name} ${why}; it cannot be removed here.`,
          },
        );
      }
      change.remove = [...change.remove, agent.name];
    }
    for (const row of rows) {
      const now = merged.get(row.name);
      if (
        now &&
        now.role === row.role &&
        now.harness === row.harness &&
        now.model === (row.model ?? "")
      ) {
        continue;
      }
      change.set[row.name] = {
        role: row.role as AgentRole,
        harness: row.harness as HarnessId,
        ...(row.model ? { model: row.model } : {}),
      };
    }
    if (Object.keys(change.set).length === 0 && change.remove.length === 0) {
      return { ...current, synced: [] as string[] };
    }
    let text: string;
    try {
      text = applyTeam(await readText(workspaceFile), change);
    } catch (e) {
      if (e instanceof TeamEditError) throw new HttpError(400, "invalid_body", e.message);
      throw e;
    }
    validateConfigText(text, ".harnessd/config.toml");
    await writeAtomic(workspaceFile, text);
    let synced: string[] = [];
    let syncError: string | undefined;
    try {
      synced = (await sync({ repoDir: options.repoDir, globalDir: options.globalDir })).changed;
    } catch (e) {
      syncError = (e as Error).message;
    }
    return { ...(await team()), synced, ...(syncError ? { syncError } : {}) };
  }

  const routes: Route[] = [
    { method: "GET", path: "/api/harnesses", handler: harnesses },
    { method: "GET", path: "/api/team", handler: team },
    { method: "POST", path: "/api/team", handler: ({ body }) => queue(() => saveTeam(body)) },
    {
      method: "GET",
      path: "/api/setup/events",
      handler: () =>
        new EventStream((send) => {
          listeners.add(send);
          for (const job of jobs.values()) send("job", job);
          return () => listeners.delete(send);
        }),
    },
  ];
  for (const harness of SETUP_HARNESSES) {
    for (const action of ACTIONS) {
      routes.push({
        method: "POST",
        path: `/api/harnesses/${harness}/${action}`,
        handler: ({ body }) => {
          emptyBody(body);
          return start(harness, action);
        },
      });
    }
    routes.push({
      method: "POST",
      path: `/api/harnesses/${harness}/path`,
      handler: ({ body }) => queue(() => setBin(harness, body)),
    });
  }
  return { routes };
}
