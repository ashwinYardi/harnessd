# D-041 A QA checkout is never kept; a QA setup error counts no failure
Status: accepted 2026-11-22. Issue: MET-135 (parent MET-127). Amends D-039 and refines the QA failure count in D-014. Updates docs/LOOP.md "Dispatch" and "QA".

**The keep guard and sync output.**
- The guard reads the run's excludes file, the same file the ship step commits with. Files the worktree sync wrote, `.agents/` and every other sync output path, are invisible to the dirty check.
- Every guard call that has a run id passes `excludesFileFor(globalDir, runId)`. There is no hard-coded path list.
- A worktree whose only changes are sync output is removed.

**QA worktrees are never kept.**
- QA does not ship work, so its PR-head checkout is removed after the round even when it has uncommitted changes or commits no remote holds.
- The QA PR-head checkout bypasses the keep guard in four places: the teardown after a review, the loop crash re-queue for a QA entry, the removal of an old checkout at QA dispatch, and `checkoutWorktree` when a registered checkout already sits at its path. `checkoutWorktree` is used only for QA PR heads, so it always replaces the old checkout.
- A pause still keeps the QA checkout for inspection (MET-15, D-039). The next QA dispatch then removes it without the guard.
- The `scratch` removal option and the `git ls-remote` branch of the keep guard are gone, because no caller is left. A normal part checkout keeps unshipped work as before.

**A QA setup error counts no failure.**
- `PrReview` carries an in-memory `setup` marker on `decision: "error"`. It is set when QA cannot set up the review: the PR lookup or checkout failed, the worktree sync failed, the QA budget ran out before the agent ran, or an unexpected throw happened in the setup phase.
- A missing PR stays `request_changes`. A failing `qa.setup_command` or `qa.test_command` stays a test result for `decideReview`.
- An agent run with invalid JSON, the wrong item count, an error or a timeout still counts a QA failure.
- `settleQa` returns `requeued` when no review asks for changes and every review that is not approved has a setup error. QA moves back to Ready, `qaFailures` stays the same, nothing goes to `reviewedHeads`, no Linear comment is posted and no notice is sent. Approved parts in the same round still go to `merges`.
- A round that mixes a setup error with `request_changes` counts one failure, as before.
- The log gets one line: `<QA key>: QA not judged (<reason>), re-queued`. `loop.json` keeps its shape. There is no retry cap.

Why:
- On 2026-11-22 QA round 1 of MET-125 kept its worktree `met-125-pr-65` for "uncommitted changes". The only change was `.agents/skills`, which the worktree sync writes. Round 2 then could not check out the same PR because that worktree was kept, and the loop counted the checkout error as the second QA failure and moved MET-123 and MET-125 to Needs input. No one had judged the fix.
- Sync output is not the agent's work. The ship step already excludes it; the keep guard must read the same file.
- A QA checkout is a read-only copy of a PR head. Keeping it never protects work, and it blocks the next round.
- A checkout or setup error says nothing about the PR. Counting it toward D-014 sends a healthy parent to a human for a problem the loop can retry.

Consequences:
- D-039 keeps its keep guard for part runs; its scratch-checkout paragraph is superseded here.
- D-014 counts only real review verdicts toward `limits.qa_max_failures`.
- docs/LOOP.md "Dispatch" states that a QA checkout is never kept and that the guard reads the run's excludes file. "QA" describes the setup-error row and keeps the invalid-verdict rule.
