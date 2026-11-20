// The local secret store (MET-33, D-030). One owner-only file per secret in
// `<HARNESSD_HOME>/secrets/`, written through a temp file and a rename. A secret can be a
// reference instead: `op://…`, read with the 1Password CLI at use time, or `env:NAME`.
// config.toml holds only the reference. Lookup: saved value or reference, then the
// environment variable. No value ever reaches an error, a state or a log line.
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  hasControlChar,
  isSecretReference,
  OP_REFERENCE,
  SECRET_ENV,
  type SecretId,
  type SecretReferences,
  type SecretSource,
  type SecretState,
} from "@harnessd/shared";
import { applyTableKey, withFileLock } from "../config/edit.ts";
import { parseConfigText } from "../config/load.ts";
import { type Exec, execFile } from "../status/detect.ts";

export {
  isSecretId,
  SECRET_ENV,
  SECRET_IDS,
  type SecretId,
  type SecretSource,
  type SecretState,
} from "@harnessd/shared";

export interface ResolvedSecret {
  value: string;
  source: SecretSource;
}

/** `invalid`: a value or reference to save was refused. `unreadable`: a lookup failed. */
export class SecretError extends Error {
  readonly code: "invalid" | "unreadable";

  constructor(code: "invalid" | "unreadable", message: string) {
    super(message);
    this.name = "SecretError";
    this.code = code;
  }
}

export interface SecretStoreOptions {
  /** `~/.harnessd` or `$HARNESSD_HOME`. */
  globalDir: string;
  env: NodeJS.ProcessEnv;
  /** Runs `op`. Default: the real machine, no shell. */
  exec?: Exec;
  /** How long an op read is kept in memory. Default 5 minutes. */
  cacheMs?: number;
  now?: () => number;
}

export interface SecretStore {
  /** Set or not, and where from. Never runs `op`. */
  state(id: SecretId): Promise<SecretState>;
  /** The value and its source, or undefined when nothing is set. Throws SecretError. */
  resolve(id: SecretId): Promise<ResolvedSecret | undefined>;
  value(id: SecretId): Promise<string | undefined>;
  /** Saves a value, or a reference when the text is `op://…` or `env:NAME`. */
  save(id: SecretId, text: string): Promise<SecretState>;
  /** Removes the saved value and the reference. The environment variable still applies. */
  remove(id: SecretId): Promise<SecretState>;
  /** Every value this store has read or saved, longest first, so callers can mask them. */
  known(): string[];
}

const MAX_VALUE = 4096;
const OP_TIMEOUT_MS = 15_000;
const DEFAULT_CACHE_MS = 5 * 60_000;

/** The `[secrets.<service>] <key>` that holds each secret's reference. */
const TABLE: Record<SecretId, { service: "linear" | "slack"; key: string }> = {
  "linear.api_key": { service: "linear", key: "api_key" },
  "slack.webhook_url": { service: "slack", key: "webhook_url" },
};

const sourceOf = (reference: string): SecretSource =>
  reference.startsWith("op://") ? "1Password" : "env";

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}

/** Refuses a value without repeating it. */
function checkValue(id: SecretId, value: string): void {
  const refuse = (why: string): never => {
    throw new SecretError("invalid", why);
  };
  if (value === "") refuse("Enter a value.");
  if (value.length > MAX_VALUE) refuse(`Use at most ${MAX_VALUE} characters.`);
  if (hasControlChar(value) || /\s/.test(value)) refuse("Use one line with no spaces.");
  if (value.startsWith("op://")) {
    refuse("A 1Password reference is op://vault/item/field, with no spaces.");
  }
  if (value.startsWith("env:")) {
    refuse("An environment reference is env:NAME, with letters, digits and _.");
  }
  if (id === "slack.webhook_url") {
    let url: URL | undefined;
    try {
      url = new URL(value);
    } catch {
      url = undefined;
    }
    if (url?.protocol !== "https:") refuse("Enter the https:// url of a Slack incoming webhook.");
  }
}

