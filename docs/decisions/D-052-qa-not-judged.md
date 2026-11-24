# D-052 A QA run with no usable verdict is not judged; two in a row on one head go to a human

Status: accepted 2026-11-24. Issue: MET-196 (parent MET-166). Amends D-041 and D-045. References D-014, D-047, D-048 and D-051. Updates docs/LOOP.md "QA".

A QA agent run that ends on its turn cap, its time limit or a stall, or whose verdict is not valid JSON after a backslash repair, is **not judged**. It re-queues like a D-041 setup error and counts no QA failure. An in-memory count per part and PR head moves the second not-judged run in a row to Needs input with the reason, also with no QA failure. A schema error or any other agent error keeps its current rule.

## The four endings

Only these count as not judged:

- the run ends with reason `turn_cap` (D-045, D-047);
- the run ends with status `timeout`, including the `budget of <n>ms exceeded` error from `adapters/process.ts`;
- the run ends with reason `stalled` (D-048);
- `parseQaVerdict` fails at the JSON parse step, after the backslash repair. The result carries the typed `kind: "not_json"`.

Every other agent error keeps its rule: a crash, an auth error, a schema error such as the wrong item count, an unknown key or missing evidence still counts a QA failure. Only the JSON parse failure moves. A later record can widen this.

## Finding the ending

`runForReply` (`coordinator/grill.ts`) also returns the `RunResult` reason when it is `turn_cap` or `stalled`, and a `timeout` flag when the status is `timeout`. They are additive typed fields on the error reply. `parseQaVerdict` marks only the JSON parse failure with `kind: "not_json"`. `runQa` sets a new in-memory `PrReview.notJudged` field, `turn_cap | timeout | stalled | not_json`, on `decision: "error"`, next to `setup`. `decideReview` does not change: a failing `qa.test_command` is a real verdict and still requests changes.

No `loop.json` key changes and no public API changes. The reason fields live in memory only.

## The backslash repair

The repair runs only after the first `JSON.parse` fails. It scans the text left to right inside JSON strings. A backslash before a character outside `" \ / b f n r t u` becomes an escaped backslash plus that character, for example a backslash and a backtick, or a backslash and a dollar sign.

- A valid pair such as `\\` or `\"` is consumed as one pair and does not change. So `\\` followed by a backtick stays as it is.
- `\u` with bad hex is not repaired; the run is not judged as `not_json`.
- The repair applies to the extracted text and to each trailing-object candidate, so a verdict in prose with a bad escape is still found.
- It runs inside `parseQaVerdict` only. The grill and plan parsers do not change.

The parse failure after the repair returns `{ ok: false, kind: "not_json", error: "not JSON: <message>" }`. Schema errors stay plain errors without a kind.

## The first not-judged run

It is like a D-041 setup error. `settleQa` returns `'requeued'`, QA moves back to Ready, and `qaFailures` does not change. Nothing goes to `reviewedHeads`, so the same head gets QA again. No Linear comment, no review post and no notice. The log line is:

`<QA key>: QA not judged (<reason>), re-queued`

with `<reason>` one of `turn cap (<n> turns)`, `timed out`, `stalled` or `verdict not JSON: <error>`.

A round that mixes a setup error and a not-judged review treats both as "no verdict": when no review asks for changes and every review that is not approved is a setup error or not judged, the round is re-queued. A round with any `request_changes` counts one failure, as before. Approved parts in the same round still go to merges.

## The count and the escalation

The count is in memory in `qa.ts`, a map of part id to its head, count and reasons, like the D-051 app setup count (`countAppSetupFailure`). A restart resets it, which costs at most one extra QA run. `loop.json` keeps its shape.

- The count goes up on each not-judged review on that head.
- A judged verdict (approve or request_changes) clears it.
- A new head starts it at one.
- A D-041 setup error neither adds to it nor clears it, because nothing was judged.
- An escalation clears it, and the test reset helper clears it.

The second not-judged run in a row on the same head returns `'escalated'`. QA and the parent move to Needs input. One comment on the parent states the reason, for example:

`QA was not judged twice on <part key> PR #<n> at <head7>: turn cap (80 turns); timed out. No QA failure counted.`

One `needs_input` notice goes out with reason `QA not judged twice`. `qaFailures`, `qaFeedback` and the part's session do not change, because no failures are known.

## What does not change

- **Turn caps and time limits.** QA stays 40 turns for S and 80 for M (D-047). The QA round still uses the QA sub-issue's size budget. Tighter caps and a shorter prompt are out of scope.
- **Harness switch (D-048).** A timeout or a stall still records a switch for the QA sub-issue, so the retry runs on the next QA harness. A turn cap and an invalid verdict stay on the same harness.
- **Usage.** `recordUsage` runs as today, and the tokens go into the parent's usage sum and weighted budget (D-043). Only the QA failure count changes.
- **A limited QA run (D-034).** It re-queues with no failure and does not touch the not-judged count.

## Why

On MET-143, QA ran twice with no verdict: first it hit the 40-turn cap, then it timed out after about 2 hours. Both counted as QA failures under D-041, so the parent went to a human although nobody had judged the work. On 2026-11-24, QA on PR #92 (MET-188) passed every item, but the verdict held a backslash before a backtick and the loop counted a QA failure.

Once the reviewer owns code review (MET-165), QA only checks that the work does what "Done when" says. A run that QA could not finish says nothing about the PR, so it must not count. The cap of two stops an endless re-queue loop, and the in-memory count keeps `loop.json` unchanged, as D-051 did.

## Consequences

- D-041: invalid JSON and a timeout no longer count a QA failure. Its setup-error re-queue rule, its log line and the `settleQa` `'requeued'` path apply unchanged.
- D-045: a turn-capped QA run no longer counts a QA failure; the cap itself is unchanged.
- D-014: only real review verdicts, schema errors and the other agent errors feed the two-failure escalation.
- docs/LOOP.md "QA" gets a "not judged" row, the repair and the second-in-a-row escalation, and its turn-cap text no longer says a capped QA run counts a failure.
