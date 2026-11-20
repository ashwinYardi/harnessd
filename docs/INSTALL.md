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
3. **Service (macOS only).** It writes `~/Library/LaunchAgents/dev.harnessd.daemon.plist`, then runs `launchctl bootstrap gui/$UID <plist>`.
   - If the plist is unchanged and already loaded, nothing happens.
   - If the plist changed and the service is loaded, it runs `launchctl bootout gui/$UID/dev.harnessd.daemon` first.
   - On Linux, or with `--no-service`, it prints that the service is skipped.

The exit code is 0 when everything it tried worked, even if you declined an install; the last line lists what is not installed. It is 1 when an install or `launchctl` failed, and 2 for a usage error.

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
