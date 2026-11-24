# D-053 A part whose Done-when items are proved by its Verify commands gets QA from those commands

Status: accepted 2026-11-24. Issue: MET-199, part of MET-198. Amends D-013, D-049 and D-051. References D-014, D-041 and D-044.

A part can now be approved by the daemon running its own Verify commands, with no QA agent. The planner marks such a part, the plan check rejects a mark it cannot support, the split writes the mark into the part body, and `qa.ts` reads the mark and produces the verdict.

## The mark

The plan reply gets one optional field per part, `"qa": "tests" | "agent"`. A missing field means agent QA. A value other than `tests` or `agent` is a plan shape error, so the plan goes back to the coordinator once under the D-049 plan-check rule. The split writes one line into the part body, right after **Verify** and before **Out of scope**:

```
**QA**: tests
```

or `**QA**: agent`. `qa.ts` reads that line from the part body. A part body without a QA line, including one from before this record, gets agent QA. No `loop.json` key is added.

## Who decides tests

The plan prompt tells the coordinator to set `"qa": "tests"` only when both hold:

- every Done-when item of the part names a Verify command that proves it by exit code;
- the part has no UI work and no item that needs a running app, a browser or a viewport.

In every other case it sets `"agent"`. The coordinator judges this from the item text and the files. The loop does not parse Done-when text.

## The plan checks

`checkPlan` rejects `"qa": "tests"` in two cases:

- a frontend part, with `<path>.qa: a frontend part needs agent QA`;
- a part with no Verify command, with `<path>.qa: a part with no Verify command needs agent QA`.

A rejected plan goes back to the coordinator once with every error (D-049). A second bad plan moves the parent to Needs input. A backend part with a live-app item is left to the planner: the loop cannot read intent from item text.

## The QA round

For a `**QA**: tests` part, the daemon runs the part's Verify commands and approves when every command exits 0. A failing command requests changes and carries the failing command's line and test tail. The round starts no app and no browser, makes no adapter call and runs no QA agent. A `**QA**: agent` part keeps today's QA round, including the D-051 live app when `[qa]` sets `kind`.

QA still approves every Done-when item of the part, so the merge gate (D-013) is unchanged: the daemon's verdict is that approval. Only the source of the verdict moves. `qa.test_command` remains the first check of the round; a failing `qa.test_command` is still a test result, not a setup error (D-041, D-051).

## Why

On 2026-11-24 MET-196 (a backend part, all tests) needed three QA agent rounds. Two timed out on the model with no usable verdict. Each round took up to 30 minutes, while the part's Verify commands run in under a minute. A QA agent adds value only where a test cannot check the work, such as a page at 390 px or a running app. The owner wants fewer rounds without new machinery.

## Consequences

- D-013: the daemon can give the QA approval from tests with no agent. The merge gate still requires QA approval of every Done-when item.
- D-049: the plan part shape gets the optional `qa` field, the part body gets the **QA** line, and the plan check gets the two rules above. The one send-back rule is unchanged.
- D-051: a `QA: tests` part runs no product, starts no app and opens no browser. The live-app rule still applies to `QA: agent` parts.
- D-044: the **QA** line sits between **Verify** and **Out of scope**; a builder or QA run that reads the part body sees it there.
