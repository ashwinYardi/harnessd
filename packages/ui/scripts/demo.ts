// Serves the built UI with synthetic data, so the UI can be checked without Linear or a
// harness. The data is made up. Usage, after `pnpm build`:
//   node scripts/demo.ts [--port 4848] [--empty] [--broken] [--slow] [--setup] [--static]
// --setup makes the harness checks fail, as on a fresh machine.
// --static serves no live event stream, so a page scanner such as `impeccable detect <url>`
// sees the network go idle. The page loads its data once and shows the stream as down.

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  agentsView,
  type Check,
  createBoardSource,
  createLogBuffer,
  createSecretStore,
  createUiApi,
  HttpError,
  type LoopSnapshot,
  mergeLayers,
  type PauseControl,
  type PauseState,
  type Route,
  secretRoutes,
  setupRoutes,
  startDaemon,
  staticRoutes,
  statusRoutes,
} from "@harnessd/daemon";
import type { BoardIssue } from "@harnessd/shared";

const UI_DIR = fileURLToPath(new URL("../dist/app/", import.meta.url));
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const port = Number(args[args.indexOf("--port") + 1]) || 4848;
const empty = flag("empty");
const broken = flag("broken");
const slow = flag("slow");
const setup = flag("setup");
const staticMode = flag("static");

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const issue = (
  n: number,
  state: string,
  title: string,
  extra: Partial<BoardIssue> = {},
): BoardIssue => ({
  id: `demo-${n}`,
  key: `MET-${n}`,
  title,
  state,
  priority: 3,
  labels: [],
  size: "S",
  url: `https://linear.app/demo/issue/MET-${n}`,
  blockedBy: [],
  updatedAt: ago(n),
  ...extra,
});

const ISSUES: BoardIssue[] = [
  issue(16, "Needs input", "Slack pings go to #harnessd with one line per merge or block", {
    priority: 2,
    size: "M",
  }),
  issue(52, "In Review", "Merge gate reads code owners from the repo", {
    parentKey: "MET-50",
  }),
  issue(27, "Backlog", "Codex adapter runs tasks headless", { size: "M" }),
  issue(29, "Backlog", "Linux install script sets up a systemd unit"),
  issue(30, "Backlog", "Team canvas shows personas and avatars", { size: undefined }),
  issue(44, "Ready", "Budget warning at 80 percent posts a comment", { priority: 2 }),
  issue(45, "Ready", "QA: Budget warning at 80 percent", { blockedBy: ["MET-44"] }),
  issue(46, "Ready", "Vault search ranks recent decisions first"),
  issue(41, "In Progress", "Board API reads open issues from Linear", {
    priority: 1,
    parentKey: "MET-40",
  }),
  issue(42, "In Progress", "Agent list shows task, elapsed time and budget", {
    parentKey: "MET-40",
    size: "M",
  }),
  issue(48, "In Progress", "QA: Worktree cleanup after a crash", { parentKey: "MET-47" }),
  issue(39, "In Review", "Pause keeps worktrees for inspection", { parentKey: "MET-38" }),
  issue(35, "Done", "harnessd pause stops all agents within 10 seconds"),
  issue(34, "Done", "Auto-merge when CI is green and QA approved"),
  issue(33, "Done", "One-line install sets up harnessd on a fresh Mac"),
];

const SNAPSHOT: LoopSnapshot = {
  lastPollAt: ago(0.2),
  runs: [
    {
      issueId: "demo-41",
      issueKey: "MET-41",
      title: "Board API reads open issues from Linear",
      agent: "backend",
      role: "backend",
      startedAt: ago(26),
      budgetMs: 30 * 60_000,
      tokens: 184_300,
      lastAction: "Bash pnpm --filter @harnessd/daemon test",
      stopping: false,
    },
    {
      issueId: "demo-42",
      issueKey: "MET-42",
      title: "Agent list shows task, elapsed time and budget",
      agent: "frontend",
      role: "frontend",
      startedAt: ago(41),
      budgetMs: 120 * 60_000,
      tokens: 96_800,
      lastAction: "Edit packages/ui/app/src/Agents.tsx",
      stopping: false,
    },
    {
      issueId: "demo-48",
      issueKey: "MET-48",
      title: "QA: Worktree cleanup after a crash",
      agent: "qa",
      role: "qa",
      startedAt: ago(4),
      budgetMs: 30 * 60_000,
      tokens: 12_400,
      lastAction: "Read packages/daemon/src/worktrees/index.ts",
      stopping: false,
    },
  ],
  blocked: [
    {
      issueKey: "MET-52",
      parentKey: "MET-50",
      prUrl: "https://github.com/demo/harnessd/pull/52",
      reason: "touches protected paths",
    },
  ],
};

let paused: PauseState = { paused: false };
const pause: PauseControl = {
  status: async () => paused,
  async pause(reason) {
    paused = { paused: true, since: new Date().toISOString() };
    if (reason) paused.reason = reason;
    await sleep(1200); // runs take a moment to exit
    return { ...paused, cancelled: empty ? 0 : SNAPSHOT.runs.length };
  },
  async resume() {
    paused = { paused: false };
    return paused;
  },
};

