# D-048 A run that fails on its harness moves to the next harness in a fixed role order

Status: accepted 2026-11-23. Amends D-035. Refines D-034 and D-014.

D-035 sent a run to the fallback harness only while a usage limit held the main harness. A run that timed out, stalled, failed to sign in or crashed on its harness went back to Ready and tried the same harness again. The retry often failed the same way, and a second failure sent the issue to Needs input.

A run that hangs also kept its children alive. The kill reached only the run's own process group, so a nested process in a group of its own outlived the run.

## Decision

**Order.** The order is in code, in `coordinator/limits.ts`, keyed by role:

| Role | Order |
|---|---|
| coordinator | claude-code, codex |
| backend, frontend | opencode, codex, claude-code |
| qa | codex, claude-code |

`harnessForRun` returns the list for one run: the configured harness, then `fallback_harness` when it differs, then the role order. It removes duplicates. It drops each harness with a hold (D-034), and each harness whose latest status-engine result for `harness.<id>.installed` or `harness.<id>.auth` is fail or missing. It adds no new check per tick. An `auth` run result counts as not signed in for that issue's next try.

**Model.** `fallback_model` applies only on the `fallback_harness`. Any other harness gets no `--model`. The main model and effort are dropped on every other harness.

**Switch rule.** The switch reads the adapter result, not the shipped outcome.
- Switch on: status `timeout`, status `limited`, reason `auth`, a stall, and any other adapter error.
- Stay on the same harness: the turn cap (D-045), a ship-step failure (`no changes`, `push failed`, `pr failed`), an invalid QA verdict, and an invalid grill or plan reply.
- `RunFailureReason` gets `stalled` and `turn_cap`. `RunStatus` does not change.

**State.** `loop.json` gets the optional key `harnessSwitch`, keyed by issue id: `{ from, reason, at }`. The next dispatch picks the first usable harness after `from`. When none is usable after it, the first usable one is taken, which can be `from`. The record is deleted on an ok run, on Needs input and on Done. An old file loads. A malformed entry is dropped. A grill or plan timeout, stall or harness error records the switch on the parent. The next tick uses the next coordinator harness and wraps around. There is no new grill cap.

**No harness left.** Nothing starts and the issue stays Ready. The loop logs `<key>: no harness left (<harness> <why>, ...)` once per set of reasons. No attempt is counted and no comment is posted.

**Attempts.** Attempts are unchanged. `MAX_RUN_ATTEMPTS` stays 2. A limited run counts no attempt.

**Stall watchdog.** `startProcessRun` has `STALL_MS = 10 * 60_000`, which a test can shorten. Each event resets it. At the limit the run ends like a timeout: status `error`, error `stalled (no output for 10 min)`, reason `stalled`.

**Tree kill.** One helper lists the descendants with `ps -axo pid=,ppid=,pgid=` before the first SIGTERM. It signals the run's group and each descendant's group with the same grace, then SIGKILL. A turn cap, stall, timeout, pause, cancel, a daemon exit and the QA test command all use it.

**Log lines.** The switch line is `<key>: <from> <why>, retrying on <to>`, with display names. The reasons are `timed out`, `stalled`, `hit its usage limit`, `is not signed in` and `failed (<error>)`. It is logged when the next run starts, and it replaces the D-035 line. A hold with no earlier failure logs `<key>: <harness> is limited, running on <to>`.

**Run view.** `RunView` gets `harness` and an optional `switchReason`. The run row in the Agents view shows both.

## Why

A harness that fails once for its own reasons is likely to fail again. The next harness in the role order gives the retry a better chance. Task failures stay on the same harness, because another harness does not fix a bad reply or a cap. The tree kill stops a hung run from leaving orphans.
