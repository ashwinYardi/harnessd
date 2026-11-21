// What the harness card shows during a sign-in job (MET-59, part of MET-48): the login link, the
// device code, or the one command to copy. The browser opens only on the person's click.
import type { Job } from "../setupApi.ts";

export interface LoginLink {
  href: string;
  host: string;
  /** A new tab; in Electron the shell opens it in the default browser. */
  target: "_blank";
  rel: "noopener noreferrer";
}

/** Only an https url becomes a link. Any other scheme, or a url that does not parse, is dropped. */
export function loginLink(url: string | undefined): LoginLink | undefined {
  if (!url?.startsWith("https://")) return undefined;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.host
      ? { href: url, host: u.host, target: "_blank", rel: "noopener noreferrer" }
      : undefined;
  } catch {
    return undefined;
  }
}

export interface SigninPanel {
  link: LoginLink | undefined;
  code: string | undefined;
  /** Show `commands.signin` to copy, with Recheck. */
  fallback: boolean;
}

const NONE: SigninPanel = { link: undefined, code: undefined, fallback: false };

/**
 * While the sign-in runs, the link and the code. When it ends failed, or ends with no link and
 * no code, and the harness is still not signed in, the command to run by hand. The status
 * engine says "signed in", not the exit code.
 */
export function signinPanel(job: Job | null, signedIn: boolean): SigninPanel {
  if (job?.action !== "signin" || signedIn) return NONE;
  const link = loginLink(job.url);
  if (job.state === "running") return { link, code: job.code, fallback: false };
  const prompted = link !== undefined || job.code !== undefined;
  return { ...NONE, fallback: job.state === "failed" || !prompted };
}

export interface JobStream {
  (job: Job): void;
  /** A job this page started: its next final event is announced. */
  started(job: Job): void;
}

/**
 * Handles each `job` event of /api/setup/events. A job ends once, when it leaves "running";
 * then the card is checked again. Jobs replayed on connect are shown, not announced.
 */
export function jobStream(on: {
  show: (job: Job) => void;
  ended: (job: Job) => void;
  recheck: () => void;
}): JobStream {
  const seen = new Map<string, Job["state"]>();
  const onJob = ((job: Job) => {
    const before = seen.get(job.id);
    seen.set(job.id, job.state);
    on.show(job);
    if (before !== "running" || job.state === "running") return;
    on.ended(job);
    on.recheck();
  }) as JobStream;
  onJob.started = (job) => {
    seen.set(job.id, "running");
  };
  return onJob;
}

/** True when the text reached the clipboard. */
export async function copyText(
  clipboard: Pick<Clipboard, "writeText"> | undefined,
  text: string,
): Promise<boolean> {
  if (!clipboard) return false;
  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