const snapshot = (): LoopSnapshot =>
  empty
    ? { lastPollAt: ago(0.1), runs: [], blocked: [] }
    : {
        ...SNAPSHOT,
        runs: SNAPSHOT.runs.map((r) => ({ ...r, stopping: paused.paused })),
      };

const logs = createLogBuffer();
if (!empty) {
  for (const line of [
    "MET-40: split into MET-41, MET-42 and QA MET-43",
    "MET-41: backend started (S, 30 min)",
    "MET-42: frontend started (M, 120 min)",
    "MET-16: grill escalated, Needs input",
    "MET-48: qa started QA of MET-47",
    "MET-52: needs a human (touches protected paths): PR #52",
  ]) {
    logs.push(line);
  }
  logs.push("Read packages/daemon/src/linear/client.ts", { source: "backend", issueKey: "MET-41" });
  logs.push("Edit packages/ui/app/src/Agents.tsx", { source: "frontend", issueKey: "MET-42" });
}
const ACTIONS: Array<[string, string, string]> = [
  ["backend", "MET-41", "Bash pnpm --filter @harnessd/daemon test"],
  ["frontend", "MET-42", "Edit packages/ui/app/src/styles.css"],
  ["qa", "MET-48", "Grep removeWorktree"],
  ["backend", "MET-41", "Edit packages/daemon/src/linear/client.ts"],
];
let next = 0;
if (!empty && !staticMode) {
  setInterval(() => {
    const action = ACTIONS[next++ % ACTIONS.length];
    if (action) logs.push(action[2], { source: action[0], issueKey: action[1] });
  }, 4000).unref();
}

const config = mergeLayers([]);
const ui = createUiApi({
  board: createBoardSource({
    async read() {
      if (slow) await sleep(60_000);
      if (broken) throw new Error("Linear answered 401: the API key is not valid.");
      return empty ? [] : ISSUES;
    },
    loop: snapshot,
  }),
  agents: () => agentsView(config, snapshot()),
  logs,
  pause,
});

const ok = (id: string, detail: string): Check => ({ id, state: "ok", detail, fix: "" });
// --setup starts with Claude Code missing and Codex signed out; Install fixes the first.
let claudeInstalled = !setup;
const harnessChecks = (): Check[] => [
  claudeInstalled
    ? ok("harness.claude-code.cli", "2.1.4 (Claude Code) (/opt/homebrew/bin/claude)")
    : {
        id: "harness.claude-code.cli",
        state: "missing",
        detail: "claude is not on PATH",
        fix: "Install it: npm i -g @anthropic-ai/claude-code",
      },
  claudeInstalled
    ? ok("harness.claude-code.auth", "signed in (claude.ai)")
    : {
        id: "harness.claude-code.auth",
        state: "missing",
        detail: "not checked",
        fix: "Fix harness.claude-code.cli first.",
      },
  claudeInstalled
    ? ok("harness.claude-code.version", "2.1.4 has no known problems")
    : {
        id: "harness.claude-code.version",
        state: "missing",
        detail: "not checked",
        fix: "Fix harness.claude-code.cli first.",
      },
  ok("harness.codex.cli", "codex-cli 0.60.0 (/opt/homebrew/bin/codex)"),
  setup
    ? { id: "harness.codex.auth", state: "fail", detail: "not signed in", fix: "Run: codex login" }
    : ok("harness.codex.auth", "signed in"),
  {
    id: "harness.codex.version",
    state: "warn",
    detail: "0.60.0 is known bad: drops tool output over 1 MB",
    fix: "Update it: npm i -g @openai/codex@latest",
  },
];
// Linear and Slack read the real secret store in the scratch folder (MET-33). A key that
// contains "bad" is rejected, so the error state can be shown.
let connectionChecks: Check[] = [];
async function connections(only?: readonly string[]): Promise<Check[]> {
  const out: Check[] = [];
  if (!only || only.includes("linear")) {
    const key = await secrets.resolve("linear.api_key").catch(() => undefined);
    if (!key) {
      out.push(
        {
          id: "linear.key",
          state: "missing",
          detail: "no key is saved and LINEAR_API_KEY is not set",
          fix: "Paste a Linear personal API key in Settings, Connections, Linear.",
        },
        {
          id: "linear.team",
          state: "missing",
          detail: "not checked",
          fix: "Fix linear.key first.",
        },
        {
          id: "linear.states",
          state: "missing",
          detail: "not checked",
          fix: "Fix linear.key first.",
        },
      );
    } else if (key.value.includes("bad")) {
      out.push(
        {
          id: "linear.key",
          state: "fail",
          detail: `Linear rejected the key (${key.source})`,
          fix: "Create a new personal API key in Linear, then replace it in Settings, Connections, Linear.",
        },
        {
          id: "linear.team",
          state: "missing",
          detail: "not checked",
          fix: "Fix linear.key first.",
        },
        {
          id: "linear.states",
          state: "missing",
          detail: "not checked",
          fix: "Fix linear.key first.",
        },
      );
    } else {
      out.push(
        ok("linear.key", `accepted (${key.source})`),
        ok("linear.team", "MET"),
        ok("linear.states", "Ready, In Progress, In Review, Done, Needs input"),
      );
    }
  }
  if (!only || only.includes("slack")) {
    const hook = await secrets.resolve("slack.webhook_url").catch(() => undefined);
    out.push(
      hook
        ? ok("slack.webhook", `set (${hook.source})`)
        : {
            id: "slack.webhook",
            state: "warn",
            detail:
              "no webhook is saved and HARNESSD_SLACK_WEBHOOK_URL is not set; no Slack lines are sent",
            fix: "Create a Slack incoming webhook, then paste its url in Settings, Connections, Slack.",
          },
    );
  }
  return out;
}
const CHECKS = (): Check[] => [
  ok("node", "v24.11.0 (/opt/homebrew/bin/node)"),
  ok("config", "5 agents"),
  // The demo team has qa on Codex, so the real engine would check both harnesses.
  ...harnessChecks(),
  ok("github.cli", "gh 2.83.0"),
  ok("github.auth", "signed in as demo-owner"),
  ok("github.push", "demo/harnessd: WRITE"),
  ok("github.ci", "main requires: ci"),
  ...connectionChecks,
  ok("git.worktrees", "3 worktrees in /Users/demo/harnessd"),
  ok("daemon.port", "4848 is served by this daemon"),
  ok("skills.pack", "16 of 16 skills in place"),
];
const fresh = async (): Promise<Check[]> => {
  connectionChecks = await connections();
  return CHECKS();
};
const blocking = () =>
  CHECKS()
    .filter((c) => c.state === "fail" || c.state === "missing")
    .map((c) => c.id);

