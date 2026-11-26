# D-057 A split parent in Needs input keeps its max_parents slot

Status: accepted 2026-11-26. Issue: MET-209 (parent MET-190). Amends D-050 (a parent is in flight until Done, Canceled or Needs input). References D-043, D-044 and D-022.

A parent with a split record in `loop.json` holds its `max_parents` slot from its grill until Linear shows it Done or Canceled. Needs input no longer ends the slot.

- `endsParentSlot` returns true only for Done and for a canceled state (`isCanceledState`). `inFlightParents` returns a parent in Needs input with a `needsInput` flag, and `repairSplits` still drops a record only at Done or Canceled.
- A parent with no split record holds no slot. A grill escalation or a second bad plan writes no record, so that parent does not block the queue and the loop moves on to the next Ready parent.
- While a split parent waits in Needs input, none of its parts or QA start, even when it is admitted. `dispatchEligible` skips them with no move and no comment, and logs the wait line with the part or QA key.
- The wait line names a Needs-input holder as `<key> waits, <parent> needs input`. Two or more such holders join with `, ` and the line says `need input`. A holder that is not in Needs input keeps `is in flight` or `are in flight`. With mixed holders, the two clauses join with `, `.
- The dedup key in the `waited` map includes each holder's Needs-input flag. A move from in flight to Needs input logs once more, and a tick with the same set logs nothing.
- A split record keeps its first `at` time when the parent goes back to Ready. Keeping that time on a re-split is the next part of MET-190, not this record.

Why: On 2026-11-24, MET-169 went to Needs input, and the freed slot let MET-185 be grilled and split. When MET-169 came back, two split parents were in flight with `max_parents = 1`, which broke D-050's one-ticket-at-a-time rule. The trade-off: the queue can stall on an owner answer, and that is accepted over interleaved parents.

## Consequences

- D-050: the "until it is Done, Canceled or Needs input" rule and the wait-line text are replaced by the rules above.
- `docs/LOOP.md` "Split" and "Dispatch" describe the slot rule, the dispatch skip and the new wait line.
- SPEC "Limits" says that a parent in Needs input keeps its slot.
- The workspace glossary note "Parent in flight" is not edited (D-022). This record states the new meaning.
