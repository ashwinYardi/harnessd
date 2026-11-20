// Edits one `key = "value"` line of a `[table]` in config.toml text, keeping every other
// line and comment (MET-28, MET-33). The caller checks the result with the validator.

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Sets `key` in `[table]` to a string, or removes it when `value` is null. A table left
 * with only blank or comment lines is removed. A missing table is added at the end.
 */
export function applyTableKey(
  text: string,
  table: string,
  key: string,
  value: string | null,
): string {
  const lines = text === "" ? [] : text.replace(/\n$/, "").split("\n");
  const name = table.split(".").map(escapeRe).join("\\s*\\.\\s*");
  const headerRe = new RegExp(`^\\s*\\[\\s*${name}\\s*\\]`);
  const keyRe = new RegExp(`^\\s*${escapeRe(key)}\\s*=`);
  const header = lines.findIndex((l) => headerRe.test(l));
  const line = value === null ? undefined : `${key} = ${JSON.stringify(value)}`;
  if (header === -1) {
    if (line === undefined) return text;
    const lead = lines.length > 0 && (lines.at(-1) ?? "").trim() !== "" ? [""] : [];
    lines.push(...lead, `[${table}]`, line);
  } else {
    let end = header + 1;
    while (end < lines.length && !/^\s*\[/.test(lines[end] ?? "")) end++;
    const at = lines.slice(header + 1, end).findIndex((l) => keyRe.test(l));
    if (line !== undefined) {
      if (at === -1) lines.splice(header + 1, 0, line);
      else lines[header + 1 + at] = line;
    } else if (at !== -1) {
      lines.splice(header + 1 + at, 1);
      end--;
      const body = lines.slice(header + 1, end);
      if (body.every((l) => /^\s*(#.*)?$/.test(l))) {
        let start = header;
        while (start > 0 && (lines[start - 1] ?? "").trim() === "") start--;
        lines.splice(start, end - start);
      }
    }
  }
  const out = lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\n+$/, "");
  return out === "" ? "" : `${out}\n`;
}
