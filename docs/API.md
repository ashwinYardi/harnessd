# Local HTTP API

`harnessd run` serves a small JSON API and the web UI next to the loop (code: `packages/daemon/src/server/`). The CLI and the UI use it (D-024).

- **Address.** It listens on `127.0.0.1` only, at `daemon.port` (default 4747, docs/CONFIG.md). The bound url is written to `~/.harnessd/state/daemon.json` (`{ "url", "pid", "startedAt" }`) and removed on a clean stop.
- **No auth.** Safety rests on three checks:
  - requests must carry a loopback `Host` (`127.0.0.1`, `localhost` or `[::1]`), or they get 403;
  - POSTs must send `content-type: application/json`, or they get 415, so a web page cannot trigger them cross-origin;
  - bodies are capped at 64 KiB (413).
- **Responses.** Every API response is JSON, except the event stream and the UI's files. Errors are `{ "error": "<code>", "message": "…" }`:

| Status | Code |
|---|---|
| 400 | `invalid_json`, `invalid_body` (a form error adds `"fields": { "<row>.<field>": "…" }`), `invalid_config` (a config.toml on disk that the validator rejects; a write that would make one is `invalid_body`), `unsupported` |
| 403 | `forbidden_host` |
| 404 | `not_found` |
| 409 | `busy`, `setup_incomplete` |
| 405 | `method_not_allowed`, with an `Allow` header |
| 413 | `payload_too_large` |
| 415 | `unsupported_media_type` |
| 500 | `internal_error` |

