// The Team page's rules (MET-28). The UI shows these errors inline; the daemon runs the
// same check before it writes anything.
import { AGENT_ROLES } from "./config.ts";
import { HARNESSES } from "./index.ts";

/** One agent row as the Team page edits it. Fields are strings until validated. */
export interface TeamRow {
  name: string;
  role: string;
  harness: string;
  model?: string;
}

/** Agent names become TOML keys and file names, so they stay plain. */
export const AGENT_NAME = /^[a-z][a-z0-9_-]*$/;
export const MAX_AGENT_NAME = 40;
export const MAX_MODEL = 100;

/** True when the text holds a control character, such as a newline or a NUL. */
export function hasControlChar(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Errors keyed by `<row>.<field>`, plus `team` for the whole list. Empty when valid.
 * Messages say what to do, in one short sentence.
 */
export function validateTeam(rows: readonly TeamRow[]): Record<string, string> {
  const errors: Record<string, string> = {};
  const seen = new Set<string>();
  rows.forEach((row, i) => {
    const name = row.name.trim();
    if (name === "") errors[`${i}.name`] = "Enter a name.";
    else if (!AGENT_NAME.test(name) || name.length > MAX_AGENT_NAME) {
      errors[`${i}.name`] = "Use lowercase letters, digits, - and _, starting with a letter.";
    } else if (seen.has(name)) errors[`${i}.name`] = "Another agent has this name.";
    seen.add(name);
    if (!(AGENT_ROLES as readonly string[]).includes(row.role)) {
      errors[`${i}.role`] = `Pick a role: ${AGENT_ROLES.join(", ")}.`;
    }
    if (!(HARNESSES as readonly string[]).includes(row.harness)) {
      errors[`${i}.harness`] = `Pick a harness: ${HARNESSES.join(", ")}.`;
    }
    const model = row.model ?? "";
    if (model.length > MAX_MODEL || hasControlChar(model)) {
      errors[`${i}.model`] = `Use one line of at most ${MAX_MODEL} characters.`;
    }
  });
  if (rows.filter((r) => r.role === "coordinator").length !== 1) {
    errors.team = "The team needs exactly one coordinator.";
  }
  return errors;
}
