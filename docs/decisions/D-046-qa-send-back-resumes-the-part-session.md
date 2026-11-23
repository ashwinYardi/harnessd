# D-046 A QA send-back resumes the part's own session

Status: accepted 2026-11-22. Issue: MET-156 (parent MET-143). Amends D-036 and D-032. Extends D-014, D-031, D-039, D-043 and D-045.

A QA send-back used to start a cold builder run. The run read the rules, the brief, the decisions and the code again before it fixed anything. On PR #70 two small QA faults cost a cold run of about 10–30M tokens. A send-back now continues the part's own earlier session when the harness can do it.

## State

`loop.json` gets an optional `sessions` key, by part id:

```json
{ "harness": "claude-code", "sessionId": "…", "worktree": "/wt/MET-41", "branch": "met-41-api", "at": "…" }
```

- A part run that ends with a `sessionId` stores it, at any status. A later run of the same part replaces it.
- A part's session is deleted when the part reaches Done, when a second QA or merge-gate failure drops its feedback, and when a resume fails.
- A file from before MET-156 loads with no `sessions` key.

A part is a **send-back** when `qaFeedback[part.id]` is set. The QA settle and the merge gate (a failed check or a conflict) both set it. A first build and a retry after an error run always start cold.

## When a send-back resumes

It resumes only when every condition holds:

- a session is stored for the part;
- the stored harness is the harness this run starts on (a fallback harness after D-035 starts cold);
- the new worktree path and branch equal the stored ones (`createWorktree` derives the path from the root, the repo name and the branch, so an unchanged title gives the same path; Claude Code keys sessions by cwd);
- the adapter sets `canResume`.

The loop logs one line: `<key>: resuming <harness> session`. Otherwise it starts cold as before and logs `<key>: cold run (<reason>)`, with the reason `no session`, `session on <harness>, run on <harness>`, `other worktree` or `<harness> cannot resume`.

The new prompt holds only the send-back facts: the part key and title, the PR url, the review url, each failing item with its evidence, and the tail of a failing test run. It adds: fix only these items, run focused tests, and do not commit, push or open a PR (D-039). It leaves out the brief, the decisions, the grill calls, the memory and the AGENTS text, because the session already holds them. A cold send-back keeps the full part prompt, review included.

## Test tail

The daemon already ran `qa.setup_command` and `qa.test_command` before the QA agent. When they fail, the settle stores the last **3,000 characters** of their output on the part's `qaFeedback` as `testTail`, with a leading `…` when it was cut. One constant, `MAX_TEST_TAIL`, is shared by the review comment and the feedback. The QA prompt uses the same limit. A passing test run stores no tail.

## The argv

The adapter contract gets an optional `Task.resumeSessionId` and an optional `HarnessAdapter.canResume`. This is additive and internal.

| Harness | Resume argv |
|---|---|
| Claude Code 2.1.329 | The normal argv plus `--resume <id>`. Every D-031 isolation flag and `--max-turns` stay. |
| Codex 0.171.0 | `codex exec resume <id>` with `--json`, `--ignore-user-config`, `--ignore-rules`, `--dangerously-bypass-hook-trust`, `-c sandbox_mode="danger-full-access"`, `-c approval_policy="never"` and `-c tool_output_token_limit=5000`, then `--` and the prompt. `codex exec resume` refuses `--sandbox` on 0.171.0; the `sandbox_mode` override sets the same thing, so no isolation flag is dropped. |
| OpenCode 2.3.2 | `opencode run --format json --standalone --auto --session <id> -- <prompt>`. `--standalone` and the temp `OPENCODE_CONFIG_DIR` stay; sessions live in the data folder, which does not change. |

The forms were checked with each CLI's `--help` on these versions. If a CLI refuses an isolation flag on resume, that adapter sets `canResume` false and the run starts cold. An isolation flag is never dropped to get a resume.

This record amends D-036, which said a run never passes `--session`. It now may, for a send-back only. It also amends D-032's argv for the resume form.

## Failed resume

Some runs end `error` with zero turns, or with no turn count, and with no ship. If such a run resumed a session, the loop treats it as a resume failure:

- it drops the stored session;
- it logs `<key>: resume failed (<error>), cold next`;
- it counts no attempt and moves the part back to Ready. The next dispatch starts cold.

A resumed run that took turns and then failed follows the normal error rule (D-014).

## Unchanged

A resumed run is a normal part run. It gets its size's wall-clock budget, the D-045 turn cap, and its tokens go into the parent's usage sum and weighted budget (D-043). The run id and the attempt numbering do not change. The daemon is the only writer to the part branch (D-039), so there is no head check: the new worktree is checked out from that branch and the agent reads the files as they are now.

## Tests and docs

- Adapters: one argv test per harness for the resume form, plus `canResume` true.
- State: a round trip with and without `sessions`, and malformed entries are dropped.
- Loop, with fake adapters: a send-back resumes with `resumeSessionId` and the short prompt; a missing session starts cold and logs why; a fallback harness starts cold; a failed resume counts no attempt and drops the session.
- QA: a settle stores `testTail` with the fixed limit, and a passing run stores none.
- `docs/LOOP.md` updates "QA", the "changes requested" row and "State file".
