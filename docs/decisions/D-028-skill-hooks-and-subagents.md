# D-028 Skills ship hooks and subagents; sync merges settings
Status: accepted 2026-11-20. Extends D-004, D-016 and D-020.

- A skill can have a native folder, `.harnessd-native/`. It holds `hooks.json` (Claude Code and Codex hooks) and `claude-agents/<name>.md` (Claude Code subagents).
- The pack build adds a native folder to impeccable. The hooks are what `npx impeccable@4.10.0 install` writes. The subagents are the five `impeccable-*.md` files from the same commit.
- The native folder is part of the skill folder, so the skill's pin covers it. `enabled = false` turns it off with the skill.
- Sync merges the hooks into `.claude/settings.json` and `.codex/hooks.json`. Sync owns `$schema`, `enabledMcpjsonServers` and its own hook groups. The user owns all else. A group with the same matcher and a shared command is replaced in place.
- Sync writes a subagent file only when the file is absent or has the generated note.
- The pack marker gets a `format`. init copies a folder again at the same commit when the format is older.
- Sync never deletes a hook or a subagent file.

Why:
- Without its hook, an agent can skip Impeccable. The hook is the part that makes it run.
- `.claude/settings.json` also holds the user's permissions and hooks. D-004 made it a generated file, so a full overwrite dropped them. A merge keeps D-004 for the keys sync owns.
- This repo commits the hook and the subagents by hand (MET-20). A merge and the generated note keep them safe when harnessd syncs its own repo.
- One mechanism, not an Impeccable special case. A user's own skill can ship hooks the same way.

Issue: MET-30.
