# harnessd: spec v0.1

harnessd is a local daemon and desktop app that runs a team of coding agents on autopilot. Each agent uses a harness CLI (Claude Code, Codex, Antigravity, OpenCode, Cursor, Grok). Every harness reads one shared config.

## Goal of v0.1 (MVP)
A coordinator plus three persistent agents (Backend, Frontend, QA) take Ready issues from Linear and ship merged PRs non-stop, asking the human only when a decision is worth it.

## Principles
1. **Autopilot first.** The human is asked only for real inputs: secrets, money, irreversible or taste calls the spec doesn't settle.
2. **Harness CLIs only.** No vendor SDKs. Adapters call each CLI in headless/JSON mode, with a terminal pane as the fallback.
3. **One parent config.** Harness-native files are generated from it and never hand-edited.
4. **Linear is the source of truth** for work in v0.1. Well-formed issues are a hard requirement. From v0.2, any task tool or local markdown tasks work (D-018).
5. **Anti-slop UI.** The UI is dense, quiet, keyboard-first and professional. It shows real service logos and no decoration.

## Components
| Component | v0.1 |
|---|---|
| `harnessd` daemon | TypeScript (Node/Bun) local server: scheduler, adapters, worktrees, Linear/GitHub/Slack clients |
| UI | React + Vite, served by the daemon; Electron wrapper |
| CLI | `npx @harnessd/cli` → `harnessd` command |
| Installer | `curl -fsSL https://…/install.sh \| sh`: installs Node, harness CLIs, the daemon and launchd service |
| Memory | Obsidian-compatible markdown vaults (global + per workspace), exposed via a built-in MCP server. No DB in v1 |

## Config layout
```
~/.harnessd/              global: config.toml, skills/, rules/, agents/, AGENTS.md, vault/
<repo>/.harnessd/         workspace: same shape, overrides global
<repo>/AGENTS.md          generated; CLAUDE.md -> AGENTS.md (symlink)
```
Instruction layers merge in this order: global → workspace → agent (schema and merge rules: docs/CONFIG.md). Native files (`.claude/`, `.codex/`, `opencode.json`, `.cursor/rules`, …) are generated on `harnessd sync` (docs/SYNC.md).

## The team
- **Coordinator**: always on. Pulls Ready issues, grills the issue against the spec and decisions, and only escalates when needed (see D-011). Splits issues into backend/frontend sub-issues plus a QA sub-issue that depends on them. Assigns them, watches budgets, keeps the board honest.
- **Backend, Frontend, Reviewer, QA**: persistent agents with a name, avatar, role and their own instructions. The reviewer defaults to Codex with `gpt-6.2-sol`. The other agents default to Claude Code. Harnesses are swappable per agent (D-060).

## Autonomy loop
1. The coordinator takes the top Ready issue in Linear's manual order, with priority as tie-break.
2. It checks the issue for ambiguity. It resolves what it can from the spec, decisions, code and vault, and records the call as a comment and a decision note (contract: docs/COORDINATOR.md).
3. Escalation happens only when the "worth asking" test passes (D-011). Then the issue moves to **Needs input**, one Slack ping goes out, and the loop moves on to the next issue.
4. It plans the parts by the size rule: a ticket stays one part only when it is one area with about 3 acceptance criteria or fewer and about 5 files or fewer. A larger ticket splits, backend before frontend, each part with a fixed brief and its own Done when (D-049). Then it assigns and runs each part in its own git worktree and branch. Parts of a split issue run one after another; a part starts only after the one before it is merged (split, dispatch and state file: docs/LOOP.md).
5. A PR opens and CI runs. For each shipped part in **In Review**, the reviewer reads the diff and relevant code at the PR head in a read-only checkout and posts its verdict. QA then verifies behavior against the "Done when" checklist (D-060).
6. Auto-merge happens when the gate passes (D-013). Otherwise the PR is sent back once, then escalated.
7. Issue → Done, then a Slack line. Repeat.

## Merge gate (D-013, D-060)
A PR auto-merges when **all** of these hold: CI is green, the reviewer approves the current PR head, QA approves every "Done when" item at that head, and no protected path is touched. Protected paths are auth, payments, secrets, release config, and the merge-gate config itself. Protected PRs wait for the human.

## Limits (D-014, D-040, D-043, D-050)
- Per-task token and time budget by size: S 30 min, M 2 h, L must be split.
- Per-issue token budget by size: weighted tokens S 3M, M 6M (D-043). At or over it the loop stops and asks the coordinator (Needs input).
- One agent runs at a time by default (configurable up to 3).
- The Ready column is a queue: at most `limits.max_parents` parents are in flight (default 1, D-050), and a parent in Needs input keeps its slot (D-057).
- Two QA failures → escalate rather than loop.
- A global kill switch: `harnessd pause`, plus a UI button.

## Visibility
Slack **#harnessd**: one line per merge or block, and a 9 PM IST summary. It uses an incoming webhook saved in Settings, or from `HARNESSD_SLACK_WEBHOOK_URL` (D-021, D-030); the summary time and zone are configurable (D-021, docs/INSTALL.md "Slack"). The app shows the live board and per-agent activity. The canvas with personas and avatars comes in v0.2.

## Linear filing rules
- Title is the outcome ("Agents run in isolated worktrees"), not the task.
- The body has **Why**, **Done when** (a checklist), **Spec links**, **Size** (S/M/L; L gets split).
- One area label: `harness-adapter`, `ui`, `cloud`, `memory`, `coordinator`, `infra`.
- Only **Ready** issues get picked up. States: Backlog → Ready → In progress → In review → Done, plus Needs input.

## Out of scope for v0.1 (→ v0.2+)
Containers/sandboxes, cloud runtimes (VPS, Cloudroom, agent37, boat.dev, harness-native cloud), team canvas and avatars, Linux/Windows, signed .dmg ($99/yr Apple Developer), Composio connectors beyond Linear/GitHub/Slack, reasonmachines-style speed work.

## Platform
macOS first, then Linux, then Windows via WSL.

## Bootstrap
Developer bot builds v0.1 by hand. From the first working loop on, harnessd builds harnessd.
