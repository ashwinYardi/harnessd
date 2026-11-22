# Install

macOS first (D-007). On Linux everything but the service works.

```sh
curl -fsSL https://raw.githubusercontent.com/ashwinYardi/harnessd/main/scripts/install.sh | sh
curl -fsSL .../install.sh | sh -s -- --yes --workspace ~/code/app   # arguments go to init
npx @harnessd/cli init                                              # Node 24 already installed
```

Both are safe to re-run.

## scripts/install.sh
POSIX sh, `set -eu`. It prints each command before running it.
1. **Node.** It uses the `node` on PATH if it is version 24 or newer. Otherwise:
   - **With Homebrew:** `brew install node@24` and `brew link --overwrite --force node@24`.
   - **Without Homebrew, on macOS:** it downloads the `node-v24.*.pkg` listed in `https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt` and checks its SHA-256. Then it runs `sudo installer -pkg <file> -target /`, but only after you say yes, or with `--yes`. With neither, and no terminal to ask on, it stops without using sudo.
   - **Elsewhere:** it asks you to install Node 24 and re-run.
2. **init.** `npx -y @harnessd/cli@latest init "$@"`, with the terminal as its stdin, so `init` can still ask under `curl | sh`.

## harnessd init
```
harnessd init [--yes] [--no-service] [--workspace <dir>]
```

| Flag | Effect |
|---|---|
| `--yes`, `-y` | Install missing CLIs without asking |
| `--no-service` | Skip the launchd service |
| `--workspace <dir>` | The repo the service runs `harnessd run` in. Default: the current directory |

