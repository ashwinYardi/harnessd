// Read models the daemon serves to the UI (MET-18). See docs/API.md "UI routes".
import type { AgentRole } from "./config.ts";
import type { HarnessId } from "./index.ts";
import type { HarnessLimit } from "./limits.ts";
import type { Priority, Size } from "./linear.ts";

/** Tokens one parent used: input, cached (read plus write) and output (D-040). */
export interface TokenSum {
  input: number;
  cached: number;
  output: number;
}

/** One issue on the board. Linear is the source; the loop adds what it knows. */
export interface BoardIssue {
  id: string;
  /** Human key, e.g. "MET-41". */
  key: string;
  title: string;
  /** Workflow state name as named in Linear. */
  state: string;
  priority: Priority;
  labels: string[];
  size?: Size;
  url: string;
  /** Key of the parent, when this is a sub-issue. */
  parentKey?: string;
  /** Keys of unfinished issues that block this one. */
  blockedBy: string[];
  /** ISO time of the last change in Linear. */
  updatedAt: string;
  /** Set when a human must act before the loop can go on: the reason. */
  blocked?: string;
  /** The agent running this issue in this daemon, if any. */
  agent?: string;
  /** Tokens the issue spent across its runs, when it has any (D-040). */
  tokens?: TokenSum;
}

export interface BoardSnapshot {
  /** ISO time of the last good read of Linear; null before the first. */
  fetchedAt: string | null;
  issues: BoardIssue[];
  /** Why the last read failed. The issues are then the last good read. */
  error?: string;
}

/** One sub-issue run in flight, as the agent list shows it. */
export interface RunView {
  issueKey: string;
  title: string;
  startedAt: string;
  /** Wall-clock budget of the run (D-014). */
  budgetMs: number;
  /** Tokens used so far: input plus output. */
  tokens: number;
  /** The latest tool call or message of the agent. */
  lastAction?: string;
  /** True while a pause stops the run. */
  stopping: boolean;
}

export interface AgentView {
  name: string;
  role: AgentRole;
  harness: HarnessId;
  runs: RunView[];
}

export interface AgentsSnapshot {
  agents: AgentView[];
  /** ISO time of the loop's last poll of Linear; null before the first. */
  lastPollAt: string | null;
  maxConcurrent: number;
  /** Harness holds in force now (MET-82). An older daemon sends none. */
  limits?: HarnessLimit[];
}

export type LogLevel = "info" | "warn";

export interface LogLine {
  /** Increases by one per line. A restarted daemon starts above the last one (its start time in ms). */
  seq: number;
  at: string;
  /** "loop", or the agent name for agent actions. */
  source: string;
  /** The issue key the line is about, when it names one. */
  issueKey?: string;
  level: LogLevel;
  text: string;
}

export interface LogSnapshot {
  lines: LogLine[];
}

/** Where a self-update stands (MET-63, docs/LOOP.md "Self-update"). */
export type SelfUpdateState = "pending" | "applying" | "done" | "blocked" | "failed";

/** The last self-update, as loop.json keeps it and GET /api/loop returns it. */
export interface SelfUpdateView {
  /** The commit the old build came from. */
  from: string;
  /** The default branch head it updates to. */
  to: string;
  /** ISO time of the last change of state. */
  at: string;
  state: SelfUpdateState;
  /** Why it is blocked or failed. */
  error?: string;
}

/** GET /api/loop and POST /api/start (D-026, MET-82). */
export interface LoopView {
  state: "setup" | "running";
  /** Check ids that block the start; empty once the loop runs. */
  blocking: string[];
  /** Harness holds in force, when the loop runs. An expired hold is left out. */
  limits?: HarnessLimit[];
  /** The last self-update, once there was one (GET /api/loop only, MET-63). */
  selfUpdate?: SelfUpdateView;
}
