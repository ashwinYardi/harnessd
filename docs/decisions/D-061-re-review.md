# D-061 A re-review checks only the saved findings and the delta

Status: accepted 2026-11-27. Issue: MET-234 (parent MET-231). Amends D-060 (the review run) and follows D-055 and D-056 (the re-QA pattern). References D-014, D-041, D-044 and D-059.

A review that sent a part back finds one more, rarer fault on every full delta round. MET-230 took four review rounds that way. This record bounds the next round the way D-055 and D-056 bound a re-QA: it checks the saved findings and the code that changed since the last review.

## Trigger

A review run is a re-review when all of these hold:

- `reviewerHeads[part.id].verdict` is `changes_requested`;
- it has at least one blocking finding;
- its sha differs from the PR's current head;
- `reviewFailures[part.id]` is above 0.

Any other case keeps the earlier behaviour. A first review gets the full diff, and a new head after a reviewer approval gets the delta review. A part that escalated has no `reviewFailures` entry, because escalation deletes it, so its next review is a full first review.

## Prompt

The agent header and the PR head stay. The prompt holds:

- the `Delta since the last review`;
- each saved finding as `R<n> (file:line) text`, in `reviewFindingList` order, the same ids the builder's send-back uses;
- the part's Goal, Done when and Verify;
- the re-review rules: judge each saved finding fixed or not fixed; raise a new blocking finding only for delta code that breaks a named Done-when item; mark any other new finding as a nit.

It leaves out the full PR diff, the parent body and the senior-dev rubric, because the rubric invites a full new review. Memory stays when the loop synced it.

## Verdict

```json
{
  "decision": "approve" | "changes_requested",
  "saved": [{ "id": "R1", "fixed": true | false, "evidence": "…" }],
  "findings": [
    { "file": "string", "line": 1, "severity": "blocking" | "nit", "kind": "code" | "design", "text": "string", "item": "a Done-when item" }
  ]
}
```

`saved` has exactly one entry per saved id. A missing, duplicate or unknown id, an unknown key or empty evidence is a schema error. `item` is allowed only on a new blocking finding, and must be the exact text of one of the part's Done-when items. Invalid JSON after the escape repair stays `not_json` (D-052). A first review keeps the earlier shape and parser.

## Enforcement

The prompt asks for the delta-only rule and the parser enforces it. A new blocking finding becomes a nit, with one log line, when its `item` is missing or names no part Done-when item, or when its `file` is not a file the delta changes.

A saved finding marked not fixed is carried forward as a blocking finding with its original file, line, text and kind, and its new evidence. `decision` must agree with the result: approve only when every saved finding is fixed and no blocking finding is left after the changes to nits. Otherwise it is a schema error. A new blocking design finding in the delta still escalates by the D-059 design rule.

## No delta

`gitDelta` returns undefined when the old head is not an ancestor of the head or git fails. The run then falls back to the full review with the earlier blocking findings listed, and the loop logs `<key>: no review delta, full review`. The daemon never force-pushes, so this case is rare.

## Saved and posted

`reviewerHeads[part]` gets the new sha. On approve it stores the nits only. On changes_requested it stores the findings still open: the saved findings not fixed, the new blocking findings and the nits, so a later re-review numbers them again. The PR comment lists each saved finding as `R<n> (file:line): fixed: <evidence>` or `not fixed: <evidence>`, then any new blocking findings and nits. The send-back to the builder lists only the blocking findings still open. A changes_requested re-review counts one review failure, so with `qa_max_failures` 2 the second failure escalates (D-014).

QA, the first review, severity tiers, caps and turn caps do not change. A re-review adds no state key.

## Why

On 2026-11-27, MET-230 took four review rounds. Each delta review fixed its last finding and then found a new, rarer failure path in the same area. The re-QA rule already bounds QA (D-055, D-056); this record applies the same bound to review. The trade-off: a re-review can miss a fault outside the delta or the Done when. The repo tests, QA and the nits on the PR cover that risk.
