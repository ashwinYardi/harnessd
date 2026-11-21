# D-033 harnessd updates itself at a safe point
Status: accepted 2026-11-21. Issue: MET-63 (loop part MET-66).

- When the repo the loop works on is harnessd's own install clone, a merge to its default branch starts a self-update. A merge by a human counts too. One check also runs at daemon start.
- While an update waits, a tick dispatches nothing and skips grills, splits and merges. Runs in flight finish normally.
- The safe point is the first tick with no run in flight. Only then does the update run: fast-forward, `pnpm install --frozen-lockfile`, `pnpm build`, launchd restart.
- A run that goes over its size budget (D-014) while an update waits is stopped like a paused run. Its worktree is kept, it goes back to Ready, and it counts no attempt. This adds a cause for a stop to D-014; it does not change the budgets.
- A blocked or failed update never restarts and never discards local changes. It keeps the old build, writes paused.json with the reason, and raises Needs input on the trigger issue. It sends one notice per target commit (D-015).
- `[daemon] self_update` defaults to true. `false` turns it off.

Why:
- The loop changes its own code. Without this, merged fixes do not apply until a human rebuilds.
- Waiting for an empty `inFlight` keeps every run on one build. Stopping only over-budget runs bounds the wait without losing work.
- A paused loop with the old build is safe. A restart into a broken build would stop the service.
