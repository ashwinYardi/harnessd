# D-054 A QA verdict records each failing case; a request-changes verdict with no case is not judged

Status: accepted 2026-11-26. Issue: MET-203 (parent MET-202). Amends D-052 (the not-judged reason `no_cases`), D-046 (the send-back prompts carry the cases) and D-040 (`reviewedHeads` keeps the cases, for the later part). References D-014, D-041 and D-053.

A request-changes verdict used to carry only a prose line per failing item. The builder could not see the exact command or steps that reproduced the fault, so every QA round started a full new check and often found one more edge case. QA now records each failure as a **case**. The builder fixes only those cases, and a re-QA checks them plus the part's earlier tests.

This record covers the whole feature. MET-203 builds the verdict cases, the no-case rule, the state, the send-back list and the C1 and C2 fixes. The re-QA trigger, prompt and verdict, `ReviewedHead.cases` and its write in `loop.ts`, and the clean-up of cases on escalation are the next parts.

## The case

The QA verdict gets one top-level `cases` array next to `items` and `testsPassed`:

```json
{
  "items": [{ "text": "…", "pass": true, "evidence": "…" }],
  "testsPassed": true,
  "cases": [
    {
      "id": "C1",
      "item": "…",
      "repro": "…",
      "expected": "…",
      "actual": "…"
    }
  ]
}
```

- Every field is a non-empty string.
- `id` is `C1`, `C2`, … in reply order.
- `item` is the exact `text` of a verdict item whose `pass` is false, or `Verify`.
- `repro` is the exact command or numbered steps that reproduce the failure.
- `expected` is what should happen; `actual` is what happened.
- When every item passes the array is empty: `cases: []`.

A missing or empty field, an unknown key, an id out of order, or an `item` that names no failing verdict item and is not `Verify` is a **schema error**. It counts a QA failure, as D-052 says for every schema error. A missing `cases` array is also a schema error; the prompt asks for it on every reply.

## A request-changes verdict with no case

A QA **agent** verdict that requests changes with `cases: []` is **not judged**:

- `PrReview.notJudged` gets the new reason `no_cases`;
- the log reason is `verdict has no failing case`;
- the round re-queues with no QA failure and no review post;
- it feeds the existing in-memory not-judged count, so a second one in a row on one head moves QA and the parent to Needs input (D-052).

The rule applies only to the agent's verdict. A schema error still counts a failure. A verdict the daemon builds itself, and a missing PR, are not affected.

## The daemon-built case T1

When the daemon requests changes itself, it builds case `T1`:

- `qa.test_command` fails: `item` is `Tests`;
- a `QA: tests` part's Verify command fails: `item` is `Verify`;
- `repro` is the command;
- `expected` is `exit 0`;
- `actual` is the exit code, or `timed out`, plus the test tail up to `MAX_TEST_TAIL`.

A missing PR keeps today's failing line and gets no case, because the fix is to open the PR, not to change code.

## State

`QaFeedback` gets an optional `cases` array with the same shape. `settleQa` saves the review's cases next to `failing` and `testTail`. An old `loop.json` loads unchanged, and a malformed case drops the `cases` array, not the entry.

`ReviewedHead` gets the same optional `cases` array in the later part, so a re-QA can read the cases after the builder's ok run deletes `qaFeedback` (D-040). Both keys are additive and optional, the same pattern as D-046 sessions and D-048 `harnessSwitch`.

## The send-back prompt

`buildPartPrompt` and `buildResumePrompt` replace their bullet list with a numbered fix list:

```text
1. C1 (It has tests)
   repro: pnpm test -- avatars
   expected: the avatar test passes
   actual: not ok 3 - avatars
```

They say: fix only these cases, add one test per case, then run the part's Verify commands. The resumed prompt also lists the part's Verify commands from the part body, because it carries no brief. When the feedback has no cases, both prompts keep today's `failing` list. `testTail` and the send-back detection on `qaFeedback` stay (D-046).

## The re-QA (the next part)

**Trigger.** A new head on a part whose reviewed head is `changes_requested` with cases starts a re-QA, not a full QA. It checks only the recorded cases and the part's earlier tests. A part with no recorded cases, or an approved part whose head did not change, keeps today's rule.

**Verdict.** The re-QA reply names each earlier case and says whether it now passes, plus the test result:

```json
{
  "cases": [{ "id": "C1", "pass": true | false, "evidence": "…" }],
  "testsPassed": true | false
}
```

It approves only when every case passes and the tests pass. Otherwise it sends the part back with the still-failing cases, as the cold prompt does. A re-QA that cannot judge follows D-052, and QA turn caps, time limits and the D-048 harness order do not change.

## Clean-up on escalation

When the second failure moves QA and the parent to Needs input, the part's `qaFeedback` (including its cases) and `ReviewedHead.cases` are deleted with the entry, and nothing is sent back again (D-014). A part that merges, or reaches Done, drops them too. The last part implements this.

## C1 and C2

- **C1.** `runQaTests` checks `deadline - now()` before each step. At 0 or less the step does not start, and the run returns `passed: false`, `timedOut: true` and `exitCode: null` for that command. The `Math.max(deadline - now(), 1)` allowance is gone. The `QA: tests` Verify runner already used the same rule, because it shares the round's budget (D-014, D-053).
- **C2.** `evidenceLine` reads code spans as CommonMark does. A run of N backticks opens a span and the next run of exactly N closes it. Whitespace inside the span stays as written; whitespace outside collapses to one space. A backtick run that never closes is plain text.

## Why

On 2026-11-26, PR #97 (MET-200) took 4 QA rounds. Each round ran a full new check and found a new edge case, so the work never settled. The findings were valid; the flow was wrong. The owner's direction: QA records the exact failing test cases and how to reproduce them, the coordinator sends them back, the builder makes targeted fixes, and QA only checks the fixes and the earlier tests once, quickly.

C1 and C2 surfaced in the same work. A step that started after the shared deadline got a fresh 1 ms allowance, so it ran outside the round's budget. Evidence with two backticks around a span holding two spaces lost one space.

## Consequences

- **D-052.** `no_cases` joins `turn_cap`, `timeout`, `stalled` and `not_json` on `PrReview.notJudged`, and uses the same count, re-queue and escalation.
- **D-046.** The cold and resumed send-back prompts carry the cases as a numbered fix list; the resumed one also lists the part's Verify commands.
- **D-040.** `QaFeedback.cases` and, in the later part, `ReviewedHead.cases` are additive optional keys. `loop.json` stays backward compatible.
- **D-014.** C1 keeps setup, tests and Verify inside one round deadline. The C2 fix changes only how evidence is rendered.
- `docs/LOOP.md` "QA" describes the case fields, the T1 case, the `no_cases` row and the numbered send-back list.
