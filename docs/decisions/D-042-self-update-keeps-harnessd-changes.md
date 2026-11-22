# D-042 A self-update keeps harnessd-written changes; a startup check retries a timeout

Status: accepted 2026-11-22. Issue: MET-137 (parent MET-132). Amends D-033 and refines D-026 for a timed-out start check. Updates docs/LOOP.md "Self-update" and docs/INSTALL.md.

`harnessd run` builds the updater when the start detection finds the install clone (MET-137). The default branch comes from the GitHub client. When that lookup fails it comes from `origin/HEAD`, then `main` when the remote sets no HEAD.

**What no longer blocks an update.**
- A self-update keeps the local changes harnessd writes: every path `harnessd sync` owns (`AGENTS.md`, `CLAUDE.md`, `.claude/settings.json`, `.claude/agents/`, the generated skills under `.claude/skills/` and `.agents/`, `.mcp.json`, `.codex/`, `opencode.json`), the workspace vault `.harnessd/vault/`, and `.harnessd/config.toml`.
- Any other tracked or untracked change in the install clone still blocks the update, and the reason names each file. So do a moved branch, a fetch that fails, a missing fast-forward and a Git operation in progress.
- The sync list comes from `SYNC_OUTPUT_PATHS` in the sync module. The updater does not keep a second copy.

**What the apply does with those changes.**
- It stashes the allowed tracked changes under the name `harnessd self-update <from7>`, fast-forwards, then pops the stash.
- It leaves the allowed untracked paths in place. A fast-forward that would add one of them is refused.
- After `pnpm install --frozen-lockfile` and `pnpm build` it runs `harnessd sync` with the new build, then restarts through launchd.
- A pop conflict resets the install clone to `from` and pops the stash there. The update ends `blocked` and names the conflicting paths. A stash is never dropped before a clean pop, and no change is ever discarded.
- A blocked check before a target exists logs `self-update: not updating: <reason>` once per reason. It does not pause the loop or send a notice. The D-033 pause, notice and Needs input apply only to a blocked or failed apply.

**Startup checks retry a timeout.**
- This refines D-026: a timeout is retried before the daemon goes to the setup state.
- A blocking check that failed by timeout at the start of `harnessd run` runs the whole status check again. There are up to 3 runs in total, each retry with `timeoutMs` 15 s and no fresh worktree-write check.
- A check that passes on a retry lets the loop start with no Start press. A pause in `paused.json` still holds.
- `harnessd run --once` uses the same rule. A blocker left after the retries exits 1 (D-023).
- `harnessd doctor`, `GET /api/status`, `GET /api/loop` and `POST /api/start` keep the 5 s limit.

Why:
- On 2026-11-22 harnessd merged PR #65 and PR #66 into its own repo and started no update. `harnessd run` never wired the updater, so the loop never checked. Once wired, the check would also have returned `blocked` on the local changes that `harnessd sync` and the workspace config had written, and the loop dropped that result without a line.
- A manual deploy keeps those files while it pulls, builds and syncs again. The updater must do the same, or harnessd's own output stops its own update.
- The second restart after those merges ran `harness.opencode.auth`, which timed out after 5 s. The loop went to setup and waited for Start, while the same check passed seconds later. One slow sign-in check must not cost the owner a button press.

Consequences:
- D-033 keeps the rest of its rules: never discard a change, never restart into a broken build, and pause with one notice on a blocked or failed apply.
- docs/LOOP.md "Self-update" describes the not-updating line, the kept changes and the stash, pop and sync steps.
- docs/INSTALL.md states which local changes may stay and that a startup check retries a timeout 3 times.
