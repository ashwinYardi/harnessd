# D-037 OpenCode sign-in takes a provider id from the daemon's own set
Status: draft 2026-11-21. Amends D-026 and D-031. Issue: MET-71 (part 2, MET-92).

D-038 extends sync ownership of OpenCode settings.

- OpenCode signs in per model provider, not once per harness. So the OpenCode card has no `/api/harnesses/opencode/signin` route. It has `POST /api/setup/opencode/providers/<provider>/signin` instead.
- The provider is a path parameter, not a body key. The body stays `{}`.
- The daemon builds its own allowed set for each request: the providers that `opencode auth list --format json --standalone` lists, plus the providers that opencode agents name in `model` or `fallback_model`. It reads only the `id` of each listed provider, never a credential field.
- The route accepts a value only when it matches `^[a-z0-9][a-z0-9._-]{0,63}$` and the set holds it. Any other value is a 404 `unknown_provider`, and no command runs.
- The argv is fixed: `opencode auth login --standalone -- <provider>`. The provider is one argv item after `--`, and it is the set's stored value. No shell runs. No `--answer` or `--method` is passed, so harnessd never passes a key.
- The D-031 sign-in job rules stay: the binary the status engine checks, stdin closed, output lines capped at 200 and masked, the first URL and device code read, the 10-minute limit.
- A provider that waits for a typed API key reads end of input and fails. The job then sets `manual` to `opencode auth login <provider>`, the one command to run in a terminal. harnessd does not drive a terminal.
- OpenCode does not install through npm (npm latest is 1.x). The install route runs nothing. It returns a finished job whose `manual` holds the official installer command to copy. Update runs `opencode upgrade` with the binary the status engine checks.
- Sync writes `opencode.json` for MCP. It merges as D-028 does for `.claude/settings.json`: sync owns `$schema` and its own `mcp` entries by name; every other key stays the user's. OpenCode 2.x reads AGENTS.md, `.claude/skills/` and `.agents/skills/`, so sync writes no new skills folder.

Why:
- One fixed argv per route (D-026) cannot cover a list of providers that changes per machine. A path value checked against the daemon's own set keeps the rule's intent: no request text reaches a command line unless the daemon already holds the same value.
- The regex and the `--` keep a value from being read as a flag, even if the set held a strange id.
- A typed key must not pass through harnessd, and stdin stays closed (D-031). The copy command is the one safe path for key-only providers.
