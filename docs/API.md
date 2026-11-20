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
| 400 | `invalid_json`, `invalid_body` |
| 403 | `forbidden_host` |
| 404 | `not_found` |
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
| GET | `/api/agents` | `AgentsSnapshot`: `{ "agents": AgentView[], "lastPollAt", "maxConcurrent" }` |
| GET | `/api/logs` | `{ "lines": LogLine[] }`, the newest 500 lines |
| GET | `/api/events` | `text/event-stream` (below) |
| GET | `/`, `/index.html`, `/assets/…` | The built UI |

- **Board.** Every issue of the team and project that is not canceled. Done shows the last 7 days. Linear is read at most once per 15 s; concurrent reads share one call. A failed read keeps the last good issues and sets `error`; before the first good read, `fetchedAt` is null. The loop adds `agent` to an issue it runs and `blocked` (the reason) to a part whose PR waits for a human at the merge gate.
- **Agents.** Every configured agent, coordinator first. Each run has its `startedAt`, its size budget `budgetMs`, the `tokens` used so far (input plus output) and its `lastAction` (the latest tool call or message). `stopping` is true while a pause stops it.
- **Logs.** Each loop log line and each agent tool call, with a `seq` that grows by one. The first `seq` is the daemon start time in ms, so a restarted daemon never reuses one. `level` is `warn` for failures, timeouts and escalations.
- **Events.** One stream per page. On connect it sends `pause`, `agents` and `board` with the current state. After that, each change goes out once as the same event: the pause flag and the agents are checked every second, the board every 15 s. Each new log line goes out as a `log` event. A comment line goes out every 15 s, so idle connections stay open. The stream ends when the daemon stops; the browser then reconnects, and the UI fetches `/api/logs` again to fill any gap.

  ```text
  event: pause
  data: {"paused":false}

  event: log
  data: {"seq":42,"at":"…","source":"backend","issueKey":"MET-41","level":"info","text":"Edit src/app.ts"}
  ```
- **The UI's files** are read once at start from `packages/ui/dist/app`, the Vite build. Each file is its own exact route, so no other path is served. The HTML carries a strict `content-security-policy` (only its own scripts, styles and connections; no framing). Hashed assets are cached for a year. If the UI is not built, `harnessd run` says so and serves the API alone.

New routes are added as `Route` values (`{ method, path, handler }`) through `startDaemon({ routes })`. The handler returns the JSON body of a 200, a `RawBody` (a file), or an `EventStream`, or throws `HttpError(status, code)`.
