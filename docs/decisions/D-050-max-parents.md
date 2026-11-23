# D-050 The Ready column is a queue, capped by limits.max_parents

Status: accepted 2026-11-23. Issue: MET-172, part of MET-171. Amends D-014 and D-040.

- `limits.max_parents` is a positive integer with default 1. It is in `LimitsConfig` and the defaults in `packages/shared/src/config.ts`, checked with the same `positiveInt` as `max_concurrent`. Zero, a negative number and a non-integer are a config error with the text `expected an integer >= 1`. It merges per layer like the other `limits` keys, so a workspace layer overrides the global one.
- A parent is in flight from its grill until it is Done, Canceled or Needs input. `max_parents` caps the parents in flight. The loop takes the top Ready parent in Linear's manual order (`sortOrder`, then priority, then oldest) and leaves the other Ready parents untouched.
- It sits next to `limits.max_concurrent` and does not replace it. `max_concurrent` still caps agent runs at the same time; both limits hold.
- `harnessd init` writes a commented `# max_parents = 1` line next to `max_concurrent`, and docs/CONFIG.md "Limits and token spend" describes the key. The loop reads it with the queue, wait log and dispatch filter in the rest of MET-171.

Why: the loop grilled and split every Ready parent in the same tick, so parts of two parents interleaved. `limits.max_concurrent` limits running agents, not parents. On 2026-11-23 another session moved three tickets to Ready during MET-87, MET-164 was grilled and split in parallel, and that run was wasted. The owner's rule is one ticket at a time: one PR, one review, one QA, merge, then the next ticket. The Ready column is the queue, so the owner orders the work on the board instead of holding tickets in Backlog.