## Routes
| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/health` | | `{ "ok": true, "version": "0.0.0" }` |
| GET | `/api/pause` | | `PauseState` |
| POST | `/api/pause` | optional `{ "reason": "…" }` | `PauseState` plus `"cancelled": <number>` |
| POST | `/api/resume` | optional `{}` | `PauseState` |
| GET | `/api/status` | | `{ "checks": Check[] }` |

`PauseState` is `{ "paused": false }` or `{ "paused": true, "since": "<ISO time>", "reason"?: "…" }`.

- **POST /api/pause** sets the flag and cancels every run in flight (docs/LOOP.md, Pause). It answers once they have exited, normally within the 5 s kill grace. `cancelled` counts the sub-issue runs this call stopped. Pausing again keeps `since`. A new `reason` replaces the old one. Reasons are trimmed to 500 characters, and any other key is a 400.
- **POST /api/resume** clears the flag and ticks the loop at once.
- **GET /api/status** runs the checks of `harnessd doctor` (docs/INSTALL.md) and returns them. A `Check` is `{ "id", "state", "detail", "fix" }`. `state` is `ok`, `warn`, `fail` or `missing`. It answers within about 5 s. Calls that arrive while a run is in progress share its result. No secret value is in the response.

```sh
curl -s -X POST -H 'content-type: application/json' -d '{"reason":"deploy"}' http://127.0.0.1:4747/api/pause
# {"paused":true,"since":"2026-11-19T10:00:00.000Z","reason":"deploy","cancelled":2}
```

## UI routes (MET-18)
The UI's read models are typed in `packages/shared/src/ui.ts`.

| Method | Path | Response |
|---|---|---|
| GET | `/api/board` | `BoardSnapshot`: `{ "fetchedAt", "issues": BoardIssue[], "error"? }` |
| GET | `/api/agents` | `AgentsSnapshot`: `{ "agents": AgentView[], "lastPollAt", "maxConcurrent", "limits" }` |
| GET | `/api/logs` | `{ "lines": LogLine[] }`, the newest 500 lines |
| GET | `/api/events` | `text/event-stream` (below) |
| GET | `/`, `/index.html`, `/assets/…` | The built UI |

- **Board.** Every issue of the team and project that is not canceled. Done shows the last 7 days. Linear is read at most once per 15 s; concurrent reads share one call. A failed read keeps the last good issues and sets `error`; before the first good read, `fetchedAt` is null. The loop adds `agent` to an issue it runs and `blocked` (the reason) to a part whose PR waits for a human at the merge gate.
- **Agents.** Every configured agent, coordinator first. Each run has its `startedAt`, its size budget `budgetMs`, the `tokens` used so far (input plus output) and its `lastAction` (the latest tool call or message). `stopping` is true while a pause stops it. `limits` lists the harness holds in force, the same as on `/api/loop`. A hold that starts or ends changes it, so the `agents` event carries it within a second.
- **Logs.** Each loop log line and each agent tool call, with a `seq` that grows by one. The first `seq` is the daemon start time in ms, so a restarted daemon never reuses one. `level` is `warn` for failures, timeouts and escalations.
- **Events.** One stream per page. On connect it sends `pause`, `agents` and `board` with the current state. After that, each change goes out once as the same event: the pause flag and the agents are checked every second, the board every 15 s. Each new log line goes out as a `log` event. A comment line goes out every 15 s, so idle connections stay open. The stream ends when the daemon stops; the browser then reconnects, and the UI fetches `/api/logs` again to fill any gap.

  ```text
  event: pause
  data: {"paused":false}

  event: log
  data: {"seq":42,"at":"…","source":"backend","issueKey":"MET-41","level":"info","text":"Edit src/app.ts"}
  ```
- **The UI's files** are read once at start from `packages/ui/dist/app`, the Vite build. Each file is its own exact route, so no other path is served. The HTML carries a strict `content-security-policy` (only its own scripts, styles and connections; no framing). One inline style is allowed by its hash: the fixed scrollbar rule that Base UI renders (D-025). Hashed assets are cached for a year. If the UI is not built, `harnessd run` says so and serves the API alone.

## Settings routes (MET-28)
The Settings pages use these routes (code: `packages/daemon/src/setup/routes.ts`, D-026). Every POST is loopback only, needs `content-type: application/json` and passes the Host check above, like every other route.

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/loop` | | `LoopView`: `{ "state": "setup" \| "running", "blocking": string[], "limits"? }`; in setup, each read runs the checks again, so `blocking` lists the ids that block now. An optional `selfUpdate` is `{ from, to, at, state, error? }` for the last self-update (MET-63), with `state` `pending`, `done`, `failed` or `blocked`; the Settings banner shows its commits |
| POST | `/api/start` | `{}` | the same, once the loop runs; 409 `setup_incomplete` names the blockers |
| GET | `/api/harnesses` | | `{ "harnesses": HarnessCard[] }` for `claude-code`, `codex` and `opencode` |
| POST | `/api/harnesses/<id>/install` | `{}` | `Job`; for `opencode`, nothing runs: a `failed` job whose `manual` holds the installer to copy |
| POST | `/api/harnesses/<id>/update` | `{}` | `Job`; for `opencode`, runs `opencode upgrade` |
| POST | `/api/harnesses/<id>/signin` | `{}` | `Job`; 400 `not_installed` when the CLI is not found. Not for `opencode`: sign in per provider |
| GET | `/api/setup/opencode/models` | | `{ "models": string[], "reason"? }`: the `<provider>/<model>` ids `opencode models` lists |
| GET | `/api/setup/opencode/providers` | | `{ "providers": [{ "id", "signedIn", "required", "command" }], "reason"? }` |
| POST | `/api/setup/opencode/providers/<provider>/signin` | `{}` | `Job` with `provider`; 404 `unknown_provider` when the daemon's own set lacks it |
| POST | `/api/harnesses/<id>/path` | `{ "path": "/abs/path" }` or `{ "path": null }` | `{ "bin" }` |
| GET | `/api/setup/events` | | `text/event-stream` of `job` events |
| GET | `/api/team` | | `{ "agents": [{ "name", "role", "harness", "model", "removable" }] }` |
| POST | `/api/team` | `{ "agents": [{ "name", "role", "harness", "model"? }] }` | the new team, plus `synced` (files `harnessd sync` wrote) or `syncError` |

- **Self-update.** While the loop runs, GET /api/loop can return a `selfUpdate` field. It holds `{ from, to, at, state, error? }` for the last self-update. See docs/LOOP.md, “Self-update”.
- **limits** is set while the loop runs. It lists each harness hold in force (docs/LOOP.md "Usage limits"): `[{ "harness": "claude-code", "until": "…", "backoff": false }]`. `until` is the ISO time the hold ends. `backoff` is true when the harness gave no reset time, so `until` is the backoff's end. A hold whose time has passed is left out, even before the loop releases it. No hold gives `[]`. The type is `LoopView` and `HarnessLimit` in `packages/shared`.

  ```json
  { "state": "running", "blocking": [], "limits": [{ "harness": "claude-code", "until": "2026-11-20T18:37:00.000Z", "backoff": false }] }
  ```
