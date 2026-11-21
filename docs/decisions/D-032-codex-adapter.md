# D-032 Agent runs on Codex use `codex exec --json`
Status: accepted 2026-11-21. Issue: MET-69. Extends D-031; it does not contradict it.

**Transport: `codex exec --json`, not `app-server`.**
- `codex exec --json` runs one process per task. It writes JSONL events on stdout, then exits.
- This fits `HarnessAdapter.start`, the EventLog and the process-group kill, as Claude Code runs do.
- `codex app-server` is a long-lived JSON-RPC server. It needs session and thread management. We reject it for v0.1.

**The argv.**
```
codex exec --json --ignore-user-config --ignore-rules --dangerously-bypass-hook-trust
  --sandbox workspace-write --add-dir <git common dir>
  -c approval_policy="never" -c sandbox_workspace_write.network_access=true
  [--model <m>] -- <prompt>
```
- `--json` gives the event stream that the adapter maps to `AdapterEvent`s.
- `--sandbox workspace-write` lets the agent edit the worktree and run tests.
- `--add-dir <git common dir>` makes the main repo's `.git` writable. A worktree keeps its index and refs there, so `git commit` needs it.
- `sandbox_workspace_write.network_access=true` turns on the network. `git push` and `gh pr create` need it.
- `approval_policy="never"` makes sure no command waits for a human.
- `--model` is set only when the agent config sets `model`.
- `--` ends the flags, so a prompt that starts with `-` is not read as a flag.
- We reject `--sandbox danger-full-access` and `--dangerously-bypass-approvals-and-sandbox`. They remove the sandbox, and the run does not need that.

**Hook trust.**
- `--dangerously-bypass-hook-trust` keeps the D-028 Impeccable hook running in a fresh worktree. Without it, Codex waits for a human to approve the hook in `/hooks`.
- `.codex/` is gitignored. So only hooks that the sync just wrote from the pinned pack are present.
- Claude Code runs project hooks with no trust step. So the risk is the same as for Claude runs.

**Isolation (D-031).**
- `--ignore-user-config` and `--ignore-rules` are the D-031 flags for Codex. The owner's user config and rules do not load.
- Sign-in still works.
- We reject `--trust`. It writes to the owner's user config.

**The gap.**
- Codex has no flag that skips `$CODEX_HOME/AGENTS.md` or the user-level skills.
- `CODEX_HOME` stays as it is, because `auth.json` lives there.
- So a Codex run can still see the owner's `$CODEX_HOME/AGENTS.md` and user skills. A follow-up issue tracks this.

**Usage.**
- Input tokens exclude cached tokens. Cached tokens are reported apart.
- Codex reports no cost, so the run has no cost.

**Run result.**
- `RunResult` gets an additive, in-memory `reason` field: `'usage_limit'` or `'auth'`.
- A run that ends on a usage limit or an auth error sets it. The loop then shows a clear status, not a generic failure.
- `RunStatus` does not change.

**Version.**
- The minimum tested version is Codex 0.171.0.
- Below it, `harnessd doctor` gives `warn` on `harness.codex.version`.

Why:
- The owner can put agents on Codex and save Claude quota.
- One process per task keeps the adapter the same shape as the Claude Code adapter.
- The run must not stop for an approval, and must not depend on one person's private setup.
