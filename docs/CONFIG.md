# Config reference

harnessd reads two folders with the same shape (D-004): `~/.harnessd/` (global, or `$HARNESSD_HOME` when set) and `<repo>/.harnessd/` (workspace). Either may be missing. Types and the validator live in `packages/shared/src/config.ts`; loading and merging in `packages/daemon/src/config/`.

```
.harnessd/
  config.toml           settings, all optional
  AGENTS.md             instructions for every agent
  rules/<name>.md       one rule per file; the name is the file name
  skills/<folder>/SKILL.md  plus any other files the skill uses
  agents/<name>.md      one agent per file
  vault/                memory notes, served over MCP (docs/MEMORY.md)
```

## config.toml
```toml
[limits]
max_concurrent = 1
budget_minutes = { S = 30, M = 120 }   # L has no budget: split it (D-014)
token_budget = { S = 3000000, M = 6000000 }   # weighted; an unknown size counts as M (D-043)
cached_token_weight = 0.1   # a cached token counts this much of a new input token (D-043)
qa_max_failures = 2

[linear]
team_id = "MET"
project = "harnessd"

[slack]                     # Slack #harnessd (D-015, D-021, docs/INSTALL.md "Slack")
channel = "#harnessd"       # a label only: the webhook fixes the channel
summary_time = "21:00"      # the daily summary, 24-hour "HH:MM"
time_zone = "Asia/Kolkata"  # an IANA time zone

[daemon]
port = 4747                 # the local API on 127.0.0.1 (docs/API.md); 0 picks a free port
self_update = true          # rebuild and restart after a merge into harnessd's own repo (docs/LOOP.md "Self-update")

[harnesses.claude-code]     # Settings → Harnesses writes this in ~/.harnessd/config.toml
bin = "/opt/homebrew/bin/claude"   # absolute path; wins over HARNESSD_CLAUDE_BIN and PATH

[harnesses.codex]
bin = "/opt/homebrew/bin/codex"    # absolute path; wins over HARNESSD_CODEX_BIN and PATH

[secrets.linear]            # ~/.harnessd/config.toml only; a reference, never a value (D-030)
api_key = "op://Private/Linear/credential"   # or "env:MY_LINEAR_KEY"

[secrets.slack]
webhook_url = "env:MY_SLACK_HOOK"

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

[skills.tdd]                # one table per skill; see "Skills" below
upstream = "mattpocock/skills"    # written by harnessd init for each default skill
commit = "abeeaf95660ba9e8b7c753eb38f441ca707a8823"
enabled = false             # optional: drop the skill from this layer on

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

## Limits and token spend
`limits.max_concurrent` defaults to **1** (D-040). A user may set 1 to 3 (D-014 cap). Parallel parts of one parent touched the same files, and each merge sent the next PR back for another build and QA round. With 1, a ticket's parts run one after another: one part, one PR, one QA pass at a time.

`limits.token_budget` is the **weighted** tokens one parent may spend across its grill, plan, part and QA runs, keyed by size like `budget_minutes`: `S = 3000000`, `M = 6000000`. An unknown size counts as M, and so does L, which never runs.

The weighted sum is `input + output + round(cached × limits.cached_token_weight)`. `cached` is cache read plus cache write; the weight applies to both together. `cached_token_weight` is a number from 0 to 1, default `0.1`, and merges per layer like the other `limits` keys. At `1` the budget is the old raw count. Before a part run, QA run or rework round starts, the loop compares the parent's weighted sum with the budget. At or over it the loop starts nothing, moves the parent to Needs input, posts one comment with the weighted total, the budget and the raw input, cached and output parts, and sends one notice (D-011). A run in flight finishes. When a human moves the parent back to Ready, the count starts again from the escalation point.

`loop.json` keeps the raw sums under `usage` (input, cached and output), so a restart does not lose them, an old file still loads, and the board's token count stays the raw sum. Only the budget comparison and the Needs-input comment use the weight.

**Why weighted tokens, not cost per harness (D-043).** Codex reports no cost (D-032), and OpenCode reports cost only for some providers (D-036). A price table would go stale, and a missing cost would make the budget unlimited. A weight applies to every harness and needs no pricing data. Cached input is billed far below new input, so counting it in full made one 13-minute MET-128 build look like 12.5M tokens and trip the old M default before QA. At `0.1` that build is 1,470,055 weighted tokens. The weight treats cache writes as cheap too; that error is small where it matters because Codex reports `cacheWrite` 0, and OpenCode's providers mostly report 0 or a write at or below input. Claude Code reports the most cache writes.

**The defaults fit one M ticket (D-043).** Two MET-128-sized builds (2 × 1,470,055), one QA round (335,000 weighted) and 540,000 raw grill and plan tokens total 3,815,110 of 6,000,000. S is half of M.

### Which model for QA, and which for builders
- **QA:** a fast, low-cost model at medium effort. QA reads one PR diff against a checklist, and harnessd runs the tests itself, so it needs little reasoning. Example: an OpenCode flash model.
- **Builders:** a capable model, because a builder run is a long agent loop and tool turns resend the context. Use a top model only for an M part or after a QA failure. Examples: a top Codex or Claude model as the fallback.
- Set these per agent in `[agents.<name>]` with `harness` and `model`; docs/CONFIG.md "OpenCode agents" and "Codex agents" show the ids. A hold on the main harness uses `fallback_harness` and `fallback_model`.

## Secrets
The Linear key and the Slack webhook url are secrets (D-030). Settings, Connections saves them; docs/INSTALL.md "Secrets" has the steps.

| Id | Reference key | Fallback variable |
|---|---|---|
| `linear.api_key` | `[secrets.linear] api_key` | `LINEAR_API_KEY` |
| `slack.webhook_url` | `[secrets.slack] webhook_url` | `HARNESSD_SLACK_WEBHOOK_URL` |

**Lookup order**, for each secret:
1. A saved value in `~/.harnessd/secrets/<id>` (folder `0700`, file `0600`).
2. Else a reference in `[secrets.<service>]` of `~/.harnessd/config.toml`.
3. Else the fallback variable.

A value and a reference are never both set: saving one removes the other.

**References.** `op://vault/item/field` (or `op://vault/item/section/field`) is read with `op read --no-newline <reference>`, with no shell, at use time. `env:NAME` reads the variable `NAME`; `NAME` is letters, digits and `_`. A reference that cannot be read is an error, not a fall-through to the next step: `linear.key` fails and names the reason.