- **HarnessCard** is `{ id, name, required, bin, checks, commands, job }`. `checks` are the status engine's `harness.<id>.*` checks, run for this harness whether an agent uses it or not. `required` is true when an agent uses it. `commands` are the setup commands as text, for a person to run by hand.
- **Setup commands are fixed.** Each action route runs one argv known in code: `npm install -g <package>`, `npm install -g <package>@latest`, and the CLI's own login (`claude auth login` or `codex login`) as a child process of the daemon, at the path the status engine checks (D-031). No other app is started. The body must be `{}`; any key is a 400. No shell runs. One command runs per harness at a time (409 `busy`). A command gets SIGTERM after 10 minutes, and SIGKILL 5 s later. Config writes run one at a time.
- **OpenCode** (D-036). `models` runs `opencode models --standalone` with no shell and a 30 s limit. It keeps each line that matches `OPENCODE_MODEL` (`packages/shared/src/team.ts`) and caches the list for 5 minutes. A missing CLI, a timeout, an error or an empty list gives `models: []` and a `reason`, never a 500. `providers` runs `opencode auth list --format json --standalone` and reads only provider ids. It adds the providers that opencode agents name in `model` or `fallback_model`. `required` marks those. Provider sign-in accepts a path value only when it matches `^[a-z0-9][a-z0-9._-]{0,63}$` and the provider list holds it. It runs `opencode auth login --standalone -- <provider>` with the list's value, stdin closed. A provider that waits for a typed key fails the job; `manual` then holds the command to run in a terminal. No key is passed on the command line.
- **Job** is `{ id, harness, action, command, state, exitCode?, lines, startedAt, url?, code?, provider?, manual? }`. `state` is `running`, `ok` or `failed`. `lines` holds the last 200 output lines, with env secret values masked; they are not written to the daemon log. For sign-in, `url` is the first `https://` URL in the output and `code` is the first device code. The app opens `url` only on a click. Each change goes out as a `job` event on `/api/setup/events`; a new stream gets the current jobs first.
- **Binary path** must be absolute, an executable file, and end in the CLI's own name (`/claude`, `/codex`), because the status engine and the loop run it. It is written to `[harnesses.<id>] bin` in `~/.harnessd/config.toml`. `null` removes it. Other lines of the file stay.
- **Team.** The rows are checked by `validateTeam` (`packages/shared/src/team.ts`): names are lowercase letters, digits, `-` and `_`; roles and harnesses come from the config schema; the team has exactly one coordinator. A default agent, or one set outside the workspace config.toml, cannot be removed. Only changed agents are written, to `[agents.<name>]` tables of `<repo>/.harnessd/config.toml`. The new file is checked with the config validator before it is written; an invalid team writes nothing. Then `harnessd sync` runs.
- **Secrets.** Harness keys go in through each CLI's own sign-in. The Linear key and the Slack webhook go in through the secret routes below. No route returns a secret.

## Secret routes (MET-33)
Settings, Connections saves the Linear key and the Slack webhook url with these routes (code: `packages/daemon/src/secrets/`, D-030). They are write-only.

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/secrets` | | `{ "secrets": SecretState[] }` |
| POST | `/api/secrets/linear.api_key` | `{ "value": "…" }` | `{ "secret": SecretState, "checks": Check[] }` |
| POST | `/api/secrets/slack.webhook_url` | `{ "value": "…" }` | the same |
| POST | `/api/secrets/linear.api_key/remove` | `{}` | the same |
| POST | `/api/secrets/slack.webhook_url/remove` | `{}` | the same |

- **SecretState** is `{ "id", "set": boolean, "source": "saved" | "1Password" | "env" | null }`. It never holds the value or the reference.
- **value** is the secret, or a reference: `op://vault/item/field` or `env:NAME` (docs/CONFIG.md "Secrets"). A value goes to `~/.harnessd/secrets/<id>`; a reference goes to `~/.harnessd/config.toml`. Saving one removes the other.
- **checks** are that connection's checks, run again after the change: `linear.*` or `slack.*`. A value that a check echoes is masked.
- **Fixed ids.** Each id has its own route, so no text from a request names a file. Any other path is 404.
- **Errors.** A bad body or a value the store refuses is 400 `invalid_body`. A broken global config.toml is 400 `invalid_config`, and nothing is written. No error, response, log line or event repeats a value. The log gets one line per change, such as `settings: saved linear.api_key (saved)`.
- The routes pass the same checks as every other route: loopback Host (403), `content-type: application/json` (415), 64 KiB (413).

```sh
curl -s -X POST -H 'content-type: application/json' -d '{"value":"op://Private/Linear/credential"}' http://127.0.0.1:4747/api/secrets/linear.api_key
# {"secret":{"id":"linear.api_key","set":true,"source":"1Password"},"checks":[…]}
```

New routes are added as `Route` values (`{ method, path, handler }`) through `startDaemon({ routes })`. The handler returns the JSON body of a 200, a `RawBody` (a file), or an `EventStream`, or throws `HttpError(status, code)`.
