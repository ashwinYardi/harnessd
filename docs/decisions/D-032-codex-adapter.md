# D-032 Agent runs on Codex use `codex exec --json`
Status: accepted 2026-11-21. Issue: MET-69. Extends D-031; it does not contradict it. Amended by D-038: the daemon ships the run; agents get no git write and no GitHub login.

**Transport: `codex exec --json`, not `app-server`.**
- `codex exec --json` runs one process per task. It writes JSONL events on stdout, then exits.
- This fits `HarnessAdapter.start`, the EventLog and the process-group kill, as Claude Code runs do.
- `codex app-server` is a long-lived JSON-RPC server. It needs session and thread management. We reject it for v0.1.

**The argv.**
```
codex exec --json --ignore-user-config --ignore-rules --dangerously-bypass-hook-trust
  --sandbox danger-full-access -c approval_policy="never"
  [--model <m>] -- <prompt>
```
- `--json` gives the event stream that the adapter maps to `AdapterEvent`s.
- `--sandbox danger-full-access` runs commands with no OS sandbox, as Claude Code runs do (see the amendment below).
- `approval_policy="never"` makes sure no command waits for a human.
- `--model` is set only when the agent config sets `model`.
- `--` ends the flags, so a prompt that starts with `-` is not read as a flag.
- We reject `--dangerously-bypass-approvals-and-sandbox`. The two flags above say the same thing more exactly.

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

**Amendment 2026-11-21: full access, not `workspace-write`.**
- Every builder run in `workspace-write` wrote and tested its code, then could not commit or open a PR.
- The macOS seatbelt sandbox hides the keychain, so `gh` finds no login. It also keeps every `.git` folder read-only, even with `--add-dir`.
- `--approve-for-me` (automatic review) did not help. The agent never asks to leave the sandbox.
- No human is there to approve an escape, so the sandbox can only fail. Claude Code runs have no OS sandbox either (D-031).
- T3 Code and OpenMausBot also run Codex with full access by default.
- Each agent still works in its own worktree (D-012). MET-109 moves commit, push and PR into the daemon, so agents need no git or GitHub access at all.
