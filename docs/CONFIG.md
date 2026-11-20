# Config reference

harnessd reads two folders with the same shape (D-004): `~/.harnessd/` (global, or `$HARNESSD_HOME` when set) and `<repo>/.harnessd/` (workspace). Either may be missing. Types and the validator live in `packages/shared/src/config.ts`; loading and merging in `packages/daemon/src/config/`.

```
.harnessd/
  config.toml           settings, all optional
  AGENTS.md             instructions for every agent
  rules/<name>.md       one rule per file; the name is the file name
  skills/<folder>/SKILL.md
  agents/<name>.md      one agent per file
  vault/                memory notes, served over MCP (docs/MEMORY.md)
```

## config.toml
```toml
[limits]
max_concurrent = 3
budget_minutes = { S = 30, M = 120 }   # L has no budget: split it (D-014)
qa_max_failures = 2

[linear]
team_id = "MET"
project = "harnessd"

[slack]
channel = "#harnessd"

[daemon]
port = 4747                 # the local API on 127.0.0.1 (docs/API.md); 0 picks a free port

[merge]                     # the merge gate (D-013, docs/LOOP.md "Merge")
protected_paths = ["**/auth/**"]   # replaces the default list below
label = "needs-human"       # put on a PR that waits for a human
method = "squash"           # squash | merge | rebase

[qa]
# Run in a fresh worktree at the PR head before the QA agent starts (docs/LOOP.md "QA").
setup_command = "pnpm install --frozen-lockfile --prefer-offline"   # "" skips it
test_command = "pnpm test"   # a failure means changes requested, whatever the agent says

[agents.backend]
role = "backend"            # coordinator | backend | frontend | qa
harness = "claude-code"     # claude-code | codex | antigravity | opencode | cursor | grok
model = "opus"              # optional, passed to the harness
avatar = "avatars/backend.png"  # optional: path in this .harnessd/ folder, or a URL
instructions = "..."        # optional

[mcp.docs]                  # a stdio MCP server for every harness (see docs/SYNC.md)
command = "npx"             # required
args = ["-y", "docs-mcp"]   # optional
env = { DOCS_MODE = "ro" }  # optional, string values
```
`merge.protected_paths` globs are matched against each changed file's repo path, ignoring case. `**` spans directories, `*` and `?` stay within one, `{a,b}` is either, and a glob without a `/` matches the file name at any depth. A PR that touches one is never merged by harnessd. The default list:

| Area | Globs |
|---|---|
| auth | `**/auth/**`, `**/auth.*` |
| payments | `**/payments/**`, `**/billing/**` |
| secrets | `**/secrets/**`, `**/*secret*`, `**/.env`, `**/.env.*`, `**/*.pem`, `**/*.key` |
| release config, and the CI the gate trusts | `.github/workflows/**`, `docs/RELEASING.md`, `**/.releaserc*`, `**/release.config.*` |
| merge-gate config | `.harnessd/config.toml` (holds `[merge]`), `**/CODEOWNERS`, `.github/settings.yml`, `.github/rulesets/**` |

Setting `protected_paths` replaces the whole list, so copy the defaults you want to keep.

Default agents: coordinator, backend, frontend and qa, all on `claude-code` (D-010). The agent's name is its table key or file name; without an `avatar` the UI shows the name's initial. Any other agent name must set `role`. MCP server names use letters, digits, `_` and `-`. Unknown keys are errors.

## agents/<name>.md
Optional frontmatter with `role`, `harness`, `model` and `avatar`; the body is the agent's instructions.
```markdown
---
harness: codex
model: gpt-5
---
You own the API layer.
```
An agent may be defined in both config.toml and `agents/<name>.md` of the same folder, but each field (and the instructions) only once per folder.

## skills/<folder>/SKILL.md
Optional frontmatter with `name` (defaults to the folder name) and `description`. Other frontmatter keys are ignored. The frontmatter is flat `key: value` lines; indented lines continue the previous value.

## Merge rules
Order: defaults, then global, then workspace, then the agent.
- Scalars override. Arrays (such as `protected_paths`) replace. Tables deep-merge.
- Agent fields (`role`, `harness`, `model`, `avatar`) override per layer.
- Rules, skills and MCP servers merge by name; the workspace wins. An `[mcp.<name>]` table is replaced whole, not deep-merged.
- An agent's instruction text is global AGENTS.md, workspace AGENTS.md, then the agent's own instructions from global and then workspace, joined by blank lines.

Errors name the file and the key: `~/.harnessd/config.toml: agents.backend.harness: expected one of claude-code, codex, antigravity, opencode, cursor, grok, got "vim"`.
