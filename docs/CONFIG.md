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
max_parents = 1   # parents in flight from grill to Done, Canceled or Needs input (D-050)
budget_minutes = { S = 30, M = 120 }   # L has no budget: split it (D-014)
token_budget = { S = 3000000, M = 6000000 }   # weighted; an unknown size counts as M (D-043)
cached_token_weight = 0.1   # a cached token counts this much of a new input token (D-043)
max_turns = { S = 80, M = 160 }   # builder run turn cap; QA (S 40, M 80) and coordinator 50 are in code (D-045, D-047)
qa_max_failures = 2   # QA, the gate and a failed review run (D-014); not a review round (D-062)
max_review_rounds = 6   # changes_requested reviews per part before the cap escalation (D-062)

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
# Optional: how QA runs the product. Unset means QA judges the tests and the diff only.
# kind, start, url, health, seed, build and env are described under "Live QA".

[agents.backend]
role = "backend"            # coordinator | backend | frontend | qa | reviewer
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

`limits.max_parents` defaults to **1** and caps the parents in flight (D-050). A parent is in flight from its grill until it is Done, Canceled or Needs input. It is a positive integer that merges per layer like the other `limits` keys, so a workspace layer overrides the global one. Zero, a negative number or a non-integer is a config error. It sits next to `max_concurrent` and does not replace it: `max_concurrent` still caps agent runs at the same time, and both limits hold.

`limits.max_review_rounds` defaults to **6** and caps `changes_requested` reviews of one part (D-062). It counts in `reviewFailures[part.id]`; at or over the cap the loop starts no coordinator run, posts one parent comment with the open findings, moves the part and the parent to Needs input, and sends one notice with the reason `review round cap reached`. It is a positive integer that merges per layer like the other `limits` keys, so a workspace layer overrides the global one. Zero, a negative number or a non-integer is a config error. It does not replace `qa_max_failures`: that key still caps QA, the merge gate and a review run that gives no verdict.

`limits.token_budget` is the **weighted** tokens one parent may spend across its grill, plan, part and QA runs, keyed by size like `budget_minutes`: `S = 3000000`, `M = 6000000`. An unknown size counts as M, and so does L, which never runs.

The weighted sum is `input + output + round(cached × limits.cached_token_weight)`. `cached` is cache read plus cache write; the weight applies to both together. `cached_token_weight` is a number from 0 to 1, default `0.1`, and merges per layer like the other `limits` keys. At `1` the budget is the old raw count. Before a part run, QA run or rework round starts, the loop compares the parent's weighted sum with the budget. At or over it the loop starts nothing, moves the parent to Needs input, posts one comment with the weighted total, the budget and the raw input, cached and output parts, and sends one notice (D-011). A run in flight finishes. When a human moves the parent back to Ready, the count starts again from the escalation point.

`loop.json` keeps the raw sums under `usage` (input, cached and output), so a restart does not lose them, an old file still loads, and the board's token count stays the raw sum. Only the budget comparison and the Needs-input comment use the weight.

**Why weighted tokens, not cost per harness (D-043).** Codex reports no cost (D-032), and OpenCode reports cost only for some providers (D-036). A price table would go stale, and a missing cost would make the budget unlimited. A weight applies to every harness and needs no pricing data. Cached input is billed far below new input, so counting it in full made one 13-minute MET-128 build look like 12.5M tokens and trip the old M default before QA. At `0.1` that build is 1,470,055 weighted tokens. The weight treats cache writes as cheap too; that error is small where it matters because Codex reports `cacheWrite` 0, and OpenCode's providers mostly report 0 or a write at or below input. Claude Code reports the most cache writes.

**The defaults fit one M ticket (D-043).** Two MET-128-sized builds (2 × 1,470,055), one QA round (335,000 weighted) and 540,000 raw grill and plan tokens total 3,815,110 of 6,000,000. S is half of M.

