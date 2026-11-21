# D-031 Sign-in runs the harness CLI's own login as a daemon child process
Status: accepted 2026-11-20. Amended by D-037 (draft): OpenCode provider sign-in. Amends D-026 (sign-in opened Terminal on macOS only). Issue: MET-58, part of MET-48.

- Settings, Harnesses, Sign in runs the CLI's own login as a child process of the daemon, on every platform: `claude auth login` or `codex login`. No other app is started or automated. No `osascript`.
- The binary is the one the status engine checks: `[harnesses.<id>] bin`, then `HARNESSD_*_BIN`, then PATH. When none is found, the route answers 400 `not_installed` and runs nothing.
- The argv stays fixed per route, with no shell. The request body stays `{}`. stdin is closed. The 10-minute limit stays. No extra flag is added, such as `--device-auth`.
- The output goes only to the job's `lines`, capped at 200, with env secret values masked as the checks mask them. It is not written to the daemon log.
- The job reads the first `https://` URL and the first device code (such as `ABCD-1234` on a line that says "code" or "enter") into `url` and `code`. The app shows them; the browser opens only on the person's click. No other scheme is kept.
- node-pty is not used, because it is a native module (same reason as D-030). When a CLI needs a TTY or typed input, the card shows the one command to copy (`commands.signin`).

Why:
- Driving Terminal through AppleScript made macOS ask the person to let node control Terminal. That is a bad first run.
- A plain child process needs no OS permission, and works the same on macOS and Linux.
- The fixed argv and the empty body keep D-026's rule: no request text reaches a command line.
