# D-026 harnessd run serves the app in setup; Start starts the loop
Status: accepted 2026-11-20. Amended by D-030: the app takes the Linear and Slack secrets. Amended by D-031: sign-in runs the CLI login as a daemon child process, on every platform. Amended by D-037 (draft): OpenCode sign-in takes a provider id from the daemon's own set. Amends D-023 for `harnessd run` without `--once`. Issue: MET-28.

- Without `--once`, `harnessd run` always serves the API and the app. When a check blocks, or `LINEAR_API_KEY` or `linear.team_id` is missing, the loop does not start. The daemon is in **setup**. It prints each blocker and the Settings url.
- `GET /api/loop` says `setup` or `running`, with the blocking check ids. `POST /api/start` runs the checks again and builds the loop. It starts the loop only when nothing blocks; else it answers 409 `setup_incomplete` and names the blockers.
- `harnessd run --once` keeps D-023 as it was: any blocker stops it with exit 1 before anything is served.
- On first launch, when any required check blocks, the app opens Settings → Harnesses. Its banner names every area to fix, with links in the sub-nav.
- The app runs a fixed command per harness and action: `npm install -g <package>`, `npm install -g <package>@latest`, and the CLI's own login command as a child process (D-031). The request body names nothing; the command comes from the route. Output streams to the card. Keys go in only through each CLI's own sign-in or as environment variables. The app never shows or takes a secret.
- `[harnesses.<id>] bin` in `~/.harnessd/config.toml` names a harness CLI. It wins over the `HARNESSD_*_BIN` variables and PATH. The app accepts only an absolute path to an executable whose name is the CLI's own (`claude`, `codex`), because the status engine and the loop run that file.
- The Team page writes only the `[agents.<name>]` tables of the workspace `.harnessd/config.toml`, as text. Every comment and every other table stays. The result is checked with the config validator before it is written; then `harnessd sync` runs.

Why:
- D-023 refused to start on a blocker, so a new user saw a terminal error and no app. Setup in a few clicks needs the app up while setup is incomplete.
- Dispatch still never happens past a blocking check, so D-023's safety holds.
- A fixed argv per route means no request text reaches a command line.
- Default agents always exist after the merge (D-010), so the Team page edits them but cannot remove them.
