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
| `fail` | It is there but broken. | yes |
| `missing` | It is required and absent. A check that waits on a blocking one is `missing` too, with the detail "not checked". | yes |

The exit code is 1 when any check is `fail` or `missing`, 0 otherwise, and 2 for a usage error.

| Check | How | Not ok |
|---|---|---|
| `node` | the running Node | `fail` below 24. Fix: `nvm install 24 && nvm alias default 24`, or `brew install node@24` |
| `config` | loads global and workspace config.toml | `fail` with the file and key |
| `harness.<id>.cli` | `$HARNESSD_CLAUDE_BIN` or `claude`, `$HARNESSD_CODEX_BIN` or `codex`, on PATH; then `--version` | `missing` when not found |
| `harness.<id>.auth` | `claude auth status --json`; `codex login status` | `fail` when signed out; `warn` when the status cannot be read |
| `harness.<id>.version` | the version against a list of known-bad releases | `warn` |
| `github.cli` | `$HARNESSD_GH_BIN` or `gh` on PATH | `missing` |
| `github.auth` | `gh auth status --active` | `fail`: run `gh auth login` |
| `github.push` | `gh repo view --json viewerPermission` | `fail` below WRITE, or with no GitHub remote |
| `github.ci` | the default branch's rulesets, and its classic protection when gh may read it | `warn` when no check is required |
| `linear.key` | one GraphQL read with `LINEAR_API_KEY` | `missing` when unset; `fail` when rejected or unreachable |
| `linear.team` | `linear.team_id`, as a key or a UUID | `missing` when unset; `fail` when unknown |
| `linear.states` | Ready, In Progress, In Review, Done and Needs input | `fail`, with the missing names |
| `slack.webhook` | `HARNESSD_SLACK_WEBHOOK_URL` is set | `warn` only |
| `git.worktrees` | `git worktree list` in the workspace | `fail` outside a git clone |
| `daemon.port` | binds `127.0.0.1:<daemon.port>` | `warn` when a running harnessd holds it; `fail` when anything else does |
| `skills.pack` | each default skill in `~/.harnessd/skills/` | `warn`: run `harnessd init` |

Harnesses are checked once for each harness an agent uses. Checks run in parallel. No command runs past 5 s, so `doctor` returns within a few seconds. No check spends tokens. Sign-in checks read only the exit code and named JSON fields, never the account or the token. Output never shows a key, a token or a webhook: each value of 6 characters or more of an environment variable with KEY, TOKEN, SECRET, PASSWORD or WEBHOOK in its name is replaced by `***`. The Slack notifier reads `HARNESSD_SLACK_WEBHOOK_URL` (D-021).

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

`harnessd run` needs `LINEAR_API_KEY` (docs/LOOP.md). init never writes secrets to disk, so give the key to launchd for this login session, then restart the service:
```sh
launchctl setenv LINEAR_API_KEY lin_api_...
launchctl kickstart -k gui/$(id -u)/dev.harnessd.daemon
```
Until the key is set, the service logs the missing-key error to `daemon.err.log` and retries every 30 s. `launchctl setenv` does not survive a reboot.

### Slack
harnessd posts to Slack **#harnessd** through an incoming webhook (D-015, D-021). Without one it posts nothing, logs one warning at start and works as before.
1. In Slack, create an app for your workspace, turn on **Incoming Webhooks** and add a webhook for #harnessd. Copy its url.
2. Give the url to launchd, then restart the service:
   ```sh
   launchctl setenv HARNESSD_SLACK_WEBHOOK_URL https://hooks.slack.com/services/...
   launchctl kickstart -k gui/$(id -u)/dev.harnessd.daemon
   ```
3. Check `daemon.out.log` for `slack: posting notices to #harnessd, daily summary at 21:00 Asia/Kolkata`.

The url is a secret. harnessd reads it from the environment only and never writes it to disk or logs. It must start with `https://`. The webhook fixes the channel; `slack.channel` is only a label. Set `slack.summary_time` and `slack.time_zone` in `.harnessd/config.toml` (docs/CONFIG.md).

What harnessd posts:
- **A notice per event:** one line per merge, per block (Needs input, an escalation, two QA or gate failures) and per protected PR that waits for a human. Each line links the issue and the PR, when there is one.
- **A daily summary** at `slack.summary_time` (default 21:00) in `slack.time_zone` (default `Asia/Kolkata`). It lists the merges and blocks since the last summary, and the runs in progress now. If the daemon was off at that time, the summary goes out once at the next start. The first start sends none. State is in `<repo>/.harnessd/state/summary.json`.
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
