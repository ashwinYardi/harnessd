# D-038 OpenCode sync owns permission and Web Search settings

Status: draft 2026-11-22. Issue: MET-119. Amends D-037.

Sync replaces `permission` and `websearch` as whole keys in `opencode.json`. It keeps ownership of `$schema` and its own `mcp` entries. D-036 records the defaults and the per-agent override.

The permission table gives unattended runs a fixed policy. The Web Search provider setting avoids the separate provider consent form.
