import { LinearError } from "./linear/client.ts";

/**
 * Text that a failed `gh` or `git` call leaves behind when the failure was in transport.
 * A 5xx answer counts too: nothing about the request was wrong.
 */
const TRANSPORT_TEXT = [
  /fetch failed/i,
  /timeout/i,
  /\btimed out\b/i,
  /ECONNRESET/i,
  /ECONNREFUSED/i,
  /ETIMEDOUT/i,
  /EAI_AGAIN/i,
  /connection reset/i,
  /could not resolve host/i,
  /\bHTTP\s+5\d\d\b/i,
  /\bHTTP\s+5xx\b/i,
  /\b50x\b/i,
];

/**
 * Whether a failure was in transport, so it says nothing about the work (D-014).
 * Linear errors carry a code and a status; a `gh` error only carries text.
 */
export function isNetworkError(error: unknown): boolean {
  if (error instanceof LinearError) {
    if (error.code === "network") return true;
    return error.code === "http" && error.status !== undefined && error.status >= 500;
  }
  return TRANSPORT_TEXT.some((pattern) => pattern.test(errorText(error)));
}

function errorText(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}
