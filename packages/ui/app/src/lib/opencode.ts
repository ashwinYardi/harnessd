// What the OpenCode card and the Team model field show (MET-93, part of MET-71). OpenCode signs
// in per provider (D-036 in MET-92): each provider row has its own state and sign-in job.
import type { Load } from "../api.ts";
import type { Job, OpencodeModels, OpencodeProvider, OpencodeProviders } from "../setupApi.ts";
import type { Check } from "./checks.ts";
import { type LoginLink, loginLink } from "./signin.ts";

/** The key of a job in the page's job map: a provider sign-in has its own slot. */
export function jobKey(job: Pick<Job, "harness" | "provider">): string {
  return job.provider ? `${job.harness}:${job.provider}` : job.harness;
}

export interface ProviderRow {
  id: string;
  required: boolean;
  tone: Check["state"];
  status: "Signed in" | "Not signed in" | "Signing in";
  busy: boolean;
  canSignIn: boolean;
  link: LoginLink | undefined;
  code: string | undefined;
  /** The one command to run in a terminal, with Recheck. */
  manual: string | undefined;
}

/**
 * One provider row. The status engine says "signed in", not the job: once the recheck finds
 * the provider signed in, the old job shows nothing. A sign-in that ends failed, or that waits
 * for a typed key, shows the command to copy. The app never takes the key itself.
 */
export function providerRow(p: OpencodeProvider, job: Job | undefined): ProviderRow {
  const mine = job?.action === "signin" && job.provider === p.id ? job : undefined;
  const busy = mine?.state === "running";
  const base: ProviderRow = {
    id: p.id,
    required: p.required,
    // A running sign-in is not a failure yet: it shows amber until it ends.
    tone: p.signedIn ? "ok" : p.required && !busy ? "fail" : "warn",
    status: p.signedIn ? "Signed in" : busy ? "Signing in" : "Not signed in",
    busy,
    canSignIn: !p.signedIn,
    link: undefined,
    code: undefined,
    manual: undefined,
  };
  if (p.signedIn || !mine) return base;
  if (busy) return { ...base, link: loginLink(mine.url), code: mine.code };
  if (mine.state === "failed") return { ...base, manual: mine.manual ?? p.command };
  return base;
}

/** Required providers first, then by id, so a row keeps its place across live updates. */
const order = (a: OpencodeProvider, b: OpencodeProvider) =>
  Number(b.required) - Number(a.required) || a.id.localeCompare(b.id);

export type ProviderList =
  | { kind: "loading" }
  | { kind: "error"; text: string }
  | { kind: "empty"; note: string | undefined }
  | { kind: "ready"; providers: OpencodeProvider[]; note: string | undefined };

export function providerList(load: Load<OpencodeProviders>): ProviderList {
  if (load.status === "loading") return { kind: "loading" };
  if (load.status === "error") return { kind: "error", text: load.error };
  const { providers, reason } = load.data;
  if (providers.length === 0) return { kind: "empty", note: reason };
  return { kind: "ready", providers: [...providers].sort(order), note: reason };
}

export const MODEL_HELP = "Type provider/model, such as deepseek/deepseek-chat.";

/**
 * The model field of a Team row. Only an opencode row gets suggestions; free text always
 * stays allowed. An empty or failed list leaves one line of help.
 */
export function modelField(
  harness: string,
  models: Load<OpencodeModels>,
): { suggestions: string[]; help: string | undefined } {
  if (harness !== "opencode" || models.status === "loading") {
    return { suggestions: [], help: undefined };
  }
  if (models.status === "ready" && models.data.models.length > 0) {
    return { suggestions: models.data.models, help: undefined };
  }
  return { suggestions: [], help: MODEL_HELP };
}
