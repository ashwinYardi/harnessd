# D-060 A reviewer judges each part PR head before QA

Status accepted 2026-11-27 for MET-165. Amends D-010, D-013, D-014, D-044, D-048 and D-059.

QA had to review code and verify behavior in the same run. On MET-143 those combined rounds hit the turn cap and then timed out without a verdict. The reviewer examines the code the builder actually shipped. QA verifies behavior against the part's Done when checklist.

- **D-010, team.** The reviewer is a persistent role with its own instructions. It defaults to Codex with `gpt-6.2-sol`.
- **D-013, merge gate.** Auto-merge requires the reviewer's approval and QA's approval at the current PR head, green CI and compliance with the protected-path rules. The daemon posts the reviewer's verdict as a GitHub `COMMENT` review at that head because the daemon's account opened the PR. Each blocking finding and nit includes its file and line. Nits stay on the PR.
- **D-014, limits.** A review takes one `max_concurrent` slot and uses the part's size budget. The default turn caps are 15 for S and 30 for M. Review usage counts toward the parent's weighted token budget (D-043). Settlement transport errors count no failure (D-058).
- **D-044, skill map.** The reviewer gets `code-review` and reads the parent issue, the part brief, the PR diff and the surrounding code it needs. QA focuses on functional verification.
- **D-048, harness order.** The reviewer's role order is Codex, then Claude Code, after the configured harness and fallback.
- **D-059, read-only runs.** The reviewer runs with `readOnly: true` in a scratch checkout of the PR head. Codex uses its read-only sandbox. Claude Code allows Read, Grep, Glob and Agent so the review skill can delegate under the same write restrictions. OpenCode keeps its inline denies and runs both review passes inline. The daemon supplies the diff in the prompt and removes the checkout after the run (D-041).

Review is a stage of the shipped part in **In Review**, including a QA: tests part. It uses the existing Linear issue and state. The loop dispatches review before QA for parts of admitted parents (D-050). A parent in Needs input retains its slot and its parts get no new review (D-057).

The loop records the verdict for the head in `reviewerHeads` in `loop.json`, keyed by part ID. It saves unfinished posts in `pendingReview` and retries unfinished settlement writes on subsequent ticks without rerunning the reviewer for that verdict. Both keys are optional for older state files. The loader drops malformed entries.

MET-224 implements reviewer dispatch, usage, verdict storage and PR comment settlement. Later parts enforce reviewer approval for QA and merge and handle review send-backs and escalation.
