// Secrets the app saves (MET-33, D-030): the fixed ids, what the API may say about one, and
// the reference shapes. Shared by the daemon, which stores them, and the UI, which takes them.

/** Fixed ids. A file name is always one of these, never text from a request. */
export const SECRET_IDS = ["linear.api_key", "slack.webhook_url"] as const;
export type SecretId = (typeof SECRET_IDS)[number];

export function isSecretId(id: string): id is SecretId {
  return (SECRET_IDS as readonly string[]).includes(id);
}

/** The environment variable each secret falls back to. */
export const SECRET_ENV: Record<SecretId, string> = {
  "linear.api_key": "LINEAR_API_KEY",
  "slack.webhook_url": "HARNESSD_SLACK_WEBHOOK_URL",
};

/** Where the lookup found a secret. */
export type SecretSource = "saved" | "1Password" | "env";

/** What the API and the status engine may say about a secret: never its value. */
export interface SecretState {
  id: SecretId;
  set: boolean;
  source: SecretSource | null;
  /** A value or reference is saved here, so Remove applies; false for the variable fallback. */
  stored: boolean;
}

/**
 * A secret reference: `op://vault/item/field` (or `op://vault/item/section/field`), read
 * with the 1Password CLI at use time, or `env:NAME`. Config holds only references.
 */
export const OP_REFERENCE = /^op:\/\/[^/\s]+\/[^/\s]+(\/[^/\s]+){1,2}$/;
export const ENV_REFERENCE = /^env:[A-Za-z_][A-Za-z0-9_]*$/;

export function isSecretReference(value: string): boolean {
  return OP_REFERENCE.test(value) || ENV_REFERENCE.test(value);
}