### Turn caps and tool output (D-045)
`limits.max_turns` is the model turns one **builder** part run may take, keyed by size like `budget_minutes`: `S = 80`, `M = 160`. A value is a positive integer per size, and an unknown size counts as M. It is optional and merges per layer like the other `limits` keys. Zero, a negative number, a non-integer or a size key other than S or M is a config error. The loop reads the part's size before it starts the run.

The other roles have caps in code, not in config: **QA S 40 and M 80** for the parent's size, and **coordinator grill and plan 50**. QA judges one PR against a checklist, and grill and plan write one reply. A QA cap of 40 for every size stopped the QA of a 17-file M PR twice with no verdict (D-047).

A run at its cap ends `error` with `turn cap (<n> turns)` and no failure reason. It is not shipped; it follows the normal error rule: one attempt is counted, the worktree is kept when it holds unshipped work, and the next attempt resumes the same branch (D-039). A turn-capped QA run counts as a QA failure, as an agent error does. A turn-capped grill or plan run is an error run; the plan retries once, and a second bad plan moves the parent to Needs input (D-049).

**The numbers come from MET-131 and D-043.**
- A MET-128 build averaged about **22.6k weighted tokens per turn** (1,470,055 weighted tokens over about 65 turns). 80 turns is about **1.8M** weighted tokens, under the S budget of 3M. 160 turns is about **3.6M**, under the M budget of 6M.
- A 65-turn MET-128 build fits S with room to spare. The 190-turn builds measured on 2026-11-22 are the runaway case that the cap stops.
- The wall-clock budget and the token budget still apply. The first limit that a run hits stops it. A time-budget stop stays `timeout`; a turn-cap stop is `error`.

**The tool-output cap per harness.** Each cap keeps one tool result near 5k tokens (20,000 bytes is about 5k tokens). One 50 KiB result is about 12.8k tokens, and every later turn sends it again. These values were checked on the versions named here:
- **Claude Code 2.1.329:** `BASH_MAX_OUTPUT_LENGTH=20000` in the child's environment, about 5k tokens of one Bash result. The default is 30,000 characters.
- **Codex 0.171.0 or later:** `-c tool_output_token_limit=5000` in the argv, with the other `-c` options and before `--`.
- **OpenCode 2.3.2:** the documented `tool_output` key. Builder worktree sync writes `tool_output.max_bytes = 20000`, about 20 KiB, and `max_lines = 2000`, the documented default. Owner sync, QA sync and coordinator sync leave `tool_output` alone. The schema documents `tool_output.max_lines` (default 2,000) and `max_bytes` (default 51,200, about 50 KiB).

**OpenCode compaction for builder runs (D-045).** Builder worktree sync writes `compaction` into `opencode.json` on OpenCode 2.3.2:
- `auto = true`;
- `keep.tokens = 20000`, above the documented default of 15,000, so the recent tail keeps more exact detail;
- `buffer = "50%"`. The docs define `buffer` as the share of the model's context window kept free, so on a 200k window compaction starts at about 100k tokens.

The 190k average turn is close to a 200k window, so the 100k target leaves room for a summary plus the 20k tail. Owner sync, QA sync and coordinator sync do not write `compaction`. Sync replaces `compaction` and `tool_output` as whole keys, as it does for `permission` (D-038).

A Codex `exec` prompt sends one `turn.completed`. The Codex adapter therefore counts each completed tool item as one turn (a command run, a file change, an MCP tool call or a web search), and uses that count in both the cap and the run log line. A `todo_list` item is not a turn.

### Which model for QA, and which for builders
- **QA:** a fast, low-cost model at medium effort. QA reads one PR diff against a checklist, and harnessd runs the tests itself, so it needs little reasoning. Example: an OpenCode flash model.
- **Builders:** a capable model, because a builder run is a long agent loop and tool turns resend the context. Use a top model only for an M part or after a QA failure. Examples: a top Codex or Claude model as the fallback.
- Set these per agent in `[agents.<name>]` with `harness` and `model`; docs/CONFIG.md "OpenCode agents" and "Codex agents" show the ids. A hold on the main harness uses `fallback_harness` and `fallback_model`.

