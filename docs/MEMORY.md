# Memory

Two Obsidian-compatible markdown vaults (D-005): `~/.harnessd/vault/` (global, or `$HARNESSD_HOME/vault/`) for what holds across repos, and `<repo>/.harnessd/vault/` (workspace) for the repo, committed with the rest of `.harnessd/`. A note is a `.md` file; folders are fine, the file name is the title, and YAML frontmatter is optional. Either folder can be opened in Obsidian as a vault. There is no index or database: search reads the files.

## MCP server
`harnessd mcp memory [--workspace <dir>]` serves both vaults over stdio (newline-delimited JSON-RPC 2.0, hand-rolled per D-002). `harnessd sync` registers it as `harnessd-memory` for Claude Code and Codex. Without `--workspace` it uses the nearest folder above the working directory that has a `.harnessd/`; with none, only `scope: "global"` works.

| Tool | Arguments | Does |
|---|---|---|
| `search_notes` | `query`, `scope`, `limit` (1-50, default 10) | Case-insensitive match on titles and text, ranked, with snippets |
| `read_note` | `path`, `scope` | Returns the note, frontmatter included |
| `write_note` | `path`, `content`, `frontmatter`, `scope` | Creates or overwrites `<path>.md` |

`scope` is `global` or `workspace` (default). Paths are relative to the vault, `.md` is optional, and paths with `..`, a leading `/`, a backslash, a hidden segment (`.obsidian/`) or a symlink out of the vault are rejected. Notes are capped at 1 MiB.

## Decision notes
When the coordinator settles a question itself (SPEC, autonomy loop step 2), it calls `writeDecisionNote(vault, { issue, title, question, decision, basis })` from `packages/daemon/src/memory/decisions.ts`. That writes `decisions/<ISSUE>-<slug>.md` with frontmatter `issue`, `question`, `decision` and `basis`, and the same three as sections in the body, so `search_notes` finds past calls.

## Glossary and draft decision records
The coordinator grill (docs/COORDINATOR.md) also writes two kinds of note to the workspace vault. Both are written once and never overwritten.

- `glossary/<slug>.md`: one new term, from `writeGlossaryTerm(vault, { issue, term, definition, avoid })` in `packages/daemon/src/memory/glossary.ts`. Frontmatter: `term`, `issue`, `avoid`.
- `decision-drafts/<ISSUE>-<slug>.md`: a draft decision record for a docs PR, from `writeDraftDecision(vault, { issue, title, decision, why })`. Frontmatter: `issue`, `status: draft`.
