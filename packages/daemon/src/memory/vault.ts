// Obsidian-compatible markdown vaults (D-005): plain `.md` files in folders, optional
// YAML frontmatter, the file name is the title. No index, no database: search reads files.
import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { yamlString } from "../sync/format.ts";

export type VaultScope = "global" | "workspace";

/** Vault folders by scope. `workspace` is missing outside a repo with `.harnessd/`. */
export interface Vaults {
  global: string;
  workspace?: string;
}

/** `<globalDir>/vault` and, for a repo, `<repo>/.harnessd/vault`. */
export function vaultDirs(globalDir: string, repoDir?: string): Vaults {
  const vaults: Vaults = { global: join(globalDir, "vault") };
  if (repoDir !== undefined) vaults.workspace = join(repoDir, ".harnessd", "vault");
  return vaults;
}

/**
 * The nearest folder at or above `start` that has a `.harnessd/` folder, skipping
 * the global folder itself (so `~` is not mistaken for a repo). Undefined if none.
 */
export async function findRepoRoot(start: string, globalDir: string): Promise<string | undefined> {
  let dir = resolve(start);
  const global = resolve(globalDir);
  for (;;) {
    const candidate = join(dir, ".harnessd");
    if (candidate !== global && (await isDir(candidate))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

async function isDir(path: string): Promise<boolean> {
  return stat(path).then(
    (s) => s.isDirectory(),
    () => false,
  );
}

/** A problem the caller caused (bad path, missing note); MCP reports it as a tool error. */
export class VaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultError";
  }
}

export const MAX_NOTE_BYTES = 1024 * 1024;

/**
 * Normalizes a note path to `a/b.md`, relative to the vault. `.md` is optional.
 * Rejects absolute paths, `..`, hidden segments (`.obsidian/`, `.git/`), backslashes
 * and control characters, so a path can never leave the vault.
 */
export function normalizeNotePath(path: string): string {
  if (typeof path !== "string" || path.trim() === "") throw new VaultError("path is required");
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting them is the point
  if (/[\u0000-\u001f\\]/.test(path)) {
    throw new VaultError(`invalid note path ${JSON.stringify(path)}`);
  }
  const trimmed = path.trim().replace(/\.md$/i, "");
  if (trimmed.startsWith("/")) {
    throw new VaultError(`note paths are relative to the vault, got ${JSON.stringify(path)}`);
  }
  const segments = trimmed.split("/").filter((s) => s !== "");
  if (segments.length === 0) throw new VaultError("path is required");
  for (const segment of segments) {
    if (segment.startsWith(".") || /^\s|\s$/.test(segment)) {
      throw new VaultError(`invalid note path ${JSON.stringify(path)}`);
    }
  }
  return `${segments.join("/")}.md`;
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** `path` with its deepest existing ancestor resolved through symlinks. */
async function realAncestor(path: string): Promise<string> {
  let current = path;
  for (;;) {
    try {
      return join(await realpath(current), relative(current, path));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      const parent = dirname(current);
      if (parent === current) return path;
      current = parent;
    }
  }
}

/** Absolute file for a note, after checking it (and any symlinks on the way) stays in the vault. */
export async function resolveNote(
  vault: string,
  path: string,
): Promise<{ rel: string; file: string }> {
  const rel = normalizeNotePath(path);
  const root = resolve(vault);
  const file = resolve(root, rel);
  if (!isInside(root, file)) throw new VaultError(`note path escapes the vault: ${path}`);
  const realRoot = await realAncestor(root);
  if (!isInside(realRoot, await realAncestor(file))) {
    throw new VaultError(`note path escapes the vault: ${path}`);
  }
  return { rel, file };
}

export interface Note {
  /** Vault-relative, `/`-separated, with `.md`. */
  path: string;
  /** Full file text, frontmatter included. */
  content: string;
}

export async function readNote(vault: string, path: string): Promise<Note> {
  const { rel, file } = await resolveNote(vault, path);
  try {
    return { path: rel, content: await readFile(file, "utf8") };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EISDIR") throw new VaultError(`no note at ${rel}`);
    throw e;
  }
}

export type FrontmatterValue = string | number | boolean | string[];

const FRONTMATTER_KEY = /^[A-Za-z0-9_-]+$/;

/** YAML frontmatter block, keys in the given order. Lists use block style. */
export function formatFrontmatter(data: Record<string, FrontmatterValue>): string {
  const lines = ["---"];
  for (const [key, value] of Object.entries(data)) {
    if (!FRONTMATTER_KEY.test(key)) {
      throw new VaultError(
        `frontmatter keys may only use letters, digits, _ and -, got ${JSON.stringify(key)}`,
      );
    }
    if (Array.isArray(value)) {
      if (!value.every((v) => typeof v === "string")) {
        throw new VaultError(`frontmatter.${key}: expected strings`);
      }
      lines.push(value.length === 0 ? `${key}: []` : `${key}:`);
      for (const item of value) lines.push(`  - ${yamlString(item)}`);
    } else if (typeof value === "string") {
      lines.push(`${key}: ${yamlString(value)}`);
    } else if (
      (typeof value === "number" && Number.isFinite(value)) ||
      typeof value === "boolean"
    ) {
      lines.push(`${key}: ${String(value)}`);
    } else {
      throw new VaultError(
        `frontmatter.${key}: expected a string, number, boolean or list of strings`,
      );
    }
  }
  lines.push("---");
  return `${lines.join("\n")}\n`;
}

/** Creates or overwrites `<path>.md`. Returns the vault-relative path. */
export async function writeNote(
  vault: string,
  path: string,
  body: string,
  frontmatter?: Record<string, FrontmatterValue>,
): Promise<string> {
  if (typeof body !== "string") throw new VaultError("content must be a string");
  const { rel, file } = await resolveNote(vault, path);
  let text = body.endsWith("\n") || body === "" ? body : `${body}\n`;
  if (frontmatter !== undefined && Object.keys(frontmatter).length > 0) {
    if (/^---\s*$/.test(text.split("\n", 1)[0] ?? "")) {
      throw new VaultError("content already starts with frontmatter; pass one or the other");
    }
    text = `${formatFrontmatter(frontmatter)}\n${text}`;
  }
  if (Buffer.byteLength(text) > MAX_NOTE_BYTES) {
    throw new VaultError(`note is larger than ${MAX_NOTE_BYTES} bytes`);
  }
  if (await isDir(file)) throw new VaultError(`${rel} is a folder`);
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.harnessd-tmp`;
  await writeFile(tmp, text);
  await rename(tmp, file);
  return rel;
}

/** Every note in the vault, sorted, skipping hidden folders such as `.obsidian/`. */
export async function listNotes(vault: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string, prefix: string) {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return;
      throw e;
    }
    for (const ent of entries) {
      if (ent.name.startsWith(".")) continue;
      const rel = prefix === "" ? ent.name : `${prefix}/${ent.name}`;
      if (ent.isDirectory()) await walk(join(dir, ent.name), rel);
      else if (ent.isFile() && ent.name.toLowerCase().endsWith(".md")) out.push(rel);
    }
  }
  await walk(resolve(vault), "");
  return out.sort();
}

export interface SearchHit {
  path: string;
  title: string;
  score: number;
  snippet: string;
}

const SNIPPET_CHARS = 160;

function count(haystack: string, needle: string): number {
  let n = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length))
    n++;
  return n;
}

function snippet(body: string, needles: readonly string[]): string {
  const flat = body.replace(/\s+/g, " ").trim();
  const lower = flat.toLowerCase();
  const at = needles.map((n) => lower.indexOf(n)).find((i) => i !== -1) ?? 0;
  const start = Math.max(0, at - SNIPPET_CHARS / 4);
  const end = Math.min(flat.length, start + SNIPPET_CHARS);
  return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
}

/** The text after a leading `---` frontmatter block, or the whole text when it has none. */
export function stripFrontmatter(text: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---\s*(\r?\n|$)/.exec(text);
  return match ? text.slice(match[0].length) : text;
}

/**
 * Case-insensitive search over note titles (the file path) and text. A note matches
 * when any term does. Score per hit: phrase in title 30, phrase in text 15, term in
 * title 10, term in text 1 (text hits capped at 10 each). Ties sort by path.
 */
export async function searchNotes(vault: string, query: string, limit = 10): Promise<SearchHit[]> {
  const phrase = query.trim().toLowerCase().replace(/\s+/g, " ");
  if (phrase === "") throw new VaultError("query is required");
  const terms = [...new Set(phrase.split(" "))];
  const hits: SearchHit[] = [];
  for (const path of await listNotes(vault)) {
    const content = await readFile(join(resolve(vault), path), "utf8");
    const title = path.slice(0, -".md".length).split("/").at(-1) ?? path;
    const titleLower = path.slice(0, -".md".length).toLowerCase();
    const body = content.toLowerCase();
    let score = 0;
    if (terms.length > 1) {
      score += 30 * count(titleLower, phrase) + 15 * Math.min(count(body, phrase), 10);
    }
    for (const term of terms) {
      score += 10 * count(titleLower, term) + Math.min(count(body, term), 10);
    }
    if (score === 0) continue;
    hits.push({
      path,
      title,
      score,
      snippet: snippet(stripFrontmatter(content), [phrase, ...terms]),
    });
  }
  hits.sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : 1));
  return hits.slice(0, Math.max(1, limit));
}
