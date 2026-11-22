# D-040 Cut the token spend per parent
Status: accepted 2026-11-22. Issue: MET-123. Amends D-014 and SPEC "Limits" and "Autonomy loop" step 4. Supersedes the part limit in the MET-87 draft and the QA timing in the MET-86 draft.

- The default `limits.max_concurrent` is 1. A user may still set up to 3 (D-014 cap). Parallel parts of one parent touched the same files, so each merge sent the next PR back for another build and QA round.
- The coordinator plans one part, one PR, per ticket by default. It splits only when the ticket's Size is L or one part cannot fit the M budget, and the split comment states the reason. A plan with more than one part and no reason is invalid, and the loop uses the one-part fallback.
- Parts of a split ticket run one after another. Each part blocks the next (`blocks` relations), and a part starts only after the part before it is merged. No two PRs of one ticket are open at the same time.
- QA reviews one part when that part reaches In Review: its diff, the parent's "Done when", CI and the tests. QA does not read the whole repo. The reviewed head per part is recorded in `loop.json`; a part whose PR head did not change since its approval gets no second QA run.
- Each parent has a token budget: `limits.token_budget`, keyed by size like `budget_minutes` (S 5M, M 12M; an unknown size counts as M). It sums input, cached and output tokens of the parent's grill, plan, part and QA runs. At or over the budget the loop starts nothing, moves the parent to Needs input, posts one comment and sends one notice. A run in flight finishes. When a human moves the parent back to Ready, the count starts again from the escalation point.
- Each run logs `'<key>: <agent> used <input> input, <cached> cached, <output> output tokens'`, and the sum per parent survives a restart in `loop.json` under `usage`. The board shows the sum as one compact count.
- A worktree run gets a role-based skill set: the frontend role gets the full pack, other roles get the pack without impeccable. Its MCP servers are limited to `harnessd-memory`. `enabled = false` still turns a skill off for everyone.
- The base prompt per run is measured and cut. Prompt sizes are reported in `docs/LOOP.md` "What an agent run sees". The owner-level gaps (D-032 `$CODEX_HOME`, D-036 `~/.claude/skills`) are measured and out of scope.

Why:
- On 2026-11-22 one parent used the Codex quota in about two hours: 51 sessions, about 29M input tokens, mostly cached. QA re-reviewed every part every round, rounds churned on stale heads, and one ticket became four parallel PRs that each invalidated the others.
- One part is one PR and one QA pass. Serial parts keep one PR open per ticket, so a merge never sends a sibling PR back.
- A budget on the parent stops a loop that keeps finding one more edge case, and asks the human once instead of every round.
- QA reads one diff against a checklist and harnessd runs the tests, so QA needs a fast, low-cost model. Builder runs are long agent loops and make most of the spend, so they get a capable model, with a top model only for M parts or after a QA failure (docs/CONFIG.md).
