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
