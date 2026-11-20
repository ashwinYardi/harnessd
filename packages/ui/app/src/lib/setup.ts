// Reads the status engine's checks into what the Settings cards show (MET-28).
import type { Check } from "./checks.ts";
import type { LoopState } from "./route.ts";

const RANK: Record<Check["state"], number> = { ok: 0, warn: 1, missing: 2, fail: 3 };

/** The worst state of a group: fail, then missing, then warn, then ok. */
export function worst(checks: readonly Check[]): Check["state"] {
  return checks.reduce<Check["state"]>((w, c) => (RANK[c.state] > RANK[w] ? c.state : w), "ok");
}

export interface HarnessSummary {
  found: boolean;
  version: string | undefined;
  path: string | undefined;
  signedIn: boolean;
  /** The sign-in check's detail, such as "signed in (claude.ai)" or "not signed in". */
  signIn: string;
  /** A known-bad version or an unreadable version. */
  warning: string | undefined;
  state: Check["state"];
  /** Why the CLI was not found. */
  reason?: string;
}

/** The cli check's detail is "<version line> (<path>)". */
export function harnessSummary(harness: string, checks: readonly Check[]): HarnessSummary {
  const get = (part: string) => checks.find((c) => c.id === `harness.${harness}.${part}`);
  const cli = get("cli");
  const auth = get("auth");
  const version = get("version");
  const found = cli?.state === "ok";
  const m = found ? /^(.*) \(([^()]+)\)$/.exec(cli?.detail ?? "") : null;
  const out: HarnessSummary = {
    found,
    version: m?.[1],
    path: m?.[2],
    signedIn: auth?.state === "ok",
    signIn: auth?.detail ?? "not checked",
    warning: version?.state === "warn" ? version.detail : undefined,
    state: worst(checks),
  };
  if (!found && cli) out.reason = cli.detail;
  return out;
}

export interface ConnectionCard {
  id: "github" | "linear" | "slack" | "git" | "port" | "skills";
  title: string;
  /** What the card checks, in a few words. */
  about: string;
  state: Check["state"];
  checks: Check[];
}

const CARDS: ReadonlyArray<Omit<ConnectionCard, "state" | "checks"> & { prefix: string }> = [
  {
    id: "github",
    title: "GitHub",
    about: "gh sign-in, push rights and required checks",
    prefix: "github.",
  },
  { id: "linear", title: "Linear", about: "API key, team and workflow states", prefix: "linear." },
  {
    id: "slack",
    title: "Slack",
    about: "Webhook for merges, blocks and the daily summary",
    prefix: "slack.",
  },
  { id: "git", title: "Git", about: "Worktrees in this repo", prefix: "git." },
  { id: "port", title: "Port", about: "The local port the app and API use", prefix: "daemon.port" },
  { id: "skills", title: "Skills", about: "The default skill pack", prefix: "skills." },
];

export function connectionCards(checks: readonly Check[]): ConnectionCard[] {
  return CARDS.map(({ prefix, ...card }) => {
    const mine = checks.filter((c) => c.id.startsWith(prefix));
    return { ...card, state: worst(mine), checks: mine };
  });
}

/** Secrets are set as environment variables only; the UI says where, never asks for a value. */
const ENV: Record<string, string> = {
  "linear.key": "LINEAR_API_KEY",
  "slack.webhook": "HARNESSD_SLACK_WEBHOOK_URL",
};

export function envFix(check: Check): string | undefined {
  const name = ENV[check.id];
  if (!name) return undefined;
  return `Set ${name} in your shell profile (for example ~/.zprofile), then restart harnessd.`;
}

/** A check that was not run because another one blocks (D-023: detail "not checked"). */
export function isWaiting(check: Check): boolean {
  return check.state === "missing" && check.detail === "not checked";
}

const AREA: ReadonlyArray<[string, string]> = [
  ["harness.claude-code.", "Claude Code"],
  ["harness.codex.", "Codex"],
  ["github.", "GitHub"],
  ["linear.", "Linear"],
  ["slack.", "Slack"],
  ["git.", "Git"],
  ["daemon.port", "Port"],
  ["skills.", "Skills"],
  ["config", "Config"],
  ["node", "Node"],
];

/** The areas with a blocking check, each named once, in the order the Settings pages show them. */
export function blockingAreas(checks: readonly Check[]): string[] {
  const bad = checks.filter((c) => c.state === "fail" || c.state === "missing");
  const out: string[] = [];
  for (const [prefix, name] of AREA) {
    if (bad.some((c) => c.id.startsWith(prefix))) out.push(name);
  }
  return out;
}

/**
 * Whether Start can be pressed. It is ready only when the checks have loaded, none blocks,
 * and the daemon names no blocker of its own (such as a missing LINEAR_API_KEY).
 */
export function startState(
  checks: readonly Check[] | undefined,
  loop: LoopState,
): { ready: boolean; areas: string[]; loading: boolean } {
  if (checks === undefined) return { ready: false, areas: [], loading: true };
  const areas = blockingAreas(checks);
  for (const id of loop.blocking) {
    const area = blockingAreas([{ id, state: "fail", detail: "", fix: "" }])[0];
    if (area && !areas.includes(area)) areas.push(area);
  }
  const order = AREA.map(([, name]) => name);
  areas.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return { ready: areas.length === 0, areas, loading: false };
}
