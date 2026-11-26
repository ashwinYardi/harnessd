# D-055 A re-QA gets only the saved cases and commands, and returns a per-case verdict

Status: accepted 2026-11-26. Issue: MET-204 (parent MET-202). Amends D-054 (the re-QA verdict and its trigger), and adds to D-040 (`ReviewedHead.cases`). References D-044, D-051, D-052 and D-053.

D-054 recorded each failing item as a case and saved the cases for the next round. This record fixes how that next round runs: it detects a re-QA from the reviewed head, gives the QA agent only the cases and commands, and checks a strict per-case verdict.

## Trigger

A round for a part is a re-QA when all of these hold:

- `reviewedHeads[part.id]` has verdict `changes_requested`;
- its `cases` array is non-empty;
- its sha differs from the PR's current head.

Otherwise the round is a full round 1. That covers an old entry with no cases, a missing-PR send-back and a merge-gate send-back. A part whose body says `**QA**: tests` reruns its Verify commands as today, with no agent (D-053).

## State

`ReviewedHead` gets an optional `cases` array with the same entries as `QaFeedback.cases`. `loop.ts` writes it when QA's verdict is `changes_requested`, so it survives the builder's ok run that deletes `qaFeedback` (D-046). An approval writes no cases. Both keys are additive and optional: an old `loop.json` loads, and a malformed case drops the `cases` array, not the entry.

## Prompt

The daemon still runs `qa.setup_command` and `qa.test_command` first. When `[qa]` sets `kind` and the part is `QA: agent`, the live app and browser start with the D-051 rules unchanged: the app is the environment of a repro.

The agent's prompt holds only:

- the PR and its head;
- each saved case with its `repro`, `expected` and `actual`;
- the part's Verify commands;
- the test command with its result;
- the running app, when there is one.

It holds no diff, file list, part brief, Done-when list, decisions or memory (D-044). It tells QA to run each repro and each Verify command, judge each saved case pass or fail, and write no new probes. The reply cannot add a case.

## Verdict

```json
{
  "cases": [{ "id": "C1", "pass": true | false, "evidence": "…" }],
  "verify": { "pass": true | false, "evidence": "…" }
}
```

The reply has exactly one entry per saved case id. A missing id, a duplicate id, an id not in the saved set, an unknown key or empty evidence is a schema error, and counts a QA failure (D-052). Invalid JSON after the escape repair, a turn cap, a timeout and a stall stay not judged. The test result is the daemon's own run; `verify` is the result of the part's Verify commands.

## What is next

The re-QA approve rule, the per-case review text, the send-back of still-failing cases and the clean-up on escalation are a later part of MET-202. The QA turn caps, time limits and the D-048 harness order do not change.

## Why

On 2026-11-26, PR #97 (MET-200) took 4 QA rounds. Each full round found one more edge case, so the work never settled. Pinning the next round to the recorded cases and the earlier tests bounds the work. A re-QA can still miss a regression outside the cases; the repo tests and the Verify commands guard it, and the reviewer owns code review.

## Consequences

- D-054: this record replaces its re-QA verdict (`verify` in place of `testsPassed`) and its trigger wording.
- D-040: `ReviewedHead.cases` is an additive optional key; `loop.json` stays backward compatible.
- D-052: a re-QA schema error counts a failure, and a reply that is not JSON after the repair is not judged.
- `docs/LOOP.md` "QA" describes the trigger, the prompt and the verdict.
