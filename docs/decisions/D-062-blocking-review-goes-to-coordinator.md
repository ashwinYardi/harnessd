# D-062 A blocking review goes to the coordinator

Status: accepted 2026-11-28. Issue: MET-244 (parent MET-241). Amends D-059 (a design finding no longer goes straight to Needs input) and D-014 (a changes_requested review uses `limits.max_review_rounds`, default 6). D-060 and D-061 are unchanged except for the design line; the re-review trigger keeps reading `reviewFailures`, which now counts judged rounds.

On 2026-11-27, MET-239 stopped in Needs input after each of six review rounds. Two rules routed a review past the coordinator: a blocking `design` finding went straight to the owner (D-059), and a second failed review escalated (D-014). Each time a human did the coordinator's job by hand: read the findings, write a fix hint and send them to the builder's session. That breaks the loop's promise that a ticket ships with no human help.

The coordinator manages the conversation between the team and delegates to the right team member's thread. A blocking review is a message to the coordinator, not a decision for the owner. This record is the review slice of MET-207.

## Route

Below the round cap, every `changes_requested` verdict takes one coordinator review decision before the first Linear write:

- **fix.** The coordinator writes one non-empty hint per open blocking finding. `settleReview` sets `qaFeedback` with `source: "review"`, the numbered findings and their hints, and moves the part to Ready. Its next run resumes the builder's own session when D-046 allows it, otherwise it starts cold, and the resume prompt carries each finding and its hint.
- **escalate.** The coordinator asks the owner only under a D-011 trigger. The parent comment carries the trigger, the question, the options and the recommendation. Both issues move to Needs input and one `needs_input` notice goes out.

A design finding alone is no trigger. It takes the coordinator's fix like any other blocking finding, and escalates only when the fix needs a public API, the data model, a protected path, a secret or an account change, money, an irreversible step, or a taste call with no precedent in the spec. That amends the D-059 rule that sent a design finding straight to Needs input.

The decision is written to `pendingReviewSettle` in `loop.json` before the first write. A restart replays it with no second coordinator run and sends the notice once. A settlement from before this record that posted its parent comment but stopped is recognized from that saved step and finishes only its remaining moves and notice, even when it has no verdict. An unusable reply, a failed or limited run, or an escalate reply without a D-011 trigger falls back to a fix send-back with no hints; the verdict still counts one review round.

## Round cap

`limits.max_review_rounds` is a positive integer, default 6, merged per layer like the other `limits` keys (see D-050 for the key pattern). It counts `changes_requested` reviews per part in `reviewFailures`, which now means judged rounds. A new `reviewRunFailures` entry counts failed review runs with no verdict, so the two caps never consume each other's events: one failed run and five blocking verdicts stay five rounds, and one blocking verdict plus the first failed run stays one failure. A state file from before this record has a mixed `reviewFailures` count that cannot be split, so the loader drops its magnitude instead of turning old failed runs into rounds. A completed send-back with saved blocking findings keeps one round, so its next head is still a re-review (D-061); any pending settlement, even one with both send-back steps, stays at 0 and its replay counts that verdict once, and every other part gets a fresh round count and may see one full review on upgrade.

At or over the cap, the loop starts no coordinator run. It saves the cap on the pending settlement before the first Linear write, so a retry sends the same reason and never reads the started escalation as a legacy one. It then escalates with the existing `escalate()`: one parent comment says the review sent the part back `<n>` times, hit `limits.max_review_rounds` and lists the open findings; both issues move to Needs input; one `needs_input` notice goes out with the reason `review round cap reached`; and `reviewFailures`, `reviewRunFailures` and `qaFeedback` are cleared, as an escalation does today.

The cap applies only when the loop chooses a new settlement. A saved coordinator decision is honored on replay, so a saved fix still sends back even when the cap was lowered below the current round, and the fix synthesized for a started legacy send-back stays a fix. Only a saved cap decision escalates for the cap.

`limits.qa_max_failures` no longer applies to a `changes_requested` review. It still applies to QA, the merge gate and a review run that gives no verdict, which keeps the D-014 failed-run rule.

## Unchanged

D-060 (the review run, delta review and verdict) and D-061 (the re-review) keep their rules. Their only change is the design line: a new blocking design finding in a re-review takes the coordinator route above instead of escalating by itself. The re-review trigger still reads `reviewFailures`, which now holds judged rounds.

Why: a human was the hidden cost of every review round, and six rounds became six human decisions. Fix hints are the same work either way; the coordinator can do it read-only, in the open, and only asks the owner when the fix crosses a D-011 line. The trade-off: a fix decision costs one coordinator run per review round. The round cap bounds that spend, and a resumed builder session keeps the fix cheap (D-046).
