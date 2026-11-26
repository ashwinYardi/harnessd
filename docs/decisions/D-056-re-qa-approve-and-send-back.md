# D-056 A re-QA approves on its cases, sends back only still-failing cases, and clears cases on escalation

Status: accepted 2026-11-26. Issue: MET-205 (parent MET-202). Amends D-052 (a not-judged escalation now clears the saved cases), D-055 (the approve rule, the review text and the send-back) and D-040 (`reviewedHeads` approved with no cases and the same-head rule). References D-013, D-014, D-046 and D-054.

D-055 fixed the re-QA trigger, its prompt and its per-case verdict. This record fixes what that round decides and what it leaves in `loop.json`.

## Approve

A re-QA approves only when all of these hold:

- every saved case passes;
- the `verify` result passes;
- `qa.test_command`, after `qa.setup_command`, exited 0.

An approval writes `reviewedHeads[part]` as approved with no cases and follows the approved path to `merges`. The same-head rule does not change: an approved head is not reviewed again.

## Review

The posted review lists every saved case as `C<n> (<item>): pass: <evidence>` or `C<n> (<item>): fail: <evidence>`, plus a `Verify` line with its result. On approval the body says every saved case passes and the test command passed; on a send-back the failing cases are listed before the passing ones, as today.

## Send-back

A failing re-QA sends back only the saved cases that still fail. Each keeps its `id`, `item`, `repro` and `expected`, and gets the new `actual` from its evidence. A failing test or a failing `verify` keeps or adds daemon case `T1` with item `Tests` or `Verify`. The re-QA adds no other case.

The failed round counts one QA failure as today, so with `qa_max_failures` 2 the second failed round moves QA and the parent to Needs input (D-014).

## Case clean-up

- An approval writes `reviewedHeads` approved with no cases.
- A QA escalation and a not-judged escalation (`qa.ts`) delete the part's cases from `reviewedHeads` and `qaFeedback`, keeping the entries.
- A merge-gate escalation (`merge.ts`) does the same.
- A merge-gate send-back writes no cases, so its next QA is a full round.
- A part that reaches Done drops its record as today.

So after a human moves a part back, its next QA is a full round.

## Why

On 2026-11-26, PR #97 (MET-200) took 4 QA rounds. Each full round found one more edge case, so the work never settled. D-054 to D-055 bound the re-QA to the saved cases and the earlier tests. Without an approve and send-back rule, a re-QA could still reopen the whole review, and stale cases could follow a part through an escalation.

## Consequences

- D-052: on a not-judged escalation, `qaFeedback` keeps its failing list but loses `cases`, and `reviewedHeads` loses `cases`. The in-memory not-judged count and the part's session still do not change.
- D-055: the approve rule and the send-back are now specified.
- D-040: an approval stores no cases, and a same-head approval is still not reviewed again.
- `docs/LOOP.md` "QA" and "Merge" describe the rule.
