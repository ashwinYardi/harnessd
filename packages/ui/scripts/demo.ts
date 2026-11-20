// Serves the built UI with synthetic data, so the UI can be checked without Linear or a
// harness. The data is made up. Usage, after `pnpm build`:
//   node scripts/demo.ts [--port 4848] [--empty] [--broken] [--slow]

import { fileURLToPath } from "node:url";
import {
  agentsView,
  createBoardSource,
  createLogBuffer,
  createUiApi,
  type LoopSnapshot,
  mergeLayers,
  type PauseControl,
  type PauseState,
  startDaemon,
  staticRoutes,
} from "@harnessd/daemon";
import type { BoardIssue } from "@harnessd/shared";

const UI_DIR = fileURLToPath(new URL("../dist/app/", import.meta.url));
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const port = Number(args[args.indexOf("--port") + 1]) || 4848;
const empty = flag("empty");
const broken = flag("broken");
const slow = flag("slow");

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
if (!empty) {
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

const daemon = await startDaemon({
  port,
  pause,
  routes: [...ui.routes, ...(await staticRoutes(UI_DIR))],
});
console.log(`harnessd demo: ${daemon.url} (synthetic data)`);
