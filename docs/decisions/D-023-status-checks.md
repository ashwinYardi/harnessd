# D-023 One status engine; fail and missing block the loop
Status: accepted 2026-11-20.
- `harnessd doctor`, the start of `harnessd run` and `GET /api/status` use one list of checks.
- A check has an id, a state, a one-line detail and a one-line fix.
- The states are `ok`, `warn`, `fail` and `missing`. `fail` is present but broken. `missing` is required and absent.
- A check that waits on a blocking check does not run. It is `missing`, with the detail "not checked" and the fix "Fix <id> first."
- `fail` and `missing` both block `harnessd run`, and both make `doctor` exit 1. `warn` never blocks.
- Sign-in is checked with each CLI's own status command: `claude auth status --json`, `codex login status`, `gh auth status`. No check spends tokens (D-002).
- Sign-in checks read only the exit code and named JSON fields of that output.
- Secret values from the environment are masked in every detail and fix.

Why:
- A required tool that is not installed stops the loop as surely as a broken one. So `missing` blocks too.
- A failure shows at start, with its fix, and not late in a log.

Issue: MET-27.
