import type { AgentsSnapshot, AgentView, RunView } from "@harnessd/shared";
import type { Load } from "./api.ts";
import { budgetText, budgetUsed, duration, tokens } from "./lib/format.ts";
import { useHold } from "./useHold.ts";

/** Past this share of its budget a run is marked, so a timeout is no surprise. */
const BUDGET_WARN = 0.8;

function Budget({ run, now }: { run: RunView; now: Date }) {
  const used = budgetUsed(run.startedAt, run.budgetMs, now);
  const pct = Math.round(used * 100);
  return (
    <span className="budget" data-warn={used >= BUDGET_WARN || undefined}>
      <span className="budget-bar" aria-hidden="true">
        <span className="budget-fill" style={{ width: `${pct}%` }} />
      </span>
      <span className="num">{pct}%</span>
      <span className="budget-of">of {budgetText(run.budgetMs)}</span>
    </span>
  );
}

function AgentName({ agent }: { agent: AgentView }) {
  return (
    <th scope="row" rowSpan={Math.max(1, agent.runs.length)} className="agent-name">
      <span>{agent.name}</span>
      <span className="agent-sub">
        {agent.role === agent.name ? "" : `${agent.role}, `}
        {agent.harness}
      </span>
    </th>
  );
}

function AgentRows({ agent, now }: { agent: AgentView; now: Date }) {
  if (agent.runs.length === 0) {
    return (
      <tr>
        <AgentName agent={agent} />
        <td colSpan={4} className="idle">
          Idle
        </td>
      </tr>
    );
  }
  return (
    <>
      {agent.runs.map((run, i) => (
        <tr key={run.issueKey} data-stopping={run.stopping || undefined}>
          {i === 0 && <AgentName agent={agent} />}
          <td className="task">
            <span className="task-line">
              <span className="issue-key">{run.issueKey}</span>
              <span className="task-title">{run.title}</span>
            </span>
            <span className="task-action">
              {run.stopping ? "Stopping for pause" : (run.lastAction ?? "Starting")}
            </span>
          </td>
          <td className="num">{duration(now.getTime() - Date.parse(run.startedAt))}</td>
          <td>
            <Budget run={run} now={now} />
          </td>
          <td className="num">{tokens(run.tokens)}</td>
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
      className="region region-agents"
      aria-labelledby="agents-title"
      aria-busy={agents.status === "loading"}
    >
      <header className="region-head">
        <h2 id="agents-title">Agents</h2>
        {shown && (
          <span className="meta">
            {running} of {shown.maxConcurrent} running
          </span>
        )}
        <span className="head-end">
          {pending > 0 && (
            <button type="button" className="btn btn-small" onClick={apply}>
              Show {pending} {pending === 1 ? "update" : "updates"}
            </button>
          )}
        </span>
      </header>
      {agents.status === "loading" && !shown && (
        <div className="region-body" aria-hidden="true">
          {[0, 1, 2, 3].map((i) => (
            <div className="skel skel-line" key={i} />
          ))}
        </div>
      )}
      {agents.status === "error" && !shown && (
        <div className="state-error" role="alert">
          <p>Could not load the agents. {agents.error}</p>
          <button type="button" className="btn" onClick={retry}>
            Retry
          </button>
        </div>
      )}
      {shown && shown.agents.length === 0 && (
        <p className="state-empty">
          No agents are configured. Add one under [agents] in .harnessd/config.toml.
        </p>
      )}
      {shown && shown.agents.length > 0 && (
        <div className="region-body" {...regionProps}>
          <table className="agents">
            <colgroup>
              <col className="c-agent" />
              <col />
              <col className="c-elapsed" />
              <col className="c-budget" />
              <col className="c-tokens" />
            </colgroup>
            <thead>
              <tr>
                <th scope="col">Agent</th>
                <th scope="col">Task</th>
                <th scope="col" className="num">
                  Elapsed
                </th>
                <th scope="col">Budget used</th>
                <th scope="col" className="num">
                  Tokens
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.agents.map((agent) => (
                <AgentRows key={agent.name} agent={agent} now={now} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
