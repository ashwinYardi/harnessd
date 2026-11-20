# D-020 The skill pack ships in the CLI; sync owns only what it generated
Status: draft 2026-11-20. Extends D-016.
- The build copies the default skill pack from `.claude/skills/` into `dist/pack/` of `@harnessd/cli`.
- `harnessd init` needs no network. The pin is the package version plus the commits in VENDORED.md.
- init writes a `[skills.<name>]` pin for each new skill. It changes a skill folder only when the pin names the shipped commit.
- A workspace turns a skill off with `enabled = false`.
- Sync copies the whole skill folder and keeps all frontmatter. It writes to `.claude/skills/` (Claude Code) and `.agents/skills/` (Codex).
- Sync never writes into a skill folder whose SKILL.md has no generated note.

Why:
- init works offline.
- An upgrade never changes agents without a config change.
- A repo with hand-vendored skills stays safe. This repo is one (MET-20).

Issue: MET-21.