export function createSecretStore(options: SecretStoreOptions): SecretStore {
  const folder = join(options.globalDir, "secrets");
  const configFile = join(options.globalDir, "config.toml");
  const exec = options.exec ?? execFile;
  const cacheMs = options.cacheMs ?? DEFAULT_CACHE_MS;
  const now = options.now ?? Date.now;
  const env = options.env;
  const cache = new Map<string, { value: Promise<string>; at: number }>();
  const seen = new Set<string>();
  let last: Promise<unknown> = Promise.resolve();

  /** Writes run one at a time, so two saves never interleave. */
  function serial<T>(task: () => Promise<T>): Promise<T> {
    const next = last.then(task, task);
    last = next.catch(() => undefined);
    return next;
  }

  const fileOf = (id: SecretId) => join(folder, id);

  async function references(): Promise<SecretReferences> {
    const text = await readOptional(configFile);
    if (text === undefined) return {};
    return parseConfigText(text, "~/.harnessd/config.toml").secrets ?? {};
  }

  async function referenceOf(id: SecretId): Promise<string | undefined> {
    const { service, key } = TABLE[id];
    return (await references())[service]?.[key as never];
  }

  /** Refuses a secrets folder that is a link, so a write never lands somewhere else. */
  async function checkFolder(): Promise<boolean> {
    try {
      const info = await lstat(folder);
      if (!info.isDirectory()) {
        throw new SecretError("unreadable", `${folder} is not a plain folder; move it away`);
      }
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw e;
    }
  }

  /** A saved value, read only from a plain owner-only file. */
  async function savedOf(id: SecretId): Promise<string | undefined> {
    if (!(await checkFolder())) return undefined;
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(fileOf(id));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw e;
    }
    if (!info.isFile()) {
      throw new SecretError(
        "unreadable",
        `the saved ${id} is not a plain file; remove it and save again`,
      );
    }
    if ((info.mode & 0o077) !== 0) {
      throw new SecretError("unreadable", `the saved ${id} can be read by others; save it again`);
    }
    const text = (await readOptional(fileOf(id)))?.trim();
    return text === "" ? undefined : text;
  }

  function remember(value: string): string {
    seen.add(value);
    return value;
  }

  function scrub(text: string): string {
    let out = text;
    for (const v of [...seen].sort((a, b) => b.length - a.length)) out = out.replaceAll(v, "***");
    return out;
  }

  async function readOp(reference: string): Promise<string> {
    const hit = cache.get(reference);
    if (hit && now() - hit.at < cacheMs) return hit.value;
    const value = (async () => {
      // argv only: the reference never reaches a shell.
      const res = await exec("op", ["read", "--no-newline", reference], {
        env,
        timeoutMs: OP_TIMEOUT_MS,
      });
      const out = res.stdout.trim();
      if (res.code === 0 && out !== "") return remember(out);
      if (out !== "") remember(out);
      if (res.code === 127)
        throw new SecretError("unreadable", "1Password: the op CLI is not installed");
      if (res.code === 124) throw new SecretError("unreadable", "1Password: op read timed out");
      const line =
        res.stderr
          .split("\n")
          .find((l) => l.trim() !== "")
          ?.trim() ?? "";
      throw new SecretError(
        "unreadable",
        line === ""
          ? "1Password: op read returned nothing"
          : `1Password: op read failed: ${scrub(line)}`,
      );
    })();
    cache.set(reference, { value, at: now() });
    value.catch(() => cache.delete(reference));
    return value;
  }

  async function state(id: SecretId): Promise<SecretState> {
    // A file that cannot be used still counts as saved, so Replace and Remove reach it.
    const saved = await savedOf(id).catch((e: unknown) => {
      if (e instanceof SecretError) return "";
      throw e;
    });
    if (saved !== undefined) return { id, set: true, source: "saved", stored: true };
    const reference = await referenceOf(id);
    if (reference !== undefined) {
      return { id, set: true, source: sourceOf(reference), stored: true };
    }
    const fromEnv = env[SECRET_ENV[id]]?.trim();
    return fromEnv
      ? { id, set: true, source: "env", stored: false }
      : { id, set: false, source: null, stored: false };
  }

  async function resolve(id: SecretId): Promise<ResolvedSecret | undefined> {
    const saved = await savedOf(id);
    if (saved !== undefined) return { value: remember(saved), source: "saved" };
    const reference = await referenceOf(id);
    if (reference !== undefined) {
      if (OP_REFERENCE.test(reference))
        return { value: await readOp(reference), source: "1Password" };
      const name = reference.slice("env:".length);
      const value = env[name]?.trim();
      if (!value) throw new SecretError("unreadable", `${reference} is not set`);
      return { value: remember(value), source: "env" };
    }
    const value = env[SECRET_ENV[id]]?.trim();
    return value ? { value: remember(value), source: "env" } : undefined;
  }

  /** Edits config.toml under the lock that Settings → Harnesses also takes. */
  function writeReference(id: SecretId, reference: string | null): Promise<void> {
    return withFileLock(configFile, async () => {
      const text = (await readOptional(configFile)) ?? "";
      const { service, key } = TABLE[id];
      const next = applyTableKey(text, `secrets.${service}`, key, reference);
      if (next === text) return;
      // The whole file must still be valid before it is written.
      parseConfigText(next, "~/.harnessd/config.toml");
      // Keep the file's own mode; a new file gets the default.
      const mode = await stat(configFile).then(
        (i) => i.mode & 0o777,
        () => undefined,
      );
      const tmp = `${configFile}.${process.pid}.${randomUUID()}.tmp`;
      await mkdir(options.globalDir, { recursive: true });
      await writeFile(tmp, next, mode === undefined ? {} : { mode });
      if (mode !== undefined) await chmod(tmp, mode);
      await rename(tmp, configFile);
    });
  }

  async function writeValue(id: SecretId, value: string): Promise<void> {
    if (!(await checkFolder())) await mkdir(folder, { recursive: true, mode: 0o700 });
    await chmod(folder, 0o700);
    const tmp = join(folder, `.${id}.${process.pid}.${randomUUID()}.tmp`);
    try {
      // "wx": a fresh file, owner-only from the first byte.
      await writeFile(tmp, value, { mode: 0o600, flag: "wx" });
      await rename(tmp, fileOf(id));
    } finally {
      await rm(tmp, { force: true });
    }
  }

  return {
    state,
    resolve,
    async value(id) {
      return (await resolve(id))?.value;
    },
    save(id, raw) {
      return serial(async () => {
        // A broken config.toml stops the save before anything is written.
        await references();
        const text = raw.trim();
        if (isSecretReference(text)) {
          await writeReference(id, text);
          await rm(fileOf(id), { force: true });
        } else {
          checkValue(id, text);
          remember(text);
          await writeValue(id, text);
          await writeReference(id, null);
        }
        cache.clear();
        return state(id);
      });
    },
    remove(id) {
      return serial(async () => {
        await rm(fileOf(id), { force: true });
        await writeReference(id, null);
        cache.clear();
        return state(id);
      });
    },
    known() {
      return [...seen].sort((a, b) => b.length - a.length);
    },
  };
}
