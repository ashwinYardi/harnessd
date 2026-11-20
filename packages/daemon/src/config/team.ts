// Edits the [agents.<name>] tables of a workspace config.toml as text, so every comment,
// blank line and other table stays as the owner wrote it (MET-28). The caller validates the
// result with parseConfigFile before it is written.
import type { AgentRole, HarnessId } from "@harnessd/shared";

/** One agent as the Team page sets it. An empty or missing model removes the key. */
export interface TeamEntry {
  role: AgentRole;
  harness: HarnessId;
  model?: string;
}

export interface TeamChange {
  /** Agents to write. Keys not named here (avatar, instructions) are kept. */
  set: Record<string, TeamEntry>;
  /** Agent tables to delete, with the comment lines just above them. */
  remove: readonly string[];
}

/** The file holds agents in a form this editor does not rewrite (inline or dotted keys). */
export class TeamEditError extends Error {}

const HEADER = /^\s*\[\s*([^\]]+?)\s*\]\s*(#.*)?$/;
const KEY = /^\s*([A-Za-z0-9_-]+)\s*=/;
const COMMENT_OR_BLANK = /^\s*(#.*)?$/;
const EDITED_KEYS = ["role", "harness", "model"] as const;

interface Block {
  name: string;
  /** Index of the first leading comment line, or of the header when there is none. */
  start: number;
  header: number;
  /** One past the last line of the table (before the next table's leading comments). */
  end: number;
  /** Index of each top-level key line in the table. */
  keys: Map<string, number>;
}

/** A TOML basic string. JSON's escapes are valid TOML escapes. */
const str = (value: string) => JSON.stringify(value);

function unquote(name: string): string {
  const m = /^"(.*)"$/.exec(name) ?? /^'(.*)'$/.exec(name);
  return m ? (m[1] ?? "") : name;
}

/** The line index after which a key line of `block` ends, skipping multi-line strings. */
function scan(lines: readonly string[]): { blocks: Block[]; headers: number[] } {
  const blocks: Block[] = [];
  const headers: number[] = [];
  let open: '"""' | "'''" | null = null;
  let current: Block | undefined;
  let rootKeys = true;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (open) {
      if (line.includes(open)) open = null;
      continue;
    }
    const header = HEADER.exec(line);
    if (header && !line.trimStart().startsWith("[[")) {
      rootKeys = false;
      headers.push(i);
      const path = header[1] ?? "";
      if (current) current.end = i;
      current = undefined;
      if (path === "agents") {
        throw new TeamEditError(
          "[agents] is written as one table. Write each agent as [agents.<name>].",
        );
      }
      const m = /^agents\s*\.\s*(.+)$/.exec(path);
      if (m) {
        const name = unquote((m[1] ?? "").trim());
        if (name.includes(".")) {
          throw new TeamEditError(`[${path}] has a sub-table. Edit it by hand.`);
        }
        let start = i;
        while (start > 0 && /^\s*#/.test(lines[start - 1] ?? "")) start--;
        current = { name, start, header: i, end: lines.length, keys: new Map() };
        blocks.push(current);
      }
      continue;
    }
    const key = KEY.exec(line);
    if (key) {
      if (rootKeys && key[1] === "agents") {
        throw new TeamEditError(
          "agents is set with dotted or inline keys. Write each agent as [agents.<name>].",
        );
      }
      if (rootKeys && /^\s*agents\s*\./.test(line)) {
        throw new TeamEditError(
          "agents is set with dotted keys. Write each agent as [agents.<name>].",
        );
      }
      if (current) current.keys.set(key[1] ?? "", i);
      const rest = line.slice(line.indexOf("=") + 1);
      for (const q of ['"""', "'''"] as const) {
        const at = rest.indexOf(q);
        if (at !== -1 && rest.indexOf(q, at + 3) === -1) open = q;
      }
    } else if (rootKeys && /^\s*agents\s*\./.test(line)) {
      throw new TeamEditError(
        "agents is set with dotted keys. Write each agent as [agents.<name>].",
      );
    }
  }
  // A table ends before the comment lines that lead the next table.
  for (const b of blocks) {
    let end = b.end;
    while (end > b.header + 1 && COMMENT_OR_BLANK.test(lines[end - 1] ?? "")) end--;
    b.end = end;
  }
  return { blocks, headers };
}

function keyLine(key: string, value: string, old: string | undefined): string {
  const indent = old ? (/^\s*/.exec(old)?.[0] ?? "") : "";
  const comment = old ? (/\s+#[^"']*$/.exec(old)?.[0] ?? "") : "";
  return `${indent}${key} = ${str(value)}${comment}`;
}

function tableText(name: string, entry: TeamEntry): string[] {
  const out = [`[agents.${/^[A-Za-z0-9_-]+$/.test(name) ? name : str(name)}]`];
  out.push(`role = ${str(entry.role)}`, `harness = ${str(entry.harness)}`);
  if (entry.model) out.push(`model = ${str(entry.model)}`);
  return out;
}

export function applyTeam(text: string, change: TeamChange): string {
  const lines = text === "" ? [] : text.replace(/\n$/, "").split("\n");
  const { blocks } = scan(lines);
  const byName = new Map(blocks.map((b) => [b.name, b]));

  // Line edits, applied from the bottom up so indexes stay valid.
  const edits: Array<{ at: number; remove: number; insert: string[] }> = [];
  for (const [name, entry] of Object.entries(change.set)) {
    const block = byName.get(name);
    if (!block) continue;
    let after = Math.max(block.header, ...block.keys.values());
    const missing: string[] = [];
    for (const key of EDITED_KEYS) {
      const value = entry[key];
      const at = block.keys.get(key);
      if (at !== undefined) {
        edits.push(
          value
            ? { at, remove: 1, insert: [keyLine(key, value, lines[at])] }
            : { at, remove: 1, insert: [] },
        );
      } else if (value) {
        missing.push(`${key} = ${str(value)}`);
      }
    }
    if (missing.length > 0) {
      // A new key goes right after the header's existing simple keys.
      after = block.keys.size > 0 ? Math.max(...block.keys.values()) : block.header;
      edits.push({ at: after + 1, remove: 0, insert: missing });
    }
  }
  for (const name of change.remove) {
    const block = byName.get(name);
    if (!block) continue;
    let end = block.end;
    while (end < lines.length && /^\s*$/.test(lines[end] ?? "")) end++;
    edits.push({ at: block.start, remove: end - block.start, insert: [] });
  }

  const added = Object.entries(change.set).filter(([name]) => !byName.has(name));
  if (added.length > 0) {
    const kept = blocks.filter((b) => !change.remove.includes(b.name));
    const last = kept.at(-1);
    const insert: string[] = [];
    for (const [name, entry] of added) {
      insert.push(...tableText(name, entry), "");
    }
    if (last) {
      edits.push({ at: last.end, remove: 0, insert: ["", ...insert.slice(0, -1)] });
    } else {
      const lead = lines.length > 0 && (lines.at(-1) ?? "").trim() !== "" ? [""] : [];
      edits.push({ at: lines.length, remove: 0, insert: [...lead, ...insert.slice(0, -1)] });
    }
  }

  edits.sort((a, b) => b.at - a.at || b.remove - a.remove);
  for (const e of edits) lines.splice(e.at, e.remove, ...e.insert);
  const out = lines.join("\n").replace(/\n{3,}/g, "\n\n");
  return out === "" ? "" : `${out.replace(/\n+$/, "")}\n`;
}
