import { ConfigError } from "@harnessd/shared";

export interface Frontmatter {
  data: Record<string, string>;
  body: string;
}

const FENCE = /^---\s*$/;
const ENTRY = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/;

function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.at(-1) === v[0]) return v.slice(1, -1);
  return v;
}

/**
 * Parses YAML-ish frontmatter: flat `key: value` lines between `---` fences.
 * Values are strings; quotes are stripped. Indented lines continue the previous
 * value, and `>` / `|` block markers are accepted, so multi-line descriptions work.
 * Text without a leading fence has no frontmatter.
 */
export function parseFrontmatter(text: string, file: string): Frontmatter {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  if (!FENCE.test(lines[0] ?? "")) return { data: {}, body: text };
  const end = lines.findIndex((line, i) => i > 0 && FENCE.test(line));
  if (end === -1) throw new ConfigError(file, undefined, "frontmatter has no closing ---");

  const data: Record<string, string> = {};
  let last: string | undefined;
  for (let i = 1; i < end; i++) {
    const line = lines[i] ?? "";
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    if (/^\s/.test(line) && last !== undefined) {
      const prev = data[last] ?? "";
      data[last] = prev === "" ? line.trim() : `${prev} ${line.trim()}`;
      continue;
    }
    const match = ENTRY.exec(line);
    if (!match) {
      throw new ConfigError(file, undefined, `frontmatter line ${i + 1}: expected "key: value"`);
    }
    const key = match[1] ?? "";
    const value = unquote(match[2] ?? "");
    data[key] = /^[>|][+-]?$/.test(value) ? "" : value;
    last = key;
  }
  return { data, body: lines.slice(end + 1).join("\n") };
}
