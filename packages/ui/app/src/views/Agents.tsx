// Each agent's run: task, latest action, elapsed time, budget used and tokens (MET-18).
// Live changes apply in place; the row under the pointer or focus keeps its place (MET-61).
import type { AgentsSnapshot, AgentView, RunView } from "@harnessd/shared";
import { useMemo } from "react";
import type { Load } from "../api.ts";
import { HarnessName } from "../components/service-logo.tsx";
import { Badge } from "../components/ui/badge.tsx";
import { Card } from "../components/ui/card.tsx";
import { ScrollArea } from "../components/ui/scroll-area.tsx";
import { Skeleton } from "../components/ui/skeleton.tsx";
import { type RowProps, usePin } from "../hooks/usePin.ts";
import { cn } from "../lib/cn.ts";
import { budgetText, budgetUsed, duration, tokens } from "../lib/format.ts";
import { agentLimit, type HarnessLimit, limitText } from "../lib/limits.ts";
import { EmptyState, ErrorState, ViewToolbar } from "./common.tsx";

/** Past this share of its budget a run is marked, so a timeout is no surprise. */
const BUDGET_WARN = 0.8;

function Budget({ run, now }: { run: RunView; now: Date }) {
  const used = budgetUsed(run.startedAt, run.budgetMs, now);
  const pct = Math.round(used * 100);
  const warn = used >= BUDGET_WARN;
  return (
    <span className="flex items-center gap-2">
      <span aria-hidden="true" className="h-1.5 w-20 overflow-hidden rounded-full bg-accent">
        <span
          className={cn("block h-full rounded-full", warn ? "bg-warning" : "bg-primary")}
          style={{ width: `${Math.min(100, pct)}%` }}
        />
      </span>
      <span
        className={cn(
          "w-10 text-right tabular-nums",
          warn && "font-medium text-warning-foreground",
        )}
      >
        {pct}%
      </span>
      <span className="text-muted-foreground">of {budgetText(run.budgetMs)}</span>
    </span>
  );
}

/** One table row: a run, or the Idle row of an agent with no runs. */
interface AgentRow {
  key: string;
  run: RunView | null;
}

interface AgentGroup {
  id: string;
  agent: AgentView;
  rows: AgentRow[];
}

const rowKey = (row: AgentRow) => row.key;
/** The agents' rows stack in one table, so a change above a pinned row holds too. */
const STACKED = { stacked: true };

function toGroups(agents: readonly AgentView[]): AgentGroup[] {
  return agents.map((agent) => ({
    id: agent.name,
    agent,
    rows:
      agent.runs.length > 0
        ? agent.runs.map((run) => ({ key: `${agent.name}/${run.issueKey}`, run }))
        : [{ key: agent.name, run: null }],
  }));
}

function AgentName({ agent, rows }: { agent: AgentView; rows: number }) {
  return (
    <th
      className="px-3 py-2.5 text-left align-top font-medium md:px-4"
      rowSpan={Math.max(1, rows)}
      scope="row"
    >
      <span className="block text-sm">{agent.name}</span>
      <span className="flex items-center gap-1 font-normal text-muted-foreground text-xs">
        {agent.role === agent.name ? "" : `${agent.role}, `}
        <HarnessName harness={agent.harness} />
      </span>
    </th>
  );
}

