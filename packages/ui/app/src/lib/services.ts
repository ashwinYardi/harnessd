// The services harnessd works with, and the logo each one shows (D-029). Paths come from
// Simple Icons; only the icons used are imported, so the build carries six paths.
import type { HarnessId } from "@harnessd/shared";
import { siClaude, siGit, siGithub, siLinear } from "simple-icons";
import { OPENAI_PATH, SLACK_PATH } from "./service-paths.ts";

export const SERVICE_IDS = ["github", "linear", "slack", "claude", "openai", "git"] as const;
export type ServiceId = (typeof SERVICE_IDS)[number];

export interface Service {
  /** The brand's own name, used as the logo's accessible name. */
  name: string;
  /** One SVG path on a 24 by 24 grid. */
  path: string;
  license: "CC0-1.0" | "CC-BY-3.0";
  /** An attribution the license asks for. */
  credit?: string;
}

export const SERVICES: Record<ServiceId, Service> = {
  github: { name: siGithub.title, path: siGithub.path, license: "CC0-1.0" },
  linear: { name: siLinear.title, path: siLinear.path, license: "CC0-1.0" },
  slack: { name: "Slack", path: SLACK_PATH, license: "CC0-1.0" },
  claude: { name: siClaude.title, path: siClaude.path, license: "CC0-1.0" },
  openai: { name: "OpenAI", path: OPENAI_PATH, license: "CC0-1.0" },
  git: {
    name: siGit.title,
    path: siGit.path,
    license: "CC-BY-3.0",
    credit: "Git logo by Jason Long, CC BY 3.0",
  },
};

const HARNESS: Partial<Record<HarnessId, ServiceId>> = { "claude-code": "claude", codex: "openai" };

/** The logo of the company that makes a harness CLI, if harnessd has one. */
export function harnessService(harness: string): ServiceId | undefined {
  return HARNESS[harness as HarnessId];
}

const CONNECTION: Record<string, ServiceId> = {
  github: "github",
  linear: "linear",
  slack: "slack",
  git: "git",
};

/** The logo of a Settings → Connections card. Port and skills are harnessd's own; no logo. */
export function connectionService(id: string): ServiceId | undefined {
  return CONNECTION[id];
}
