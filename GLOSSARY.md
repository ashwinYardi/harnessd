# Glossary

Terms as harnessd uses them. Decisions live in `docs/decisions/`.

- **Board**: the issues of the team and project, grouped by workflow state. Done shows the last 7 days. Canceled issues are left out.
- **Needs you**: the board column for issues a human must act on. It holds issues in **Needs input** and **Blocked** issues. It is the loudest thing in the UI (PRODUCT.md).
- **Needs input**: the Linear workflow state for an issue the coordinator escalated (D-011), or one that failed twice (D-014).
- **Blocked**: an issue whose PR waits for a human at the merge gate (D-013), for example because it touches a protected path. An issue that only waits for another issue is not Blocked; it shows its blockers.
- **Budget used**: elapsed wall-clock time of a run over its size budget (S 30 min, M 2 h, D-014).
- **Run**: one agent working one sub-issue in its own worktree (D-012). A QA round is one run.
- **Event stream**: the server-sent events at `GET /api/events` that push pause, board, agent and log changes to the UI (D-020).
- **Held update**: a live change the UI keeps back while the pointer or focus is in that region, so content never moves under the cursor.
