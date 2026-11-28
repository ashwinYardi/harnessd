# Dogfood: the first two self-builds

On 2026-11-20 (UTC), harnessd built two of its own issues. This page records what broke. All times are UTC.

## Self-builds

| Issue  | Ready        | Split (UTC) | Parts                     | PRs merged                                                                                                                                       | Done (UTC) | Loop time     |
| ------ | ------------ | ----------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- | ------------- |
| MET-35 | 16:20        | 16:38:25    | MET-37, MET-38, QA MET-39 | [ashwinYardi/harnessd#30](https://github.com/ashwinYardi/harnessd/pull/30) 16:43:45, [ashwinYardi/harnessd#31](https://github.com/ashwinYardi/harnessd/pull/31) 16:46:46 | 16:46:50   | about 8.5 min |
| MET-36 | not recorded | 16:49:01    | MET-40, MET-41, QA MET-42 | [ashwinYardi/harnessd#33](https://github.com/ashwinYardi/harnessd/pull/33) 16:54:46, [ashwinYardi/harnessd#32](https://github.com/ashwinYardi/harnessd/pull/32) 16:55:16 | 16:55:19   | about 6 min   |

Loop time runs from the split to Done.

## Breaks

1. **Start stayed disabled after a key save.** The owner saved the Linear key in Settings. Start stayed disabled after that. `/api/loop` kept the blocking list from daemon start. A service restart was the workaround. The MET-35 loop started at 16:37, after that restart.
   - Status: fixed by MET-36 (MET-40, MET-41).
2. **QA cannot approve its own PR.** QA sends an APPROVE review, and GitHub returns HTTP 422. One GitHub account cannot approve its own PR. QA posts a comment instead. Main requires only the `ci` check. The gate still merges the PR. The approval is cosmetic.
   - Status: open. The fix is a separate GitHub identity for agents. No issue for it exists yet.
3. **Two parallel parts edited one file.** In the MET-35 self-build, two parallel parts both edited docs/INSTALL.md. PR #31 conflicted after PR #30 merged. The gate sent PR #31 back. The backend agent rebased it in about 1 min. QA ran again, and the gate merged it.
   - Status: recovered, at a cost of about 3 min.
   - Open follow-up: grill gives parallel parts separate files, or chains parts that share a file.
4. **No Slack post went out.** Nobody saved a webhook for these self-builds. With no webhook, harnessd uses NullNotifier (D-021).
   - Status: as designed. The owner saves a webhook in Settings (D-030).
5. **The from-source rebuild failed under Node 22.** The shell had an nvm default of Node 22. The rebuild did not find `@typescript/typescript-darwin-x64`. The rebuild passed under Node 24.
   - Status: fixed. The MET-35 README guard (MET-37) catches Node 22 at install.

## v0.1.0 self-hosting run (2026-11-26 to 2026-11-28)

From 2026-11-26 to 2026-11-28, harnessd ran a self-hosting run and shipped eight parents. Times are not recorded.

### Parents shipped

- MET-165: a reviewer agent reviews each PR's code like a senior dev.
- MET-184: a network error never counts as a QA error, and the daemon's Linear writes retry.
- MET-170: a split reuses only the parent's live parts from its current plan.
- MET-164: the coordinator never edits code, and a failed QA or review goes back to the builder.
- MET-231: a not-judged review escalation survives a daemon restart and a re-review.
- MET-236: the health-by-path QA app test passes reliably on CI.
- MET-195: the QA sandbox scripts never delete files in a real harnessd home.
- MET-241: a blocking review goes to the coordinator, which sends the builder a fix.

The run merged PRs [ashwinYardi/harnessd#104](https://github.com/ashwinYardi/harnessd/pull/104) to [ashwinYardi/harnessd#125](https://github.com/ashwinYardi/harnessd/pull/125).

### What broke

| Break | Cause | Fix (issue) |
| --- | --- | --- |
| A Linear network error left a part In Progress. | The request failed before the loop could settle the part. A human restarted the daemon to recover. | MET-184 |
| Two long M builds stopped emitting events. | OpenCode went silent for no recorded reason. The watchdog ended both stalled OpenCode runs, and the loop retried them on Codex. | MET-121 (the watchdog and harness switch; the runs were MET-224 and MET-226) |
| Live QA could not check Linear in the sandbox. | The sandbox has no secrets (D-051), so the running product had no Linear access. | MET-229 |
| A MET-225 run used all its turns. | The turn allowance ran out before the run finished. | MET-142 (per-role caps) |
| PR #114 merged with blocking reviewer findings. | The merge gate did not yet need a reviewer approval. | MET-226 and MET-230 |
| Review took many rounds: four on MET-230 and seven on MET-239. | Each new review found rarer edge cases, so the review rounds did not converge. | MET-231 limited a re-review to the saved findings and the diff since the previous review. MET-239 moved path handling from POSIX sh into one Node helper. |
| The health-by-path test failed in the full parallel CI run. | The health by path QA app test failed on CI by chance. | MET-236 |
| Every blocking design finding and every second failed review went to Needs input. | A human sent each one back to the builder by hand. | MET-241 |
| A coordinator review reply was not JSON. | The loop fell back to a fix send-back, as D-062 specifies. | none, as designed (MET-244) |

### What a human still did

- A human sent review findings back to the builder by hand on MET-239 (6 times) and MET-243 (twice), before MET-241 went live.
- A human re-ran one flaky CI job.
- A human stopped and restarted the daemon to edit `loop.json` for those send-backs.

**What is left:** MET-207 (agents talk only through the coordinator with typed messages). The hands-off end-to-end proof moves to v0.1.1.