**Rules.**
- `[secrets]` is allowed only in the global config.toml. In a workspace config.toml it is an error, so a repo cannot point your secrets elsewhere.
- A value in `[secrets]` that is not a reference is an error. The error never repeats the value.
- `webhook_url` under `[slack]` is still an unknown-key error.

**Fallback harness.** `fallback_harness` (a harness id) and `fallback_model` (a string) are optional. Default: no fallback (D-035).
- While a usage limit holds the agent's `harness` (docs/LOOP.md "Usage limits"), its runs use the fallback harness and model.
- The loop uses the fallback only when it has an adapter and no hold of its own. Otherwise the run waits in Ready.
- Without `fallback_model`, the fallback harness uses its own default model.
- A `fallback_harness` equal to `harness` is ignored.
```toml
[agents.backend]
harness = "claude-code"
model = "opus"
fallback_harness = "codex"   # while Claude Code is limited
fallback_model = "gpt-5"
```

Default agents: coordinator, backend, frontend and qa, all on `claude-code` (D-010). Settings → Team edits the `[agents.<name>]` tables of the workspace file and nothing else; comments and other tables stay (D-026). It can change a default agent but not remove it. The agent's name is its table key or file name; without an `avatar` the UI shows the name's initial. Any other agent name must set `role`. MCP server names use letters, digits, `_` and `-`. Unknown keys are errors.

## agents/<name>.md
Optional frontmatter with `role`, `harness`, `model`, `fallback_harness`, `fallback_model` and `avatar`; the body is the agent's instructions.
```markdown
---
harness: codex
model: gpt-5
---
You own the API layer.
```
An agent may be defined in both config.toml and `agents/<name>.md` of the same folder, but each field (and the instructions) only once per folder.

## Codex agents
Set `harness = "codex"` to run an agent on Codex (D-032).
```toml
[agents.backend]
harness = "codex"
model = "gpt-5"             # optional, passed as --model
```
- `model` is optional. Without it, Codex uses its built-in default model. The run ignores your Codex user config (D-032), so a model set there does not apply.
- harnessd finds the `codex` binary in this order:
  1. `[harnesses.codex] bin` in the config;
  2. else `$HARNESSD_CODEX_BIN`;
  3. else `codex` on PATH.
- docs/INSTALL.md "Codex" has the install and sign-in steps.

## OpenCode agents
Set `harness = "opencode"` to run an agent on OpenCode (D-036).
```toml
[agents.backend]
harness = "opencode"
model = "opencode-go/deepseek-v4.1-flash#high"   # optional, passed as -m
```
- `model` is `<provider>/<model>`, with an optional `#variant`. The variant sets the thinking level, such as `#high`. `opencode models` lists the models you can use.
- Without `model`, OpenCode uses its default model. The run ignores your OpenCode user config (D-036), so a model set there does not apply.
- harnessd finds the `opencode` binary in this order:
  1. `[harnesses.opencode] bin` in the config;
  2. else `$HARNESSD_OPENCODE_BIN`;
  3. else `opencode` on PATH.
