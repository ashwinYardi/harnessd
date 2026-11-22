# D-036 Agent runs on OpenCode use `opencode run --format json`
Status: draft 2026-11-21. Issue: MET-71 (part 1, MET-91). Follows D-032; it does not contradict D-031 or D-012.

**Transport: `opencode run --format json`, not `opencode serve`.**
- `opencode run --format json` runs one process per task. It writes JSONL events on stdout, then exits.
- This fits `HarnessAdapter.start`, the EventLog and the process-group kill, as Claude Code and Codex runs do.
- `opencode serve` is a long-lived HTTP server. It needs session management and an event subscription. D-032 rejected `codex app-server` for the same reason. We reject `serve` for v0.1.

**The argv.**
```
opencode run --format json --standalone [-m <provider>/<model>[#variant]] -- <prompt>
```
- `--format json` gives the event stream that the adapter maps to `AdapterEvent`s.
- `--standalone` starts a private server for this run. Without it, the run attaches to the owner's background service, which has the owner's config and state.
- In a non-interactive run, OpenCode rejects pending permission requests, writes one warning to stderr, and tells the model to continue. Harnessd streams that warning to the run log. Keep `--auto` off so a pending request gets rejected.
- `-m` is set only when the agent config sets `model`. The `#variant` part (for example `#high`) sets the thinking level. OpenCode 2.x has no separate `--variant` flag; `-m` takes `provider/model#variant`.
- `--` ends the flags, so a prompt that starts with `-` is not read as a flag.
- The run never passes `--continue`, `--session` or `--fork`. Each task is a new session.

**No sandbox.**
- OpenCode runs without an OS sandbox, as do Claude Code (D-031) and Codex (D-032 amendment).
- Each agent still works in its own worktree (D-012).

## Permissions and input requests (MET-118)

MET-119 amends the OpenCode sync ownership in D-037. Sync also owns `permission` and `websearch` in `opencode.json`. Sync writes `websearch = { "provider": "random" }` to avoid the provider consent form. We checked this setting on OpenCode 2.3.2.

| Tool or permission | Default |
| --- | --- |
| `*` (fallback, before the specific rules) | Deny |
| `read`, `edit`, `glob`, `grep`, `list`, `lsp`, `skill`, `task`, `todowrite`, `webfetch`, `websearch` | Allow |
| `harnessd_memory_*` | Allow |
| `bash` | Allow `*`. Deny `git push` and `git push *`. |
| `external_directory`, `question`, `doom_loop` | Deny |

Owner sync writes the defaults. Worktree sync merges `[agents.<name>.opencode_permission]` over them. Each action is `allow` or `deny`. A move to the OpenCode 2.3.x `permissions` ruleset is a follow-up.

OpenCode handles permission requests and forms inside the CLI. The JSON stream carries the result of a tool call, and stderr carries the permission rejection warning. OpenCode cancels unsupported input forms, emits a JSON error with the form title, and exits 1 after the session goes idle. The adapter logs the cancellation in one line. It accepts exit 1 when a step started and the cancellation was the only error. A later failure still determines the result.

Bash can reach paths outside the worktree. OpenCode runs without an OS sandbox, as do Claude Code and Codex.

**Isolation (D-031).**
- `OPENCODE_CONFIG_DIR` points to a new, empty temp folder per run. With `--standalone`, it replaces `~/.config/opencode` as the global config folder. So the owner's `opencode.json`, agents, MCP servers and global `AGENTS.md` do not load. The adapter deletes the folder when the run ends.
- `OPENCODE_DISABLE_CLAUDE_CODE=1` is set. OpenCode 1.x reads it to skip `~/.claude` files. 2.0.20 ignores it.
- `OPENCODE_DISABLE_AUTOUPDATE=1` is set, so a run never updates the CLI.
- `PWD` is set to the worktree. OpenCode takes its project folder from `PWD` before the process cwd, so an inherited `PWD` would point the run at the daemon's folder.
- `XDG_CONFIG_HOME` and `XDG_DATA_HOME` do not change. Auth lives in the data folder, and git and gh read `XDG_CONFIG_HOME`.
- Checked on 2.0.20 with `--print-logs`: with the switch, the run watches `AGENTS.md` in the temp folder, not in `~/.config/opencode`. `opencode debug config` does not show this, because it reads the background service.

**The gap.**
- OpenCode 2.0.20 still loads skills from `~/.claude/skills` and `~/.agents/skills`. It has no switch that skips them. A follow-up issue tracks this.
- Impeccable hooks (D-028) do not run under OpenCode. OpenCode uses JS plugins, not `hooks.json`. A follow-up issue tracks an OpenCode plugin for skill hooks.
- Sync writes OpenCode MCP entries, including `harnessd-memory` (D-037). The run reads `AGENTS.md` and the project skill folders.

**Events.**
- `text` gives a `text` event. The last text is `finalText`.
- `tool_use` gives a `tool` event with the tool name and a one-line summary of its input, once per call id. A failed tool call adds its error to the summary; the run goes on.
- `step_finish` gives a `usage` event with running totals.
- `sessionID` on any event gives `sessionId`.
- The first `error` that reports a failure wins. Cancelled input is a log event.
- Any other line, such as `reasoning`, goes to the log.
- OpenCode 2.0.20 exits before it prints the `step_finish` of the last step. So the run counts a step at `step_start`. A run needs at least one step, no failure, and an exit code that indicates success or a cancelled input request. The last step's tokens and cost are lost; the totals are low by that step.

**Usage and cost.**
- `tokens.input` already excludes cache reads, so the adapter takes it as it is. A real 2.0.20 run showed it: a step with 11968 cached tokens reported fewer input tokens than that. The brief said to subtract cache reads; that would count the input twice down to zero. `cacheRead` and `cacheWrite` come from `tokens.cache`. Output tokens include reasoning tokens.
- When a step reports `cost`, the adapter sums it into `costUsd` on each `usage` event and on `RunResult`. With no cost, `costUsd` stays unset. There is no price table.

**Failure reasons.**
- An `error` of type `provider.quota` or `provider.rate-limit` gives `usage_limit`, so the run ends `limited` (D-034). The reset time comes from `retryAfterMs`, or from "resets at" or "try again in" text in the message.
- An `error` of type `provider.auth` gives `auth`.
- Other errors, and stderr when the run fails, are sorted by text: quota, usage limit, 402, insufficient balance or a terminal 429 give `usage_limit`; 401, an invalid or missing API key, or not logged in give `auth`.
- OpenCode retries a 429 itself. A retry that the run gets past is only a stderr log line.

**Binary and model.**
- Lookup: `[harnesses.opencode] bin`, then `$HARNESSD_OPENCODE_BIN`, then `opencode` on PATH.
- A team row with `harness = "opencode"` takes a model `<provider>/<model>` with an optional `#variant`. No model means OpenCode's default.

**Version.**
- The minimum tested version is OpenCode 2.0.20. `success` and `text-only` are lines from real 2.0.20 runs, with ids and paths scrubbed. The other fixtures follow the 2.0.20 event shapes from the CLI source.

Why:
- OpenCode reaches DeepSeek, GLM and other open models. They cost far less than Claude for builder work.
- One process per task keeps the adapter the same shape as the Claude Code and Codex adapters.
- The run must not stop for an approval, and must not depend on one person's private setup.
