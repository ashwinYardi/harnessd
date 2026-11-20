// The write-only secret fields of Settings → Connections (MET-33, D-029). The daemon never
// returns a value: the UI knows only whether a secret is set and where it comes from.
import type { Check } from "./checks.ts";

export type SecretId = "linear.api_key" | "slack.webhook_url";
export type SecretSource = "saved" | "1Password" | "env";

export interface SecretState {
  id: SecretId;
  set: boolean;
  source: SecretSource | null;
}

export interface SecretSpec {
  id: SecretId;
  /** The field label. */
  label: string;
  /** The environment variable the daemon falls back to. */
  env: string;
  /** The prefix of the connection's check ids. */
  prefix: string;
}

const SPECS: Record<string, SecretSpec> = {
  linear: { id: "linear.api_key", label: "API key", env: "LINEAR_API_KEY", prefix: "linear." },
  slack: {
    id: "slack.webhook_url",
    label: "Webhook url",
    env: "HARNESSD_SLACK_WEBHOOK_URL",
    prefix: "slack.",
  },
};

/** The secret a connection card takes, if any. */
export function secretFor(card: string): SecretSpec | undefined {
  return SPECS[card];
}

const SOURCE: Record<SecretSource, string> = {
  saved: "saved here",
  "1Password": "from 1Password",
  env: "from the environment",
};

export function sourceText(state: SecretState): string {
  return state.set && state.source ? `Set, ${SOURCE[state.source]}` : "Not set";
}

/** The same shapes the daemon accepts as a reference (docs/CONFIG.md "Secrets"). */
export function isReference(text: string): boolean {
  const t = text.trim();
  return /^op:\/\/\S+/.test(t) || /^env:[A-Za-z_][A-Za-z0-9_]*$/.test(t);
}

/** Puts the re-run checks of one connection in place of its old ones. */
export function mergeChecks(
  all: readonly Check[],
  prefix: string,
  fresh: readonly Check[],
): Check[] {
  const at = all.findIndex((c) => c.id.startsWith(prefix));
  const rest = all.filter((c) => !c.id.startsWith(prefix));
  const index = at === -1 ? rest.length : at;
  return [...rest.slice(0, index), ...fresh, ...rest.slice(index)];
}