// A throwaway repo and global folder, so Settings → Team writes real files.
const scratch = await mkdtemp(join(tmpdir(), "harnessd-demo-"));
const repoDir = join(scratch, "repo");
const globalDir = join(scratch, "global");
await mkdir(join(repoDir, ".harnessd"), { recursive: true });
await mkdir(globalDir, { recursive: true });
const secrets = createSecretStore({ globalDir, env: {} });
// Without --setup the demo starts with a saved key, as on a set-up machine.
if (!setup) await secrets.save("linear.api_key", "lin_api_demo0000000000000000");
connectionChecks = await connections();
await writeFile(
  join(repoDir, ".harnessd", "config.toml"),
  '# Demo workspace.\n[linear]\nteam_id = "MET"\n\n# QA runs on Codex.\n[agents.qa]\nharness = "codex"\nmodel = "gpt-5"\n\n# Writes the docs.\n[agents.docs]\nrole = "frontend"\nharness = "claude-code"\n',
);
const setupApi = setupRoutes({
  repoDir,
  globalDir,
  env: {},
  platform: "darwin",
  checks: async (o) => {
    await sleep(300);
    return o.harnessesOnly ? harnessChecks() : fresh();
  },
  isExecutable: async (p) => p.startsWith("/opt/"),
  sync: async () => ({ changed: ["AGENTS.md", ".claude/agents/docs.md"], skipped: [] }),
  // Synthetic output; nothing is installed.
  runner: async (cmd, args, onLine) => {
    const lines =
      cmd === "osascript"
        ? []
        : ["npm warn deprecated inflight@1.0.6", "added 3 packages in 4s", "changed 1 package"];
    for (const line of lines) {
      await sleep(700);
      onLine(line);
    }
    if (args.includes("@anthropic-ai/claude-code")) claudeInstalled = true;
    return 0;
  },
});
let started = !setup;
const loopRoutes: Route[] = [
  {
    method: "GET",
    path: "/api/loop",
    handler: async () => {
      await fresh();
      return { state: started ? "running" : "setup", blocking: started ? [] : blocking() };
    },
  },
  {
    method: "POST",
    path: "/api/start",
    handler: async () => {
      await fresh();
      const now = blocking();
      if (now.length > 0)
        throw new HttpError(409, "setup_incomplete", `Fix these first: ${now.join(", ")}.`);
      started = true;
      return { state: "running", blocking: [] };
    },
  },
];

const daemon = await startDaemon({
  port,
  pause,
  routes: [
    // A 503 ends an EventSource for good: it does not reconnect, so the network goes idle.
    ...ui.routes.map((route) =>
      staticMode && route.path === "/api/events"
        ? {
            ...route,
            handler: () => {
              throw new HttpError(503, "static_demo", "the static demo has no event stream");
            },
          }
        : route,
    ),
    ...statusRoutes(async () => {
      await sleep(400);
      return fresh();
    }),
    ...setupApi.routes,
    ...secretRoutes({
      store: secrets,
      checks: async (o) => {
        await sleep(300);
        return connections(o.connectionsOnly);
      },
    }),
    ...loopRoutes,
    ...(await staticRoutes(UI_DIR)),
  ],
});
console.log(`harnessd demo: ${daemon.url} (synthetic data${staticMode ? ", static" : ""})`);
