// Each agent's run: task, latest action, elapsed time, budget used and tokens (MET-18).
import type { AgentsSnapshot, AgentView, RunView } from "@harnessd/shared";
import type { Load } from "../api.ts";
import { Badge } from "../components/ui/badge.tsx";
import { Card } from "../components/ui/card.tsx";
import { ScrollArea } from "../components/ui/scroll-area.tsx";
import { Skeleton } from "../components/ui/skeleton.tsx";
import { useHold } from "../hooks/useHold.ts";
import { cn } from "../lib/cn.ts";
import { budgetText, budgetUsed, duration, tokens } from "../lib/format.ts";
import { EmptyState, ErrorState, HeldUpdates, ViewToolbar } from "./common.tsx";

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

function AgentName({ agent }: { agent: AgentView }) {
  return (
    <th
      className="px-4 py-2.5 text-left align-top font-medium"
      rowSpan={Math.max(1, agent.runs.length)}
      scope="row"
    >
      <span className="block text-sm">{agent.name}</span>
      <span className="block font-normal text-muted-foreground text-xs">
        {agent.role === agent.name ? "" : `${agent.role}, `}
        {agent.harness}
      </span>
    </th>
  );
}

function AgentRows({ agent, now }: { agent: AgentView; now: Date }) {
  if (agent.runs.length === 0) {
    return (
      <tr className="border-t">
        <AgentName agent={agent} />
        <td className="px-4 py-2.5 text-muted-foreground" colSpan={4}>
          Idle
        </td>
      </tr>
    );
  }
  return (
    <>
      {agent.runs.map((run, i) => (
        <tr className={cn("border-t", run.stopping && "bg-warning-surface")} key={run.issueKey}>
          {i === 0 && <AgentName agent={agent} />}
          <td className="max-w-0 px-4 py-2.5 align-top">
            <span className="flex items-baseline gap-2">
              <span className="shrink-0 font-mono text-muted-foreground text-xs">
                {run.issueKey}
              </span>
              <span className="truncate">{run.title}</span>
            </span>
            <span
              className={cn(
                "block truncate font-mono text-muted-foreground text-xs",
                run.stopping && "text-warning-foreground",
              )}
            >
              {run.stopping ? "Stopping for pause" : (run.lastAction ?? "Starting")}
            </span>
          </td>
          <td className="px-4 py-2.5 text-right align-top tabular-nums">
            {duration(now.getTime() - Date.parse(run.startedAt))}
          </td>
          <td className="px-4 py-2.5 align-top text-xs">
            <Budget now={now} run={run} />
          </td>
          <td className="px-4 py-2.5 text-right align-top tabular-nums">{tokens(run.tokens)}</td>
        </tr>
      ))}
    </>
  );
}

export function Agents({
  agents,
  retry,
  now,
}: {
  agents: Load<AgentsSnapshot>;
  retry: () => void;
  now: Date;
}) {
  const snapshot = agents.status === "ready" ? agents.data : undefined;
  const { shown, pending, apply, regionProps } = useHold(snapshot);
  const running = shown?.agents.reduce((n, a) => n + a.runs.length, 0) ?? 0;

  return (
    <section
      aria-busy={agents.status === "loading"}
      aria-label="Agents"
      className="flex min-h-0 flex-1 flex-col"
      {...regionProps}
    >
      <ViewToolbar>
        {shown && (
          <Badge variant={running > 0 ? "success" : "secondary"}>
            {running} of {shown.maxConcurrent} running
          </Badge>
        )}
        <HeldUpdates pending={pending} onApply={apply} />
      </ViewToolbar>
      {agents.status === "loading" && !shown && (
        <div className="flex flex-col gap-2 px-4" aria-hidden="true">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton className="h-12" shape="card" key={i} />
          ))}
        </div>
      )}
      {agents.status === "error" && !shown && (
        <ErrorState onRetry={retry} text={`Could not load the agents. ${agents.error}`} />
      )}
      {shown && shown.agents.length === 0 && (
        <EmptyState>
          No agents are configured. Add one under [agents] in .harnessd/config.toml.
        </EmptyState>
      )}
      {shown && shown.agents.length > 0 && (
        <ScrollArea className="min-h-0 flex-1">
          <div className="px-4 pb-4">
            <Card className="overflow-hidden">
              <table className="w-full table-fixed border-collapse text-sm">
                <colgroup>
                  <col className="w-44" />
                  <col />
                  <col className="w-24" />
                  <col className="w-56" />
                  <col className="w-20" />
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
                    <th className="px-4 py-2 text-left font-medium" scope="col">
                      Budget used
                    </th>
                    <th className="px-4 py-2 text-right font-medium" scope="col">
                      Tokens
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {shown.agents.map((agent) => (
                    <AgentRows agent={agent} key={agent.name} now={now} />
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