function AgentRows({
  group,
  limits,
  live,
  now,
  rowProps,
}: {
  group: AgentGroup;
  /** Holds in force. */
  limits: readonly HarnessLimit[];
  /** Keys of the rows in the newest snapshot. A pinned run not in it has ended. */
  live: ReadonlySet<string>;
  now: Date;
  rowProps: RowProps;
}) {
  const { agent } = group;
  // A pinned run that ended keeps its row; the agent is not also shown Idle below it. A pinned
  // Idle row keeps its place when the agent starts a run, until the pointer and focus leave.
  const idleBelowRun = (r: AgentRow, i: number) =>
    !r.run && live.has(r.key) && group.rows.slice(0, i).some((above) => above.run);
  const rows = group.rows.filter((r, i) => !idleBelowRun(r, i));
  return (
    <>
      {rows.map(({ key, run }, i) => {
        const name = i === 0 && <AgentName agent={agent} rows={rows.length} />;
        if (!run) {
          // A held harness says why the agent is idle (MET-70): a quiet state, not an error.
          const hold = agentLimit(agent, limits);
          return (
            <tr className="border-t" key={key} {...rowProps(key)}>
              {name}
              <td className="truncate px-4 py-2.5 text-muted-foreground" colSpan={4}>
                {hold ? limitText(hold) : "Idle"}
              </td>
            </tr>
          );
        }
        const ended = !live.has(key);
        return (
          <tr
            className={cn("border-t", run.stopping && !ended && "bg-warning-surface")}
            key={key}
            {...rowProps(key)}
          >
            {name}
            <td className="max-w-0 px-4 py-2.5 align-top">
              <span className="flex items-baseline gap-2">
                <span className="shrink-0 font-mono text-muted-foreground text-xs">
                  {run.issueKey}
                </span>
                <span className="truncate">{run.title}</span>
              </span>
              <span
                className={cn(
                  "flex min-w-0 items-center gap-1.5 overflow-hidden font-mono text-muted-foreground text-xs",
                  run.stopping && !ended && "text-warning-foreground",
                )}
              >
                <HarnessName
                  harness={run.harness ?? agent.harness}
                  className="shrink-0 font-sans"
                />
                {run.switchReason !== undefined && run.harness !== agent.harness && (
                  <span className="min-w-0 truncate">· {run.switchReason}</span>
                )}
                <span className="truncate">
                  {ended
                    ? "Ended"
                    : run.stopping
                      ? "Stopping for pause"
                      : (run.lastAction ?? "Starting")}
                </span>
              </span>
            </td>
            <td className="px-4 py-2.5 text-right align-top tabular-nums">
              {!ended && duration(now.getTime() - Date.parse(run.startedAt))}
            </td>
            <td className="hidden px-4 py-2.5 align-top text-xs lg:table-cell">
              {!ended && <Budget now={now} run={run} />}
            </td>
            <td className="hidden px-4 py-2.5 text-right align-top tabular-nums lg:table-cell">
              {tokens(run.tokens)}
            </td>
          </tr>
        );
      })}
    </>
  );
}

export function Agents({
  agents,
  limits,
  retry,
  now,
}: {
  agents: Load<AgentsSnapshot>;
  /** Holds in force. */
  limits: readonly HarnessLimit[];
  retry: () => void;
  now: Date;
}) {
  const snapshot = agents.status === "ready" ? agents.data : undefined;
  const groups = useMemo(() => snapshot && toGroups(snapshot.agents), [snapshot]);
  const { shown: rows, rowProps } = usePin(groups, rowKey, STACKED);
  const live = useMemo(() => new Set(groups?.flatMap((g) => g.rows.map(rowKey))), [groups]);
  const running = snapshot?.agents.reduce((n, a) => n + a.runs.length, 0) ?? 0;

  return (
    <section
      aria-busy={agents.status === "loading"}
      aria-label="Agents"
      className="flex min-h-0 flex-1 flex-col"
    >
      <ViewToolbar>
        {snapshot && (
          <Badge variant={running > 0 ? "success" : "secondary"}>
            {running} of {snapshot.maxConcurrent} running
          </Badge>
        )}
      </ViewToolbar>
      {agents.status === "loading" && !snapshot && (
        <div className="flex flex-col gap-2 px-4" aria-hidden="true">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton className="h-12" shape="card" key={i} />
          ))}
        </div>
      )}
      {agents.status === "error" && !snapshot && (
        <ErrorState onRetry={retry} text={`Could not load the agents. ${agents.error}`} />
      )}
      {snapshot && snapshot.agents.length === 0 && (
        <EmptyState>
          No agents are configured. Add one under [agents] in .harnessd/config.toml.
        </EmptyState>
      )}
      {snapshot && snapshot.agents.length > 0 && (
        <ScrollArea className="min-h-0 flex-1">
          <div className="px-4 pb-4">
            <Card className="overflow-hidden">
              <table className="w-full table-fixed border-collapse text-sm">
                <colgroup>
                  <col className="w-28 md:w-44" />
                  <col />
                  <col className="w-20 md:w-24" />
                  <col className="hidden lg:table-column lg:w-56" />
                  <col className="hidden lg:table-column lg:w-20" />
                </colgroup>
                <thead className="bg-muted/72 text-muted-foreground text-xs">
                  <tr>
                    <th className="px-4 py-2 text-left font-medium" scope="col">
                      Agent
                    </th>
                    <th className="px-4 py-2 text-left font-medium" scope="col">
                      Task
                    </th>
                    <th className="px-4 py-2 text-right font-medium" scope="col">
                      Elapsed
                    </th>
                    <th
                      className="hidden px-4 py-2 text-left font-medium lg:table-cell"
                      scope="col"
                    >
                      Budget used
                    </th>
                    <th
                      className="hidden px-4 py-2 text-right font-medium lg:table-cell"
                      scope="col"
                    >
                      Tokens
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows?.map((group) => (
                    <AgentRows
                      group={group}
                      key={group.id}
                      limits={limits}
                      live={live}
                      now={now}
                      rowProps={rowProps}
                    />
                  ))}
                </tbody>
              </table>
            </Card>
          </div>
        </ScrollArea>
      )}
    </section>
  );
}