## Live QA
Live QA is off by default. `qa.kind` turns it on: harnessd starts the product the PR builds, and QA checks each Done-when item against it (D-013, MET-169). With no `kind`, QA reads the diff, the CI result and the test output, as before. Any run key below set without `kind` is a config error, so a stray `start` never starts an app.

| Key | Type | Meaning |
|---|---|---|
| `kind` | `web`, `api` or `cli` | How QA runs the product. Required to turn live QA on. |
| `start` | command | Required. Starts the product. `{port}` is replaced with a free port for `web` and `api`. For `cli` it is the command QA calls; harnessd does not run it as a server. |
| `url` | string | Required for `web` and `api`; must contain `{port}`. Not allowed for `cli`. Where the product answers. |
| `health` | path or command | Required for `web` and `api`: a path resolved against `url` that must answer before QA starts. Optional for `cli`: one command run after `build` and `seed`. |
| `seed` | command | Optional. Runs once after `build` and before health checks. |
| `build` | command | Optional. Runs before `start`, e.g. to build the product. |
| `env` | array of names | Optional. Names of variables passed from the daemon's environment to the product's commands. Names only, never values; each matches `^[A-Z_][A-Z0-9_]*$`. |

Every kind requires `start`. `web` and `api` also require `url` and `health`. `cli` forbids `url`. Optional commands are non-empty strings when set.

harnessd reads this table from the **main checkout's** workspace layer, never from the PR head's `.harnessd/config.toml`. QA runs before the merge gate, so a PR must not be able to change the commands harnessd runs. The PR's code still builds and runs, through `setup_command`, `build`, `start` and `test_command`.

A web app:
```toml
[qa]
kind = "web"
setup_command = "pnpm install --frozen-lockfile"
test_command = "pnpm test"
build = "pnpm build"
seed = "pnpm db:seed"
start = "pnpm preview --port {port}"
url = "http://127.0.0.1:{port}"
health = "/"
env = ["DATABASE_URL"]
```

An API:
```toml
[qa]
kind = "api"
test_command = "go test ./..."
start = "go run ./cmd/server -addr 127.0.0.1:{port}"
url = "http://127.0.0.1:{port}"
health = "/healthz"
env = ["DATABASE_URL", "REDIS_URL"]
```

A CLI. It has no URL: QA calls `start` for each check, and `health` is one command that must exit 0 after the build.
```toml
[qa]
kind = "cli"
test_command = "pnpm test"
build = "pnpm build"
start = "node dist/cli.js"
health = "node dist/cli.js --version"
```

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

Default agents: coordinator, backend, frontend, qa and reviewer. The first four are on `claude-code` (D-010). The reviewer is on `codex` with `model = "gpt-6.2-sol"` (MET-222), so Claude quota stays with the coordinator. Settings → Team edits the `[agents.<name>]` tables of the workspace file and nothing else; comments and other tables stay (D-026). It can change a default agent but not remove it. The agent's name is its table key or file name; without an `avatar` the UI shows the name's initial. Any other agent name must set `role`. MCP server names use letters, digits, `_` and `-`. Unknown keys are errors.

**Reviewer.** The reviewer role reads a PR's code like a senior developer. Its default is Codex on `gpt-6.2-sol`. Each `[agents.<name>]` layer can override `harness`, `model`, `fallback_harness` and `fallback_model`, as for every role (D-035). The role's harness order is `codex`, then `claude-code` (D-048). `gpt-6.2-sol` goes only to Codex; another harness gets no `--model`.
```toml
[agents.reviewer]
harness = "codex"            # default; a layer may change it
model = "gpt-6.2-sol"        # default; a layer may change it
fallback_harness = "claude-code"   # optional
fallback_model = "opus"            # optional
```
A reviewer worktree keeps `code-review`, `codebase-design`, `tdd`, `diagnosing-bugs` and `domain-modeling` from the pack. It withholds `impeccable`, `grilling`, `research`, `prototype` and `grill-with-docs`. QA no longer keeps `code-review`; its worktree withholds it too (MET-222). The map is built in, not config: `enabled = false` still turns a skill off for everyone.

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
