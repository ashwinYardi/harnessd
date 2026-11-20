# Product: harnessd

Read by the impeccable skill before any UI work. Source: docs/SPEC.md and docs/decisions/.

## What it is
A local daemon and desktop app that runs a team of coding agents (coordinator, Backend, Frontend, QA) on autopilot. The agents use the harness CLIs the user already pays for (Claude Code first). They pull Ready issues, work in isolated git worktrees, and auto-merge PRs that pass CI and QA.

## Who uses it
One developer, or a small team lead, who runs harnessd on their own Mac. They are technical. They check in a few times a day, and they want to know three things fast: what is running, what is blocked, and what needs them.

## Mode
**Operate.** This is a tool, not a marketing surface. Scanability, consistency and keyboard speed come before expression. The brand shows in precise details.

## The surfaces in v0.1
- The board: issues by state.
- The agent list: each agent's current task, elapsed time and budget used.
- A live log pane.
- A pause and resume control. It is the kill switch (D-014), so it must always be visible and must give feedback within 1 second.
- Settings pages. They make setup a few clicks:
  - **Harnesses:** one card per harness CLI. The card shows found or not found, version, binary path and signed-in state. It warns on a known-bad version and has Install and Update buttons.
  - **Connections:** one row per connection (GitHub, Linear, Slack). Each row shows a live check result from `harnessd doctor` and the fix for a failure.
  - **Team:** the agents. The user adds an agent, picks its role, and assigns it a harness and a model.

## Setup pattern
Follow the T3 Code (pingdotgg/t3code, MIT) Settings → Providers patterns for these pages. Copy the layout and behaviour, not its brand or copy. If code is reused, keep the MIT notice.

## Pinned aesthetic
- Dense, quiet, professional. References: t3.code and cloudroom.dev.
- No gradients, no emoji, no filler copy, no decorative illustration (AGENTS.md).
- Light and dark themes. Text contrast meets WCAG AA.

## UX rules
- Every view has loading, empty and error states.
- Every action works by keyboard, and focus is always visible.
- Live updates never move content under the cursor.
- Blocked and Needs input items are the loudest things on screen, because they are the only things that need the human.
