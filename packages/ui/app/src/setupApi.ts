// The Settings routes (docs/API.md, "Settings routes", MET-28).

import { post, request } from "./api.ts";
import type { Check } from "./lib/checks.ts";
import type { LoopState } from "./lib/route.ts";
import type { SecretId, SecretState } from "./lib/secrets.ts";

export type HarnessId = "claude-code" | "codex" | "opencode";
export type HarnessAction = "install" | "update" | "signin";

export interface Job {
  id: string;
  harness: HarnessId;
  action: HarnessAction;
  command: string;
  state: "running" | "ok" | "failed";
  exitCode?: number;
  lines: string[];
  startedAt: string;
  /** Sign-in only: the first https url in the output (MET-48). Opened only on a click. */
  url?: string;
  /** Sign-in only: the first device code in the output, such as ABCD-EFGH (MET-48). */
  code?: string;
  /** OpenCode sign-in only: the provider this job signs in (D-036 in MET-92). */
  provider?: string;
  /** The one command to run in a terminal: the OpenCode installer, or a key sign-in. */
  manual?: string;
}

export interface HarnessCard {
  id: HarnessId;
  name: string;
  /** An agent uses this harness, so its checks block the loop. */
  required: boolean;
  bin: string | null;
  checks: Check[];
  commands: Record<HarnessAction, string>;
  job: Job | null;
}

export interface TeamAgent {
  name: string;
  role: string;
  harness: string;
  model: string;
  removable: boolean;
}

export const readHarnesses = () => request<{ harnesses: HarnessCard[] }>("/api/harnesses");
export const runHarnessAction = (id: HarnessId, action: HarnessAction) =>
  post<Job>(`/api/harnesses/${id}/${action}`, {});
export const setHarnessPath = (id: HarnessId, path: string | null) =>
  post<{ bin: string | null }>(`/api/harnesses/${id}/path`, { path });
/** An OpenCode provider: signed in or not, and whether an opencode agent's model names it. */
export interface OpencodeProvider {
  id: string;
  signedIn: boolean;
  required: boolean;
  /** The sign-in command as text, for a person to run by hand. */
  command: string;
}

export interface OpencodeProviders {
  providers: OpencodeProvider[];
  /** Why the signed-in list could not be read, such as a missing CLI. */
  reason?: string;
}

export interface OpencodeModels {
  /** The `<provider>/<model>` ids that `opencode models` lists. */
  models: string[];
  reason?: string;
}

export const readOpencodeProviders = () =>
  request<OpencodeProviders>("/api/setup/opencode/providers");
export const readOpencodeModels = () => request<OpencodeModels>("/api/setup/opencode/models");
/** The path value must be a provider the daemon listed; the body is always `{}`. */
export const signinOpencodeProvider = (provider: string) =>
  post<Job>(`/api/setup/opencode/providers/${encodeURIComponent(provider)}/signin`, {});
export const readTeam = () => request<{ agents: TeamAgent[] }>("/api/team");
export const saveTeam = (agents: Array<Omit<TeamAgent, "removable">>) =>
  post<{ agents: TeamAgent[]; synced: string[]; syncError?: string }>("/api/team", { agents });
export const readLoop = () => request<LoopState>("/api/loop");
export const startLoop = () => post<LoopState>("/api/start", {});

/** The answer to a secret save or remove: the new state and that connection's checks. */
export interface SecretSaved {
  secret: SecretState;
  checks: Check[];
}

export const readSecrets = () => request<{ secrets: SecretState[] }>("/api/secrets");
/** Write-only: the value goes in and never comes back. */
export const saveSecret = (id: SecretId, value: string) =>
  post<SecretSaved>(`/api/secrets/${id}`, { value });
export const removeSecret = (id: SecretId) => post<SecretSaved>(`/api/secrets/${id}/remove`, {});
