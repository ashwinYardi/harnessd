# The autonomy loop

`harnessd run` polls Linear, splits Ready issues into sub-issues, runs one agent per sub-issue and has QA review every PR (SPEC "Autonomy loop" steps 1 to 5, D-010, D-012, D-013, D-014). Code: `packages/daemon/src/coordinator/loop.ts`.

## Running it
```sh
LINEAR_API_KEY=lin_api_... harnessd run [dir] [--once] [--interval <seconds>] [--permission-mode <mode>]
```
- The key comes only from `LINEAR_API_KEY`. The command stops with an error when it is missing.
- GitHub goes through the `gh` CLI (D-002), with whatever auth `gh` has: `GH_TOKEN`, `GITHUB_TOKEN` or `gh auth login`. harnessd never reads or stores a GitHub token. `HARNESSD_GH_BIN` points at another `gh` binary.
- `linear.team_id` (a team key such as `MET`, or its UUID) is required. `linear.project` (a name or UUID) is optional. Both live in `.harnessd/config.toml`.
- The loop ticks every 30 s by default. `--once` runs one tick and waits for its runs to finish.
- Agents run with `--permission-mode auto` by default: nobody is there to approve prompts, and auto mode still screens risky actions. Each agent works in its own worktree (D-012), which keeps branches apart but is not a sandbox. `--permission-mode` overrides the default.
- SIGINT or SIGTERM stops the polling. Runs already started are allowed to finish.

## One tick
1. **Re-queue.** Any run recorded in `loop.json` that this process does not own was left by a previous process. Its worktree is removed and its sub-issue goes back to Ready, with no attempt counted.
2. **Pause check.** A `paused` hook is checked here. If it returns true, the tick stops. The `harnessd pause` command itself comes in MET-15.
3. **Dispatch** eligible sub-issues, then **split** Ready issues, then **dispatch** again.
4. **Save** `loop.json`.

## Split
Every Ready issue without a part marker is first grilled (docs/COORDINATOR.md).
- If the grill escalates, the issue goes to Needs input.
- If the grill errors, the issue is retried on the next tick.

The coordinator's harness then returns a plan as strict JSON:

```json
{ "parts": [{ "role": "backend", "title": "…", "prompt": "…", "size": "S" }] }
```

`role` is `backend` or `frontend`, and `size` is `S` or `M`. Only the parts the plan lists are created.

If the reply is unusable, the fallback is one part: frontend when the issue has the `ui` label, otherwise backend, at the issue's size.

harnessd always adds a QA sub-issue, "QA: <parent title>". Every part blocks it (a Linear relation of type `blocks`).

Sub-issues are Linear children of the parent, in the same team and project.
- They start in Ready and carry the parent's area label.
- Their body copies the parent's Why and Done when, and adds Size and the part's brief.

When the split is done, the parent moves to In Progress.

**Idempotent.** The first line of each sub-issue body is a plain-text marker (Linear may drop HTML comments), such as `harnessd part: backend`, `backend-2` or `qa`.
- Before creating anything, the split reads the parent's children and reuses any that already carry a marker.
- If a split was interrupted, the next tick finishes it without grilling again.

## Sizes and budgets
- S runs for `limits.budget_minutes.S` (30 min), M for `limits.budget_minutes.M` (2 h). An issue with no size counts as M.
- L is never run. If the plan, or the fallback, still contains an L part, the issue goes to Needs input with a comment and one ping. The same happens to an L sub-issue.

## Dispatch
- At most `limits.max_concurrent` runs at once (default 3).
- A part is eligible when it is in Ready and nothing unfinished blocks it.
- A QA sub-issue is eligible when every part is In Review or Done.
- Each run:
  - gets its own worktree and branch (D-012);
  - uses the adapter for its agent's harness;
  - gets a prompt made of the agent's layered instructions plus the sub-issue body;
  - runs within the budget for its size.
- The prompt tells the agent to commit, run `git push -u origin <branch>` and run `gh pr create`, with the sub-issue key in the PR title. A part that QA sent back gets the failing items and is told to push to its open PR instead.
- A QA sub-issue runs the QA round below instead of a single agent run.
- When the sub-issue starts it moves to In Progress. When the run finishes:

| Result | What happens |
|---|---|
| ok | The sub-issue moves to In Review. |
| error or timeout, first time | A comment is posted and the sub-issue goes back to Ready for one retry. |
| error or timeout, second time | A comment is posted, the sub-issue moves to Needs input and one ping is sent. |
| cancelled | The sub-issue goes back to Ready. No attempt is counted. |

The worktree is removed after every run.

## QA
QA checks each part's PR against the parent's "Done when" list before anything merges (D-013). It starts once every part that blocks the QA sub-issue is In Review or Done. Done parts are skipped.

For each part:
1. **Find the PR.** It is the newest open PR with the part's key in its title (`gh pr list --json`). With no PR, the part is sent back.
2. **Check it out.** The PR's head commit is checked out in a worktree of its own, detached, and removed afterwards (D-012).
3. **Run the tests.** harnessd runs `qa.setup_command` and then `qa.test_command` (default `pnpm test`) in that worktree.
4. **Ask the QA agent.** Its prompt has the "Done when" list, the changed files and the test result. Its last message must be strict JSON, one item per "Done when" item:

   ```json
   { "items": [{ "text": "…", "pass": true, "evidence": "…" }], "testsPassed": true }
   ```

5. **Review.** harnessd approves only when every item passes and the tests pass, both when harnessd ran them and for the agent. Otherwise it requests changes and lists each failing item with its evidence. GitHub does not let you approve your own PR, so when every agent shares one `gh` login, the verdict is posted as a comment review.

Output that is not valid JSON, or that has the wrong number of items, is a failed QA run. No review is posted for it.

After the round:

| Result | What happens |
|---|---|
| every PR approved | QA moves to In Review, with a comment that links each review. MET-14 merges. |
| changes requested, first failure | Each failing part goes back to Ready with a comment that links its review. QA goes back to Ready and runs again once the parts are back in review. |
| QA could not judge a PR, first failure | QA goes back to Ready and runs again. |
| second failure | QA and the parent move to Needs input. One comment goes on the parent and one ping is sent. Nothing is sent back again (D-014). |

The whole round runs within the QA sub-issue's size budget. Failures are counted per parent, up to `limits.qa_max_failures` (default 2).

## State file
`<repo>/.harnessd/state/loop.json` is written atomically (temp file, fsync, rename). The folder has its own `.gitignore`.

```json
{ "version": 1, "lastPollAt": "…", "inFlight": [{ "issueId": "…", "issueKey": "MET-41", "role": "backend", "agent": "backend", "worktree": "…", "branch": "…", "startedAt": "…", "pid": 123 }], "attempts": { "<issueId>": 1 }, "qaFailures": { "<parentId>": 1 }, "qaFeedback": { "<partId>": { "prUrl": "…", "reviewUrl": "…", "failing": ["…"] } } }
```

Linear stays the source of truth. The file only records in-flight runs, failure counts and the QA feedback a sent-back part gets in its prompt. If the file is unreadable, it is moved aside to `loop.json.corrupt-<ts>` and the loop starts empty.