- Sign in to each provider with `opencode auth login`. The minimum tested version is 2.0.20.

Set `[agents.<name>.opencode_permission]` to override the OpenCode permissions for one run agent.

```toml
[agents.backend.opencode_permission]
websearch = "deny"
bash = { "npm publish *" = "deny" }
```

Each tool takes `"allow"`, `"deny"`, or a table of patterns with those actions. Config rejects `"ask"`. Workspace values override global values. Pattern tables merge by pattern. Worktree sync merges the result over the defaults. A plain `harnessd sync` uses the defaults.

## skills/<folder>/SKILL.md
Optional frontmatter with `name` (defaults to the folder name) and `description`. Sync copies other frontmatter keys (such as `disable-model-invocation`) as they are. The frontmatter is flat `key: value` lines; indented lines continue the previous value. Sync copies every other file in the folder too.

## Skills
`harnessd init` installs the default skill pack (D-016) into `~/.harnessd/skills/`. The pack is part of the `@harnessd/cli` package, so init needs no network.

| Skills | Upstream | Licence |
|---|---|---|
| code-review, codebase-design, diagnosing-bugs, domain-modeling, grill-with-docs, grilling, implement, improve-codebase-architecture, prototype, research, tdd, to-spec, to-tickets | mattpocock/skills | MIT |
| impeccable | pbakaus/impeccable | Apache 2.0 |

The commits are in `.claude/skills/VENDORED.md`. Each folder is the whole upstream skill: SKILL.md, reference files, scripts and `agents/`. Each folder has its upstream licence as `LICENSE` (impeccable also has `NOTICE.md`). Each folder also has a `.harnessd-pack` marker with the upstream, the commit and the pack format. Sync does not copy the marker.

**Hooks and subagents.** impeccable also has a `.harnessd-native/` folder, from the same upstream commit (D-028):
- `hooks.json`: the design hook for Claude Code and Codex.
- `claude-agents/`: the five Impeccable subagents, such as `impeccable-finish-reviewer.md`.

They are part of the skill folder, so the pin covers them. Sync merges the hooks into `.claude/settings.json` and `.codex/hooks.json`, and writes the subagents to `.claude/agents/` (docs/SYNC.md "Hooks and subagents"). `enabled = false` turns off the skill, its hooks and its subagents. Your own skill can ship the same folder.

**Pins.** For each default skill without a `[skills.<name>]` table, init appends one to the global config.toml, with `upstream` and `commit`. init adds only new tables; it never changes your text. init installs or replaces a skill folder only when the pin names the commit that this harnessd ships. So a newer `@harnessd/cli` never changes a skill until you change its pin. One exception keeps the commit: when the marker names an older pack format, init copies the folder again at the same commit. This adds `.harnessd-native/` to an impeccable folder from before MET-30.
- If the pin is older than the shipped commit, init keeps the folder and prints the `commit` to set.
- To update, set `commit` to the printed value and run `harnessd init` again.
- init reads pins from the global file only.
- A table without `commit` (only `enabled = false`, say) gets no pin. init then installs nothing for that skill and prints the `commit` to add.

**Your own folders.** A folder in `~/.harnessd/skills/` without the marker is yours. init never changes it and gives it no pin.

**Turn a skill off.** Set `enabled = false` in `[skills.<name>]`. A later layer can set `enabled = true` again. Use the workspace file to turn off a default skill in one repo. A table for a skill that is not installed is not an error, because the global pack can differ between machines.

`[skills.<name>]` keys: `enabled` (true or false), `upstream`, `commit` and `version` (strings). Each key is optional.

## Merge rules
Order: defaults, then global, then workspace, then the agent.
- Scalars override. Arrays (such as `protected_paths`) replace. Tables deep-merge.
- Agent fields (`role`, `harness`, `model`, `fallback_harness`, `fallback_model`, `avatar`) override per layer.
- Rules, skills and MCP servers merge by name; the workspace wins. A skill with `enabled = false` in the last layer that sets `enabled` is dropped. An `[mcp.<name>]` table is replaced whole, not deep-merged.
- An agent's instruction text is global AGENTS.md, workspace AGENTS.md, then the agent's own instructions from global and then workspace, joined by blank lines.

Errors name the file and the key: `~/.harnessd/config.toml: agents.backend.harness: expected one of claude-code, codex, antigravity, opencode, cursor, grok, got "vim"`.
