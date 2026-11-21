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
  - **Harnesses:** one card per harness CLI. The card shows found or not found, version, binary path and signed-in state. It warns on a known-bad version and has Install, Update and Sign in buttons. During a sign-in it shows the login link and the device code to copy. When sign-in cannot finish in the app, it shows the one command to copy, with Recheck.
  - **Connections:** one row per connection (GitHub, Linear, Slack). Each row shows a live check result from `harnessd doctor` and the fix for a failure.
  - **Team:** the agents. The user adds an agent, picks its role, and assigns it a harness and a model.

## Setup pattern
Settings has a sub-nav and one card per harness or connection. Each card shows the service's logo and name, a state badge, what was found, the fix for a failure, and its actions. A card answers "does this work, and if not, what do I do" without a click.

## Pinned aesthetic
- Dense, quiet, keyboard-first, professional. Small type, tight rows and thin borders let one screen hold the whole team. Color is rare, so a red Needs you count stands out at once. Every action has a key. The UI looks like a well-made tool, not a product page.
- Real service logos (GitHub, Linear, Slack, Claude, OpenAI, git) next to their names, in one color, so the eye finds a service by its shape first.
- No gradients, no emoji, no filler copy, no decorative illustration (AGENTS.md).
- Light and dark themes. Text contrast meets WCAG AA.

## UX rules
- Every view has loading, empty and error states.
- Every action works by keyboard, and focus is always visible.
- Live updates apply in place. The row under the pointer or focus keeps its place, and its contents update. Only the log holds new lines while scrolled up, and offers Jump to latest.
- Blocked and Needs input items are the loudest things on screen, because they are the only things that need the human.