Steps:
1. **CLIs.** It looks for `harnessd`, `claude` and `codex` on PATH and prints each version and path. npx's temporary folders don't count. It prints the install command for each one missing:
   - `npm i -g @harnessd/cli` (the service needs a stable `harnessd`, not npx's cached copy);
   - `npm i -g @anthropic-ai/claude-code`;
   - `npm i -g @openai/codex`.

   It runs them only with `--yes` or after an interactive yes. With no terminal and no `--yes`, it installs nothing and says so. Login stays with each CLI: run `claude` and `codex` once yourself.
2. **Config.** It writes `~/.harnessd/config.toml` (`$HARNESSD_HOME/config.toml` when set), a commented template, only if the file is absent. An existing file is never touched ("kept existing"). It also creates `~/.harnessd/logs/`.
3. **Skills.** It installs the default skill pack into `~/.harnessd/skills/` and appends a `[skills.<name>]` pin for each new skill to config.toml. It keeps existing skills and pins. See docs/CONFIG.md "Skills".
4. **Service (macOS only).** It writes `~/Library/LaunchAgents/dev.harnessd.daemon.plist`, then runs `launchctl bootstrap gui/$UID <plist>`.
   - If the plist is unchanged and already loaded, nothing happens.
   - If the plist changed and the service is loaded, it runs `launchctl bootout gui/$UID/dev.harnessd.daemon` first.
   - On Linux, or with `--no-service`, it prints that the service is skipped.

The exit code is 0 when everything it tried worked, even if you declined an install; the last line lists what is not installed. It is 1 when an install, the skills step or `launchctl` failed, and 2 for a usage error.

## harnessd doctor
```
harnessd doctor [dir] [--json]
```
It checks the machine and the workspace at `dir` (default: the current directory), and prints one row per check: state, id, detail and fix. `--json` prints `{ "checks": [...] }`. `harnessd run` runs the same checks at start, and `GET /api/status` returns them (docs/API.md).

| State | Meaning | Blocks `harnessd run` |
|---|---|---|
| `ok` | It works. | no |
| `warn` | It works, but something is off. | no |
| `fail` | It is there but broken. | yes (the loop waits in setup; D-026) |
| `missing` | It is required and absent. A check that waits on a blocking one is `missing` too, with the detail "not checked". | yes (the loop waits in setup; D-026) |

The exit code is 1 when any check is `fail` or `missing`, 0 otherwise, and 2 for a usage error.

| Check | How | Not ok |
|---|---|---|
| `node` | the running Node, and on macOS the Node the launchd service runs when it differs | `fail` below 24. Fix: `nvm install 24 && nvm alias default 24`, or `brew install node@24`. The service Node below 24, missing or broken: `fail`. Fix: run the Install block with Node 24 active, then `harnessd init` |
| `config` | loads global and workspace config.toml | `fail` with the file and key |
| `harness.<id>.cli` | `[harnesses.<id>] bin` in the config, else `$HARNESSD_CLAUDE_BIN` or `claude`, `$HARNESSD_CODEX_BIN` or `codex`, `$HARNESSD_OPENCODE_BIN` or `opencode`, on PATH; then `--version` | `missing` when not found |
| `harness.<id>.auth` | `claude auth status --json`; `codex login status`; `opencode auth list --format json --standalone` (provider ids only) | `fail` when signed out, or for OpenCode when a provider an agent names is not signed in; `warn` when the status cannot be read, or no provider is named or signed in |
| `harness.<id>.version` | the version against a list of known-bad releases; for Codex and OpenCode, also against the minimum tested version (Codex 0.171.0, D-032; OpenCode 2.0.20) | `warn` |
| `harness.<id>.worktree_write` | a scratch folder in the repo's worktrees folder, the same place a builder makes `<root>/<repo>/<branch>`, with one file written and deleted with the harness's own sandbox: as the daemon user for Claude Code and OpenCode, and for Codex with `danger-full-access`; a sandboxed Codex writes through `codex sandbox` with the matching built-in permission profile | `missing` when the CLI is not installed; `fail` with the reason when the sandbox or the root cannot write, or when a file sits where the repo folder goes. Fix: make the root writable, remove that file, or set Codex `--sandbox danger-full-access` (D-032). A cached result lasts 10 minutes on `GET /api/status` and `GET /api/loop`; `doctor` and Start check afresh |
| `github.cli` | `$HARNESSD_GH_BIN` or `gh` on PATH | `missing` |
| `github.auth` | `gh auth status --active` | `fail`: run `gh auth login` |
| `github.push` | `gh repo view --json viewerPermission` | `fail` below WRITE, or with no GitHub remote |
| `github.ci` | the default branch's rulesets, and its classic protection when gh may read it | `warn` when no check is required |
| `linear.key` | one GraphQL read with the key from the secret lookup (below); the detail names the source: `saved`, `1Password` or `env` | `missing` when unset; `fail` when rejected, unreachable, or a reference cannot be read |
| `linear.team` | `linear.team_id`, as a key or a UUID | `missing` when unset; `fail` when unknown |
| `linear.states` | Ready, In Progress, In Review, Done and Needs input | `fail`, with the missing names |
| `slack.webhook` | the webhook from the secret lookup is set and is an https url; the detail names the source | `warn` only |
| `git.worktrees` | `git worktree list` in the workspace | `fail` outside a git clone |
| `daemon.port` | binds `127.0.0.1:<daemon.port>` | `warn` when a running harnessd holds it; `fail` when anything else does |
| `skills.pack` | each default skill in `~/.harnessd/skills/` | `warn`: run `harnessd init` |

Harnesses are checked once for each harness an agent uses as its `harness` or `fallback_harness`. Checks run in parallel. No command runs past 5 s, so `doctor` returns within a few seconds. No check spends tokens. Sign-in checks read only the exit code and named JSON fields, never the account or the token. Output never shows a key, a token or a webhook: each value of 6 characters or more of an environment variable with KEY, TOKEN, SECRET, PASSWORD or WEBHOOK in its name, and each value read from the secret store, is replaced by `***`. The loop and the Slack notifier read through the same lookup (D-030).

## Codex
An agent with `harness = "codex"` runs on the Codex CLI (D-032, docs/CONFIG.md "Codex agents").
1. Install it: `npm install -g @openai/codex`.
2. Sign in: `codex login`.
3. Check the sign-in: `codex login status`. `harnessd doctor` runs the same check as `harness.codex.auth`.

The minimum tested version is 0.171.0. Below it, `harness.codex.version` is `warn`. The loop still runs. Update with `npm install -g @openai/codex@latest`.

## OpenCode
An agent with `harness = "opencode"` and `model = "<provider>/<model>"` runs on OpenCode 2.x, for example `model = "deepseek/deepseek-chat"`. Settings, Team lists the models that `opencode models` reports.
1. Install it with the official installer: `curl -fsSL https://opencode.ai/install | bash`. npm still has 1.x, so harnessd does not install OpenCode through npm. The installer puts the binary in `~/.opencode/bin`. Add that folder to PATH, or set it in `~/.harnessd/config.toml`:

   ```toml
   [harnesses.opencode]
   bin = "/Users/you/.opencode/bin/opencode"
   ```
2. Sign in each provider the agents use. In Settings, Harnesses, OpenCode, click Sign in next to the provider. The daemon runs `opencode auth login <provider>` as a child process. When the provider asks for a typed API key, the card shows the command to run in a terminal instead. harnessd never reads or passes the key.
3. Check it: `harnessd doctor`. `harness.opencode.auth` fails and names each provider an agent uses that is not signed in.

The minimum tested version is 2.0.20. Below it, `harness.opencode.version` is `warn`. Update with `opencode upgrade`; Settings runs the same command.

## The launchd service
| | |
|---|---|
| Label | `dev.harnessd.daemon` |
| Plist | `~/Library/LaunchAgents/dev.harnessd.daemon.plist` |
| Runs | `<global harnessd> run`, in the `--workspace` folder |
| Logs | `~/.harnessd/logs/daemon.out.log`, `~/.harnessd/logs/daemon.err.log` |
| PATH | node's folder, harnessd's folder, then the PATH init ran with |
| Restarts | at login (`RunAtLoad`), and after a non-zero exit, at most every 30 s |

`HARNESSD_HOME` is passed on when it was set for `init`.

When the service works on its own install clone, it pulls, rebuilds and restarts itself through launchd after each merge to the default branch (docs/LOOP.md "Self-update"). Set `[daemon] self_update = false` to turn it off.

launchd does not load nvm or your shell profile. The service sees only the PATH in the plist, and `harnessd init` writes that PATH. The from-source wrapper in the README names its Node by an absolute path, so the service always runs that Node, whatever Node is first on PATH. After you change Node, run the README Install block again with the new Node active, then run `harnessd init` again.

## Secrets
harnessd needs a Linear personal API key, and a Slack webhook url if you want Slack. Set both in the app. No shell profile edit and no restart is needed (D-030).

1. Open the url that `harnessd run` prints, then Settings, Connections.
2. On the Linear card, paste the key into **API key** and press **Save**. On the Slack card, paste the webhook url into **Webhook url**.
3. The card shows "Set" and the source, and its checks run again. Press **Start** when nothing blocks.

The app is write-only: it never shows a saved value again. **Replace** saves a new value. **Remove** deletes the saved value or reference.

**The store.** A saved value goes to `~/.harnessd/secrets/<id>` (under `$HARNESSD_HOME` when set): `linear.api_key` and `slack.webhook_url`. The folder is `0700`, and each file is `0600`. Each save writes a temp file, then renames it, so a reader never sees half a value.

**References.** Instead of a value, enter a reference. The app saves it in `~/.harnessd/config.toml`, never the value (docs/CONFIG.md "Secrets"):
- `op://vault/item/field` reads the value with the 1Password CLI (`op read`) each time it is used. The result is kept in memory for 5 minutes. Install `op` and sign in first.
- `env:NAME` reads the variable `NAME`.

**Lookup.** For each secret, harnessd uses the saved value or reference first, then the environment variable (`LINEAR_API_KEY`, `HARNESSD_SLACK_WEBHOOK_URL`). So an existing setup with variables keeps working. A running daemon reads the lookup again on each Linear request and each Slack post, so a new value applies on the next tick.

Without a key, the service serves the app and the loop waits in setup (D-026). You can still use variables, for example for a headless machine:
```sh
launchctl setenv LINEAR_API_KEY lin_api_...
launchctl kickstart -k gui/$(id -u)/dev.harnessd.daemon
```
`launchctl setenv` does not survive a reboot. A saved value does.

### Slack
harnessd posts to Slack **#harnessd** through an incoming webhook (D-015, D-021). Without one it posts nothing, logs one warning at start and works as before.
1. In Slack, create an app for your workspace, turn on **Incoming Webhooks** and add a webhook for #harnessd. Copy its url.
2. Paste the url into **Webhook url** on the Slack card in Settings, Connections, and press **Save** (see "Secrets" above). `HARNESSD_SLACK_WEBHOOK_URL` still works as a fallback.
3. The Slack card shows `slack.webhook` as `set (saved)`.

The url is a secret. harnessd keeps it in the secret store and never writes it to config.toml or logs. The notifier reads it before each post, so a new url applies at once. It must start with `https://`. The webhook fixes the channel; `slack.channel` is only a label. Set `slack.summary_time` and `slack.time_zone` in `.harnessd/config.toml` (docs/CONFIG.md).

What harnessd posts:
- **A notice per event:** one line per merge, per block (Needs input, an escalation, two QA or gate failures) and per protected PR that waits for a human. Each line links the issue and the PR, when there is one.
- **A daily summary** at `slack.summary_time` (default 21:00) in `slack.time_zone` (default `Asia/Kolkata`). It lists the merges and blocks since the last summary, the time each harness was held by a usage limit, and the runs in progress now. If the daemon was off at that time, the summary goes out once at the next start. The first start sends none. State is in `<repo>/.harnessd/state/summary.json`.
- **Failures:** a post runs in the background, so Slack never stops or slows the loop. A 5xx, a 429 or a network error is retried 3 times, after 1 s, 2 s and 4 s. Then the message is dropped with one log line. Other 4xx errors are dropped at once.

```sh
launchctl print gui/$(id -u)/dev.harnessd.daemon     # status
tail -f ~/.harnessd/logs/daemon.err.log
```

## Uninstall
```sh
launchctl bootout gui/$(id -u)/dev.harnessd.daemon
rm ~/Library/LaunchAgents/dev.harnessd.daemon.plist
npm rm -g @harnessd/cli
rm -rf ~/.harnessd        # optional: config, vaults, state and logs
```
Claude Code, Codex and Node stay installed. Remove them with `npm rm -g @anthropic-ai/claude-code @openai/codex` and `brew uninstall node@24` if you want.
