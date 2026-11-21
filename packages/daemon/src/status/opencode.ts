// OpenCode facts shared by the status engine and the setup routes (MET-92, part of MET-71).
// OpenCode 2.x reaches many model providers; each provider has its own sign-in. harnessd
// reads only provider ids from `opencode auth list`, never a credential field.
import { type MergedConfig, OPENCODE_PROVIDER, opencodeProvider } from "@harnessd/shared";

/** The oldest OpenCode harnessd is tested with. Below it, harness.opencode.version warns. */
export const OPENCODE_MIN_VERSION = "2.0.20";

/** The official installer. It puts the binary in ~/.opencode/bin. npm latest is still 1.x. */
export const OPENCODE_INSTALL = "curl -fsSL https://opencode.ai/install | bash";

/** argv after the binary. `--standalone` runs a private server, not the background service. */
export const OPENCODE_AUTH_LIST = ["auth", "list", "--format", "json", "--standalone"] as const;
export const OPENCODE_MODELS = ["models", "--standalone"] as const;
export const OPENCODE_UPGRADE = ["upgrade"] as const;

/**
 * The argv of a provider sign-in. The provider comes after `--`, as one item, so it can
 * never be read as a flag. No `--answer`: harnessd never passes a key.
 */
export function opencodeSigninArgs(provider: string): string[] {
  return ["auth", "login", "--standalone", "--", provider];
}

/** The sign-in command a person types in a terminal for one provider. */
export function opencodeSigninCommand(provider: string): string {
  return `opencode auth login ${provider}`;
}

/**
 * The signed-in provider ids from `opencode auth list --format json`, or undefined when
 * the output is not that list. Only `id` and the count of `connections` are read.
 */
export function parseAuthProviders(stdout: string): string[] | undefined {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (!Array.isArray(data)) return undefined;
  const ids = new Set<string>();
  for (const entry of data) {
    if (typeof entry !== "object" || entry === null) continue;
    const { id, connections } = entry as { id?: unknown; connections?: unknown };
    if (typeof id !== "string" || !OPENCODE_PROVIDER.test(id)) continue;
    if (Array.isArray(connections) && connections.length === 0) continue;
    ids.add(id);
  }
  return [...ids].sort();
}

/**
 * The providers that opencode agents name: `model` when `harness = "opencode"`, and
 * `fallback_model` when `fallback_harness = "opencode"`. Sorted, without repeats.
 */
export function requiredProviders(config: MergedConfig | undefined): string[] {
  const out = new Set<string>();
  for (const agent of Object.values(config?.agents ?? {})) {
    const models = [
      agent.harness === "opencode" ? agent.model : undefined,
      agent.fallback_harness === "opencode" ? agent.fallback_model : undefined,
    ];
    for (const model of models) {
      const provider = model === undefined ? undefined : opencodeProvider(model.trim());
      if (provider !== undefined) out.add(provider);
    }
  }
  return [...out].sort();
}

/** One valid `<provider>/<model>` id per line of `opencode models`, in order, without repeats. */
export function parseModels(stdout: string): string[] {
  const out = new Set<string>();
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (line !== "" && opencodeProvider(line) !== undefined) out.add(line);
  }
  return [...out];
}
