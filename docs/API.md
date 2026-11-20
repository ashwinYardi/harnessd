# Local HTTP API

`harnessd run` serves a small JSON API next to the loop (code: `packages/daemon/src/server/`). The CLI uses it, and the UI (MET-18) will.

- **Address.** It listens on `127.0.0.1` only, at `daemon.port` (default 4747, docs/CONFIG.md). The bound url is written to `~/.harnessd/state/daemon.json` (`{ "url", "pid", "startedAt" }`) and removed on a clean stop.
- **No auth.** Safety rests on three checks:
  - requests must carry a loopback `Host` (`127.0.0.1`, `localhost` or `[::1]`), or they get 403;
  - POSTs must send `content-type: application/json`, or they get 415, so a web page cannot trigger them cross-origin;
  - bodies are capped at 64 KiB (413).
- **Responses.** Every response is JSON. Errors are `{ "error": "<code>", "message": "…" }`:

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

New routes are added as `Route` values (`{ method, path, handler }`) through `startDaemon({ routes })`. The handler returns the JSON body of a 200, or throws `HttpError(status, code)`.
