# D-047 The QA turn cap follows the parent's size

Status: accepted 2026-11-23. Amends D-045.

D-045 set one QA cap of 40 turns for every size. On 2026-11-22, QA of a size M part (a PR with 528 added lines in 17 files) ran twice. The first run ended at 38 turns with no usable verdict. The second run stopped at the cap of 40 with no verdict. The parent went to Needs input, and about 610k weighted tokens bought no verdict.

QA runs that day took 13, 18, 38, 40 and 64 turns. The S runs fit in 40. The M runs did not.

## Decision

- QA uses **40 turns for an S parent** and **80 turns for an M parent**. A missing or unknown size counts as M, as for builder runs.
- The cap stays in code, not in config. `maxTurns(role, size, limits)` in `coordinator/dispatch.ts` is still the one place that answers.
- Coordinator grill and plan keep one cap of 50.
- Everything else in D-045 stays as written.

## Why 80

80 QA turns at the measured rate of about 9.4k weighted tokens a turn (357k over 38 turns) is about 750k. That fits the M budget of 6M next to one M build. It is half of the M builder cap, because QA reads the diff, not the whole change history.
