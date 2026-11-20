# Vendored skills

These skills are copied into the repo, so every agent gets them: local sessions, cloud sessions and harnessd's own agents. Do not edit them here. To update one, copy the new version from upstream, change the commit below, and open a PR.

| Skills | Upstream | Commit | Licence |
|---|---|---|---|
| code-review, codebase-design, diagnosing-bugs, domain-modeling, grill-with-docs, grilling, implement, improve-codebase-architecture, prototype, research, tdd, to-spec, to-tickets | [mattpocock/skills](https://github.com/mattpocock/skills) | `abeeaf95660ba9e8b7c753eb38f441ca707a8823` | MIT (`LICENSE-mattpocock-skills`) |
| impeccable 4.10.0 | [pbakaus/impeccable](https://github.com/pbakaus/impeccable) | `b49177d32788f2dc585c42831d845dacf1ebed2c` | Apache 2.0 (`impeccable/LICENSE`, `impeccable/NOTICE.md`) |

Not vendored: `setup-matt-pocock-skills` (its output is `docs/agents/`, written by hand), and `triage`, `wayfinder`, `implement-spec`, `ask-matt`, `retro` (not part of this workflow).

`impeccable/scripts/impeccable` downloads its engine binary on first run and checks it against `impeccable/scripts/engine-checksums.txt`. If the download is blocked, the skill falls back to reading PRODUCT.md and DESIGN.md directly.

This is the setup for building harnessd itself. MET-21 adds the same pack to `harnessd init` for every user.

## Impeccable agents and hook
`npx impeccable@4.10.0 install --providers=claude,codex --scope=project` added these. They are Apache 2.0, from the same commit as the skill.
- `.claude/agents/impeccable-*.md`: the finish reviewer, motion reviewer, documenter, asset producer and manual-edit applier.
- `.claude/settings.json`: the design hook. It runs the detector after each Edit or Write on a UI file, and a deep pass on Stop. `harnessd sync` also writes this file. Since MET-30, sync merges into it and keeps these hooks (D-026). The pack ships the same hook and agents in `impeccable/.harnessd-native/` (packages/cli/src/pack.ts). A test checks that they match the files here.
