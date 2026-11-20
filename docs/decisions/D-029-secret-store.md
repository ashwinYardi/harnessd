# D-029 Settings saves the Linear and Slack secrets in a local secret store
Status: accepted 2026-11-20. Amends D-021 (the webhook came only from the environment) and D-026 (the app never took a secret). Issue: MET-33.

- Settings, Connections takes the Linear key and the Slack webhook url in a write-only field. No route returns a value.
- A saved value is one file in `<HARNESSD_HOME>/secrets/<id>`. The folder is 0700, each file is 0600, and each write is a temp file and a rename.
- The ids are fixed: `linear.api_key`, `slack.webhook_url`. Each id has its own route, so no request text names a file.
- A secret can be a reference instead: `op://…`, read with `op read` at use time (argv, no shell), or `env:NAME`. Only the reference is stored, in `[secrets.<service>]` of the global config.toml. A workspace config.toml may not set it.
- Lookup per secret: saved value or reference, then the old variable (`LINEAR_API_KEY`, `HARNESSD_SLACK_WEBHOOK_URL`). A reference that cannot be read is an error, not a fall-through.
- The status engine names the source (`saved`, `1Password`, `env`) and masks every value it read. The loop reads the key on each Linear request, and the notifier reads the webhook before each post. So a change needs no restart.
- An `op` read is kept in memory for 5 minutes, so the loop does not start `op` on each request.
- No keychain. A file per secret works the same on macOS and Linux, needs no native module, and stays readable by the launchd service.

Why:
- Setup must be a few clicks. A shell profile edit and a restart is not.
- 1Password users keep the value in 1Password; harnessd holds only the pointer.
- The secret store is a protected path (D-013). Its PRs wait for a human.
