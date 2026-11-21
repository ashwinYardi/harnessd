// Reads the sign-in URL and device code from a harness CLI's login output (MET-58, D-031).
// The app shows them as a button and a copyable code. Only https URLs are kept.

export interface LoginPrompt {
  url?: string;
  code?: string;
}

const URL_RE = /https:\/\/[^\s"'<>`]+/i;
const CODE_RE = /(?<![A-Za-z0-9-])[A-Z0-9]{4,8}(?:-[A-Z0-9]{4,8})+(?![A-Za-z0-9-])/;
const CODE_WORD_RE = /\b(code|enter)\b/i;

function httpsUrl(text: string): string | undefined {
  const raw = URL_RE.exec(text)?.[0].replace(/[.,;:!?)\]}]+$/, "");
  if (raw === undefined) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && url.hostname !== "" ? raw : undefined;
  } catch {
    return undefined;
  }
}

/** Finds the first https URL and, on a line that says "code" or "enter", a device code. */
export function parseLoginPrompt(line: string): LoginPrompt {
  const out: LoginPrompt = {};
  const url = httpsUrl(line);
  if (url !== undefined) out.url = url;
  if (CODE_WORD_RE.test(line)) {
    // A code inside a URL is part of the URL, not a code to type.
    const code = CODE_RE.exec(line.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, " "))?.[0];
    if (code !== undefined && /[A-Z]/.test(code)) out.code = code;
  }
  return out;
}
