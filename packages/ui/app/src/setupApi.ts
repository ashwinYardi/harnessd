// The Settings routes (docs/API.md, "Settings routes", MET-28).

import { post, request } from "./api.ts";
import type { Check } from "./lib/checks.ts";
import type { LoopState } from "./lib/route.ts";
import type { SecretId, SecretState } from "./lib/secrets.ts";

export type HarnessId = "claude-code" | "codex";
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
  /** Sign-in only: the first https url in the output (D-031). Opened only on a click. */
  url?: string;
  /** Sign-in only: the first device code in the output, such as ABCD-EFGH (D-031). */
  code?: string;
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
