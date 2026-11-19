# harnessd

One daemon for every coding-agent harness.

harnessd runs a coordinator and a team of persistent agents (Backend, Frontend, QA) on top of the harness CLIs you already use: Claude Code, Codex, Antigravity, OpenCode, Cursor and Grok. The agents pull Ready issues from Linear, work in isolated git worktrees, and auto-merge PRs that pass CI and QA. They ask you only when a call is worth your time.

> Status: pre-alpha. Spec in [docs/SPEC.md](docs/SPEC.md), decisions in [docs/decisions](docs/decisions).

## Why
- **One config.** One `~/.harnessd` drives every harness. Native files are generated from it, and `CLAUDE.md` is a symlink to `AGENTS.md`.
- **Autopilot.** It ships non-stop within budgets and a merge gate.
- **CLIs, not SDKs.** You keep your own subscriptions and auth.

## Install (planned)
```sh
npx @harnessd/cli            # or
curl -fsSL https://raw.githubusercontent.com/ashwinYardi/harnessd/main/install.sh | sh
```

## Develop
```sh
pnpm i && pnpm build && pnpm test
```
See [CONTRIBUTING.md](CONTRIBUTING.md).

## License
MIT
