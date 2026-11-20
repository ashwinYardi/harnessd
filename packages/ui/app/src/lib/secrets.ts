// The write-only secret fields of Settings → Connections (MET-33, D-030). The daemon never
// returns a value: the UI knows only whether a secret is set and where it comes from.
import {
  isSecretReference,
  SECRET_ENV,
  type SecretId,
  type SecretSource,
  type SecretState,
} from "@harnessd/shared";
import type { Check } from "./checks.ts";

export type { SecretId, SecretSource, SecretState };

export interface SecretSpec {
  id: SecretId;
  /** The field label. */
  label: string;
  /** The environment variable the daemon falls back to. */
  env: string;
  /** The prefix of the connection's check ids. */
  prefix: string;
  placeholder: string;
}

const SPECS: Record<string, SecretSpec> = {
  linear: {
    id: "linear.api_key",
    label: "API key",
    env: SECRET_ENV["linear.api_key"],
    prefix: "linear.",
    placeholder: "lin_api_…",
  },
  slack: {
    id: "slack.webhook_url",
    label: "Webhook URL",
    env: SECRET_ENV["slack.webhook_url"],
    prefix: "slack.",
    placeholder: "https://hooks.slack.com/services/…",
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
  return isSecretReference(text.trim());
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

/** The toast after a save or remove. It reports the re-run checks, worst first. */
export function savedToast(
  title: string,
  label: string,
  action: "saved" | "removed",
  checks: readonly Check[],
): { type: "success" | "warning" | "error"; title: string; description: string } {
  const head = `${title} ${label} ${action}`;
  const blocking = checks.find((c) => c.state === "fail" || c.state === "missing");
  if (blocking) return { type: "error", title: head, description: blocking.detail };
  const warning = checks.find((c) => c.state === "warn");
  if (warning) return { type: "warning", title: head, description: warning.detail };
  return { type: "success", title: head, description: `${title} checks pass.` };
}
