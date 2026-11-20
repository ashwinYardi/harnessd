// The launchd service as the status engine sees it (MET-38). `harnessd init` writes the
// plist; this module only reads it, to find the Node the service will run.

import { join } from "node:path";

/** The launchd label, also the plist's file name. Shared with `harnessd init`. */
export const LAUNCHD_LABEL = "dev.harnessd.daemon";

/** `~/Library/LaunchAgents/<label>.plist` under `home`. */
export function launchdPlistPath(home: string): string {
  return join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

function unxml(s: string): string {
  return s
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

export interface ServicePlist {
  /** ProgramArguments[0]: the harnessd command. */
  program: string;
  /** EnvironmentVariables PATH; undefined when the plist sets none. */
  path: string | undefined;
}

/** Reads the two keys the node check needs from a plist; undefined if there is no program. */
export function parseServicePlist(text: string): ServicePlist | undefined {
  const program = /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>/.exec(text);
  if (!program?.[1]) return undefined;
  const env = /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(text)?.[1];
  const path = env ? /<key>PATH<\/key>\s*<string>([^<]*)<\/string>/.exec(env)?.[1] : undefined;
  return { program: unxml(program[1]), path: path === undefined ? undefined : unxml(path) };
}

/** Wrappers longer than this are not the short shell script the Install block writes. */
const WRAPPER_MAX = 4096;

/**
 * The absolute path a short shell wrapper execs, quoted or not; undefined when `text` is
 * not such a wrapper (for example the npm bin with an `env node` shebang).
 */
export function wrapperExecPath(text: string): string | undefined {
  if (text.length > WRAPPER_MAX || !/^#!\s*\/\S*sh\b/.test(text)) return undefined;
  for (const line of text.split("\n")) {
    const m = /^\s*exec\s+(?:"(\/[^"]+)"|'(\/[^']+)'|(\/\S+))/.exec(line);
    if (m) return m[1] ?? m[2] ?? m[3];
  }
  return undefined;
}
