# D-063 The grill normalizes a Done-when list the plan check cannot pass

Status: accepted 2026-11-28. Issue: MET-251 (parent MET-247). Amends D-049. Extends D-022 (the reply contract) and D-011 (a reversible clarification is no trigger). D-059 is unchanged.

On 2026-11-28, MET-246 was one docs file with a size S and 5 Done-when items, and it went to Needs input. The plan check allows at most 3 Done-when items per part and rejects a docs-only part in a multi-part plan, so no valid plan existed and the plan was rejected twice. The grill saw the problem and named the fix: consolidate the five parent items into three. It could not apply it, because the coordinator is read-only (D-059), so a human edited the ticket.

## The reply key

The grill reply gains an optional `normalizedDoneWhen`: `string[]`. The grill sets it only when the filed Done-when list cannot pass the plan check: a docs-only ticket with more than 3 items, or more than 18 items (`MAX_PLAN_PARTS` x `MAX_PART_DONE_WHEN`). The list keeps every original requirement and fits the plan rules. `parseGrillReply` adds the key to `REPLY_KEYS`. It rejects an empty array and a blank entry, as it does for `terms`. A reply without the key stays valid (D-022).

## The write

The loop may rewrite the parent's Done-when list from the grill's `normalizedDoneWhen`. `replaceDoneWhen(body, items)` replaces only the checklist lines of the first Done when section, the one `parseDoneWhen` reads. It keeps the header, the text before it and every later section, and writes each item unchecked as `- [ ] <item>`. `LinearClient.updateDescription(issueId, description)` saves the new body with the existing `ISSUE_UPDATE_MUTATION`.

The loop posts one comment with the old and the new list, then plans from the new list. This amends D-049: a list the plan check cannot pass is normalized before planning, not sent to Needs input.

## Not a D-011 trigger

The rewrite is a reversible ticket clarification, so it is not a D-011 trigger. The old list stays in the comment and in Linear's description history, so a human can restore it in one edit. It costs no money and needs no secret or account. It changes no public API, no data model and no protected path: Linear text is not the repo's data model.

Why: a ticket that no valid plan can cover should be clarified, not stopped for a human. The trade-off: the coordinator changes the ticket's written acceptance criteria, so the old and new lists must stay visible in one comment. D-059 keeps the coordinator out of code, commits and PRs; this write is ticket text only.
