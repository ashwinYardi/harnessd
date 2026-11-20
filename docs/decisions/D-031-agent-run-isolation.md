# D-031 Agent runs skip the owner's user-level Claude config
Status: accepted 2026-11-20. Issue: MET-46.

- Every claude run gets `--setting-sources project --strict-mcp-config --mcp-config .mcp.json`. This includes coordinator grill and plan runs. The `.mcp.json` path is relative to the run's cwd.
- claude exits with "MCP config file not found" when that file is missing. So a run whose cwd has no `.mcp.json` gets `--mcp-config '{"mcpServers":{}}'` instead: no MCP servers, and the run still starts.
- `--setting-sources project` stops the owner's `~/.claude` settings, CLAUDE.md, skills, hooks and plugins from loading.
- User MCP servers live in `~/.claude.json`, not in settings. So the strict MCP flags are needed too.
- `--bare` is rejected. It skips the skill hooks that D-028 needs, and the keychain reads that subscription sign-in needs.
- `--safe-mode` is rejected. It drops project skills and hooks.
- Sign-in still works, because auth is not a setting source.
- Agent runs lose the owner's user permissions allowlist, user env, apiKeyHelper and user plugins. This is acceptable. Runs use `--permission-mode auto`, and a key goes in through `claude login` or an environment variable (D-026). The `claude.auth` check (D-023) does not change.
- Each new adapter must use its harness's equivalent flags.
- Before each worktree run, the loop writes the merged native files into the worktree with the same sync as `harnessd sync`. Another MET-46 part builds this. Coordinator runs in the owner's checkout get no sync. They carry the method in the prompt (D-022).

Why:
- Agent behaviour must not depend on one person's private setup.
- An agent run must see the harnessd skill pack, rules and memory in any repo, not only in a repo that vendors them.
