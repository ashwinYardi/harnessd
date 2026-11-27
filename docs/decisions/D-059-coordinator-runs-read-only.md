# D-059 Coordinator runs are read-only on every harness

Status: accepted 2026-11-27. Issue: MET-220 (parent MET-164). Amends D-031, D-032 and D-036. Extends D-014, D-039 and D-046.

Every coordinator-role run — grill, plan and any later coordinator step — is a read-only run. The coordinator plans and decides. It never edits code, commits, pushes or opens a PR.

The loop was not the path that pushed the two coordinator fix-ups on PR #79. Those commits came from an interactive coordinator session with full edit and git tools. The loop had the same gap: grill and plan used the builder's adapter flags over the owner's checkout, and only the prompt said "do not edit". This record closes both paths: harness tool limits for loop runs, and one instruction rule for interactive sessions.

## The flag

`Task.readOnly: true` marks a coordinator task. Grill, plan and any later coordinator step build their task through `coordinatorTask` in `packages/daemon/src/coordinator/grill.ts`, so the flag is set in one place. Builder and QA tasks leave it unset and keep full access.

Every harness maps the flag to its own limits, as part 1 (MET-219) built:

| Harness | A read-only run |
|---|---|
| Claude Code | Gets `--tools Read,Grep,Glob` and `--disallowedTools Edit,Write,NotebookEdit,Bash,mcp__harnessd-memory__write_note`. It gets no `--permission-mode auto` and no `--dangerously-skip-permissions`; `auto` would approve writes the tool limits deny. The D-031 isolation flags stay. |
| Codex | Gets `--sandbox read-only` in place of `danger-full-access`, or `-c sandbox_mode="read-only"` on a resume. `approval_policy="never"`, `--ignore-user-config`, `--ignore-rules` and `--dangerously-bypass-hook-trust` stay. A read-only run needs no keychain and no git write, so the seatbelt sandbox is enough. |
| OpenCode | Gets an inline `OPENCODE_CONFIG_CONTENT` that denies `edit`, `bash`, `webfetch`, `websearch`, `task`, `external_directory` and `question`. `--auto` approves only pending requests and cannot override a deny. |

**OpenCode check (part 1, MET-219).** Checked on OpenCode 2.3.2: the inline document is applied after the project `opencode.json`, so its denies win. `--standalone` and the temp `OPENCODE_CONFIG_DIR` stay, so the owner's config still does not load (D-036).

## Failures go to the builder

A failed QA or review round never starts a coordinator run. `settleQa` and the merge gate set `qaFeedback`, and the next dispatch runs the part's own builder, resumed when the harness can (D-046). The coordinator writes no fix.

At `limits.qa_max_failures` (default 2), QA and the parent go to Needs input. One comment and one notice go out, no builder or coordinator run starts for that part, and the saved cases are cleared (D-014, D-056). The coordinator does not patch the PR itself.

## Interactive sessions

A harness flag cannot reach an interactive coordinator session, because the loop did not start it. `.harnessd/AGENTS.md` carries the instruction rule instead: the coordinator plans and decides, never edits code, commits or pushes, and sends a failure back to the part's builder. `harnessd sync` merges that rule into the generated `AGENTS.md` and `CLAUDE.md`. Changes to the owner's `~/.claude` settings stay out of scope (D-031).

## What changes

- D-031: every Claude Code run keeps its isolation flags, but a coordinator run now also gets the read-only tool limits and no approval flags.
- D-032: a Codex coordinator run uses `--sandbox read-only`; a builder or QA run keeps `danger-full-access`.
- D-036: an OpenCode coordinator run passes the inline deny config; a builder or QA run keeps today's `--auto` allow table.

Why: on 2026-11-23, MET-121 failed QA twice. Both failures came from the coordinator's own fix-ups, not the builder's code. The coordinator runs on the top Claude model, so each fix spent the most expensive quota and needed another QA round. A prompt rule did not stop it; the harness limits do. The trade-off: the coordinator can no longer make a small fix itself, so each fix costs a send-back round. The builder's resumed session is the cheap path (D-046).

Issue: MET-220.
