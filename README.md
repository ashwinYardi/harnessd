# harnessd

One daemon for every coding-agent harness.

harnessd runs a coordinator and a team of persistent agents (Backend, Frontend, QA) on top of the harness CLIs you already use: Claude Code, Codex, Antigravity, OpenCode, Cursor and Grok. The agents pull Ready issues from Linear, work in isolated git worktrees, and auto-merge PRs that pass CI and QA. They ask you only when a call is worth your time.

> Status: pre-alpha. Spec in [docs/SPEC.md](docs/SPEC.md), decisions in [docs/decisions](docs/decisions).

## Why
- **One config.** One `~/.harnessd` drives every harness. Native files are generated from it, and `CLAUDE.md` is a symlink to `AGENTS.md`.
- **Autopilot.** It ships non-stop within budgets and a merge gate.
- **CLIs, not SDKs.** You keep your own subscriptions and auth.

## Install
On a Mac, one line installs Node 24 if needed, then runs `harnessd init`:
```sh
curl -fsSL https://raw.githubusercontent.com/ashwinYardi/harnessd/main/scripts/install.sh | sh
```
With Node 24 already installed:
```sh
npx @harnessd/cli init
```
`init` finds or installs the Claude Code and Codex CLIs, writes `~/.harnessd/config.toml` if it is absent, and loads the launchd service `dev.harnessd.daemon`. It asks before installing anything; `--yes` skips the question (`curl ... | sh -s -- --yes`). Re-running is safe. Flags, paths and uninstall: [docs/INSTALL.md](docs/INSTALL.md).

## Develop
```sh
pnpm i && pnpm build && pnpm test
```
See [CONTRIBUTING.md](CONTRIBUTING.md).

## License
MIT
