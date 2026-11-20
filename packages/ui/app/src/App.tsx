import { useEffect, useState } from "react";
import { Agents } from "./Agents.tsx";
import { useHarnessd } from "./api.ts";
import { Board } from "./Board.tsx";
import { LogPane } from "./LogPane.tsx";
import { needsYou } from "./lib/board.ts";
import { TopBar } from "./TopBar.tsx";

/** One clock for every elapsed time on the page, so they tick together. */
function useNow(ms = 1000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export function App() {
  const api = useHarnessd();
  const now = useNow();
  const waiting = api.board.status === "ready" ? api.board.data.issues.filter(needsYou).length : 0;
  const lastPollAt = api.agents.status === "ready" ? api.agents.data.lastPollAt : undefined;

  useEffect(() => {
    document.title = waiting > 0 ? `(${waiting}) harnessd` : "harnessd";
  }, [waiting]);

  return (
    <div className="app">
      <TopBar
        pause={api.pause}
        setPause={api.setPause}
        connection={api.connection}
        lastPollAt={lastPollAt}
        needsYou={waiting}
        now={now}
      />
      <main className="main">
        <Board board={api.board} retry={api.retry.board} now={now} />
        <div className="lower">
          <Agents agents={api.agents} retry={api.retry.agents} now={now} />
          <LogPane logs={api.logs} retry={api.retry.logs} />
        </div>
      </main>
    </div>
  );
}
