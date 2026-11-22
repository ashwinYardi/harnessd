# The autonomy loop

`harnessd run` polls Linear, splits Ready issues into sub-issues, runs one agent per sub-issue, has QA review every PR and merges what passes the gate (SPEC "Autonomy loop" steps 1 to 7, D-010, D-012, D-013, D-014). Code: `packages/daemon/src/coordinator/loop.ts`.

## Running it
```sh
harnessd run [dir] [--once] [--interval <seconds>] [--permission-mode <mode>]
```
- The key comes from the secret lookup: a value or reference saved in Settings, then `LINEAR_API_KEY` (D-030, docs/CONFIG.md "Secrets"). It is read on each Linear request, so a new key applies on the next tick. Without one, `--once` stops with an error, and a long run waits in setup (D-026).
- GitHub goes through the `gh` CLI (D-002), with whatever auth `gh` has: `GH_TOKEN`, `GITHUB_TOKEN` or `gh auth login`. harnessd never reads or stores a GitHub token. `HARNESSD_GH_BIN` points at another `gh` binary.
- `linear.team_id` (a team key such as `MET`, or its UUID) is required. `linear.project` (a name or UUID) is optional. Both live in `.harnessd/config.toml`.
- **Checks at start.** Before the loop starts, `harnessd run` runs the checks of `harnessd doctor` (docs/INSTALL.md). A `warn` is printed and the loop starts (D-023). A blocking check that failed by timeout runs the checks again, up to 3 runs in total with a 15 s limit; a check that passes on a retry starts the loop with no Start press (D-042). On any other `fail` or `missing`, or without a Linear key or `linear.team_id`, it prints each blocker with its fix. Then it serves the app in **setup** and waits: the loop starts when every required check passes and the owner presses Start in the app (`POST /api/start`, D-026). With `--once` it exits 1 instead.
- The loop ticks every 30 s by default. `--once` runs one tick and waits for its runs to finish.
- Agents run with `--permission-mode auto` by default: nobody is there to approve prompts, and auto mode still screens risky actions. Each agent works in its own worktree (D-012), which keeps branches apart but is not a sandbox. `--permission-mode` overrides the default.
- The local API and the web UI (docs/API.md) start with the loop on `127.0.0.1:<daemon.port>` (default 4747). Open that url in a browser to see the board. Its url goes to `~/.harnessd/state/daemon.json`, which is removed on a clean stop. A port already in use stops the command with an error; give a second loop its own `daemon.port`.
- Slack goes through `HARNESSD_SLACK_WEBHOOK_URL` (docs/INSTALL.md "Slack"). Without it, the start lines include one warning and nothing is posted. A due daily summary is checked at start and every minute.
- SIGINT or SIGTERM stops the polling. Runs already started are allowed to finish. Queued Slack posts get up to 5 s.

## One tick
1. **Re-queue.** Any run recorded in `loop.json` that this process does not own was left by a previous process. Its worktree is removed unless it holds unshipped work; then it is kept and the sub-issue resumes in it. Its sub-issue goes back to Ready, with no attempt counted. A run a pause had already marked keeps its worktree (see Pause).
2. **Pause check.** The pause flag is re-read. If it is set, anything still running is cancelled and the tick stops.
3. **Release holds.** A usage-limit hold whose time has passed ends (see Usage limits).
4. **State repair.** A shipped part that Linear moved back to In Progress goes to In Review again, before dispatch (see Ship).
5. **Merge.** Every QA approval recorded in `loop.json` goes one step through the merge gate (see Merge).
6. **Dispatch** eligible sub-issues, then **split** Ready issues, then **dispatch** again.
7. **Save** `loop.json`.

## Split
Every Ready issue without a part marker is first grilled (docs/COORDINATOR.md).
- If the grill escalates, the issue goes to Needs input.
- If the grill errors, the issue is retried on the next tick.

The coordinator's harness then returns a plan as strict JSON:

```json
{
  "parts": [{ "role": "backend", "title": "…", "prompt": "…", "size": "S" }],
  "reason": "why the issue cannot ship as one part (required with more than one)"
}
```

`role` is `backend` or `frontend`, and `size` is `S` or `M`. Only the parts the plan lists are created.

**One part by default (D-040).** One part is one PR. The plan may have more only when the issue's Size is L, or when one part cannot fit the M budget. A plan with more than one part and no `reason` is invalid: the loop uses the one-part fallback and the split comment says so. A valid split comment also states the reason.

If the reply is unusable, the fallback is one part: frontend when the issue has the `ui` label, otherwise backend, at the issue's size.

harnessd always adds a QA sub-issue, "QA: <parent title>". Every part blocks it (a Linear relation of type `blocks`).

**Serial parts (D-040).** When the split has more than one part, part 1 blocks part 2, part 2 blocks part 3, and so on. A part starts only after the part before it is merged (Done), so no two PRs of one parent are open at the same time. An interrupted split adds the missing relations on the next tick.

Sub-issues are Linear children of the parent, in the same team and project.
- They start in Ready and carry the parent's area label.
- Their body copies the parent's Why and Done when, and adds Size and the part's brief.

When the split is done, the parent moves to In Progress.

**Idempotent.** The first line of each sub-issue body is a plain-text marker (Linear may drop HTML comments), such as `harnessd part: backend`, `backend-2` or `qa`.
- Before creating anything, the split reads the parent's children and reuses any that already carry a marker.
- If a split was interrupted, the next tick finishes it without grilling again.

## Sizes and budgets
- S runs for `limits.budget_minutes.S` (30 min), M for `limits.budget_minutes.M` (2 h). An issue with no size counts as M.
- L is never run. If the plan, or the fallback, still contains an L part, the issue goes to Needs input with a comment and one notice. The same happens to an L sub-issue.

## Dispatch
- `limits.max_concurrent` runs at once (default 1, D-040). Parallel parts of one parent touched the same files, and each merge sent the next PR back for another build and QA round, so the default is serial. A user may still set up to 3 (D-014 cap).
- A part is eligible when it is in Ready and nothing unfinished blocks it. With serial parts, part 2's blocker is part 1 until part 1 is Done (merged).
- A QA sub-issue is eligible when a part of its parent is In Review at a head QA has not approved (see QA).
- Each run:
  - gets its own worktree and branch (D-012);
  - uses the adapter for its agent's harness;
  - gets a prompt made of the agent's layered instructions plus the sub-issue body;
  - runs within the budget for its size.
- Before a part or QA run starts, and before a rework run, the loop checks the parent's weighted token sum against `limits.token_budget`. At or over it, nothing starts and the parent goes to Needs input (see Token budget).
- The prompt tells the agent to edit and test in the worktree only. It does not commit, push or open the PR: the daemon ships the work after the run (D-039). A part that QA sent back gets the failing items and works on its open PR.
- A QA sub-issue runs the QA round below instead of a single agent run.
- When the sub-issue starts it moves to In Progress. When the run finishes:

| Result | What happens |
|---|---|
| ok | The daemon ships the run (see Ship). The sub-issue then moves to In Review. |
| error or timeout, first time | A comment is posted and the sub-issue goes back to Ready for one retry. |
| error or timeout, second time | A comment is posted, the sub-issue moves to Needs input and one notice is sent. |
| cancelled | The sub-issue goes back to Ready. No attempt is counted. |
| limited | The harness hit a usage or rate limit. The sub-issue goes back to Ready. No attempt is counted. |
| cancelled by a pause | The worktree is kept. See Pause. |

**Ship.** After an `ok` part run, the daemon ships the work before it moves the sub-issue to In Review (D-039).
- It commits the worktree with the run's excludes file, so generated files stay out of the commit. The body is the agent's last message.
- It compares the branch with the remote default branch (`origin/main` or `origin/master`). With no new commit and no commit ahead of base, the run fails as `no changes`.
- It pushes with `git push -u origin <branch>`. It never force-pushes.
- The daemon looks for an open PR with the run's head branch. The push updates that PR. If there is no match, the daemon looks for an open PR with the issue key in its title. If that PR has a different head branch, the run fails and reports both branches. The daemon opens a PR with `gh pr create` only if both lookups find no PR. It puts the part key in the title and uses the agent's last message in the body.
- **One key in the title.** The commit subject and the PR title are `<part key>: <part title>`. A leading copy of the parent key, or of any other key of the same team, is cut from the part title, so the title names one issue. Linear's GitHub automation moves every issue a PR title names, so two keys would move two issues. The part title `MET-123: cut token spend` on part `MET-124` gives `MET-124: cut token spend`. A key in the middle of a title stays. Only a PR the daemon opens gets this title: a PR that already exists is pushed to and keeps its title.
- A failed commit or push fails the run as `push failed: <reason>`. A failed PR fails it as `pr failed: <reason>`, and a run with nothing to ship fails as `no changes`. Such a run is never "done, In Review": it counts an attempt, as an error run does.

**State repair.** While the ship step runs, the part is In Progress. Linear's GitHub automation can move it again as the PR opens, for example to In Progress, a second after the daemon moved it to In Review. QA then has nothing to review, and the loop sits idle. So:
- After a successful ship, the daemon records the part under `shipped` in `loop.json` with its key, branch, PR URL and time, and then moves it to In Review.
- Early in every tick, before dispatch, the loop reads each shipped part once more. If it is In Progress, no run of it is in flight, and an open PR still has its branch, the loop moves it to In Review again and logs one line: `<key>: Linear moved it to In Progress after its PR opened; back to In Review`. QA can start on that same tick.
- The record is dropped when the part runs again, and when the part is in a state other than In Progress or In Review, such as Ready, Needs input or Done. An In Progress part whose PR is no longer open drops it too, without a move. So the loop never fights a human move. A part with a run in flight is never moved, even while its record is still there.
- A failed repair move is logged and the record stays; the next tick tries again. There is no comment, no attempt and no notice.

harnessd expects this from Linear's GitHub pull request automation: on PR open, no state move or a move to In Review; on PR merge, a move to Done is fine. harnessd does not change the setting. When the setting moves a shipped part to In Progress, the repair above puts it back (docs/INSTALL.md "Linear GitHub automation").

The worktree is removed after a run when it holds no unshipped work. A worktree with **uncommitted changes** or **commits not on the remote** is kept, with one Linear comment: "worktree kept at <path>: uncommitted changes" or "…: commits not on the remote". It is listed under `interrupted`, so the next run resumes it on the same branch. If the issue was renamed, the branch changed and the old worktree cannot be resumed; it is still kept and commented on. A pause keeps its worktree too (see Pause). A QA checkout is never kept; the loop removes it after the round. The keep guard reads the run's excludes file, so files the worktree sync wrote never count as unshipped work.

## What an agent run sees
A worktree is cut from `origin/main`, or from `origin/<branch>` when that branch already exists on the remote (a part QA sent back), so it holds only what the repo commits. harnessd fills in the rest before the agent starts.

- **Worktree sync.** Before each part run, resumed run and QA agent run, the loop writes the same native files as `harnessd sync` (docs/SYNC.md) into the worktree: skills, rules, AGENTS.md and CLAUDE.md, settings and MCP.
  - It reads the workspace layer from the main repo's `.harnessd/`, so changes there count even when they are not committed.
  - In a QA round, the sync runs after `qa.setup_command` and `qa.test_command`, just before the QA agent.
  - Coordinator grill and plan runs get no sync.
- **Sync failure.** A failed sync fails the run before the agent starts. The rule is the one for an error: a comment and one retry, then Needs input.
- **Excluded files.** The generated files stay out of the agent's commits.
  - Each run gets an exclude file outside the worktree. The loop sets it as `core.excludesFile` through the `GIT_CONFIG_*` environment variables.
  - Generated files that the repo already tracks get `git update-index --skip-worktree`.
  - An issue that asks for these files adds them with `git add -f`.
- **Isolation flags.** Claude Code runs with `--setting-sources project --strict-mcp-config --mcp-config .mcp.json` (docs/decisions/D-031-agent-run-isolation.md).
- **What the owner's config no longer gives.** The run does not load the user-level Claude Code config:
  - the user permissions allowlist, user `env` and `apiKeyHelper`;
  - user plugins, the user CLAUDE.md, skills and hooks;
  - user MCP servers.

  So a key goes in through `claude login` or an environment variable.
- **Codex runs.** An agent with `harness = "codex"` runs `codex exec --json` with `--ignore-user-config --ignore-rules`, with full access and no approval prompts, as Claude runs (docs/decisions/D-032-codex-adapter.md). It sees these files from the same sync:
  - `AGENTS.md`: the instructions and the merged rules;
  - `.agents/skills/`: the skill pack;
  - `.codex/config.toml`: the MCP servers, with `harnessd-memory`;
  - `.codex/hooks.json`: the skills' Codex hooks. `--dangerously-bypass-hook-trust` lets them run with no `/hooks` approval.
- **The Codex gap.** Codex has no flag that skips `$CODEX_HOME/AGENTS.md` or the user-level skills. `CODEX_HOME` stays, because `auth.json` lives there. So a Codex run can still see the owner's `$CODEX_HOME/AGENTS.md` and user skills. A follow-up issue tracks this.
- **OpenCode runs.** An agent with `harness = "opencode"` runs `opencode run --format json --standalone --auto`. The CLI approves pending permission requests and keeps the session running (docs/decisions/D-036-opencode-adapter.md). `OPENCODE_CONFIG_DIR` points to an empty temp folder, so the owner's OpenCode config and global `AGENTS.md` do not load. The run reads `AGENTS.md` and the project skill folders.
- **The OpenCode gap.** OpenCode 2.0.20 and 2.3.2 still load skills from `~/.claude/skills` and `~/.agents/skills`. It has no switch that skips them. Impeccable hooks do not run, because OpenCode uses JS plugins, not `hooks.json`. Sync adds the `harnessd-memory` server to `opencode.json`.
- **Memory.** The prompt has a Memory section. It names `search_notes`, `read_note` and `write_note`, and the two vaults: `<repo>/.harnessd/vault/` and `$HARNESSD_HOME/vault/` (docs/MEMORY.md). The worktree's `.mcp.json` runs `harnessd mcp memory --workspace <main repo>`, so notes outlive the worktree.
- **Hand-vendored skills.** A skill folder that sync did not generate stays as it is (D-020). Sync prints `kept <folder>` and does not write into it. A worktree run still withholds the skill its role leaves out, even when the repo commits that folder (see the role skill set below).
- **Role skill set (D-040, D-043).** A worktree run gets the pack for its role. `frontend` keeps `impeccable` and drops `grilling`, `domain-modeling`, `research` and `prototype`. `coordinator` keeps those four and drops `impeccable`. `backend` and `qa` drop all five, because their work never needs those bodies. The map is built in, not config: `enabled = false` still turns a skill off for everyone. A worktree cut from `main` already holds the skill folders the repo commits, so the loop removes a withheld folder from that worktree and marks its tracked files `skip-worktree`; git sees no deletion and the agent commits, pushes and opens the PR as usual. The main checkout is not touched. A later run that does not withhold a folder puts the committed folder back. The D-028 hook stays for frontend runs.
- **MCP servers (D-040).** A worktree run gets only `harnessd-memory`. A `[mcp.<name>]` server in the config does not load into a worktree run, so its tool list is not sent.
- **Measured size.** The base prompt is measured, not guessed. The numbers below are from `packages/daemon/src/coordinator/prompt-size.test.ts`, this repo's committed skill pack and its sync output. A character is about a quarter of a token.

  | Item | Builder or QA run | Frontend run |
  |---|---|---|
  | Part prompt (fixture issue) | about 1.1k chars | unchanged: it is already only the agent, the task and the memory pointer |
  | QA prompt (one PR, diff cut at 24k chars) | about 3.3k chars | unchanged: the diff, CI, tests and checklist are the whole job |
  | `AGENTS.md` (this repo, rules included) | 4.5k chars | unchanged: agents must read the repo rules |
  | `SKILL.md` bodies, committed pack | 40,781 chars (9 of 14 skills) | 53,443 chars (10 of 14; keeps `impeccable`) |
  | `opencode.json` MCP and permission tables | 687 chars | unchanged |
  | `harnessd-memory` tool list | 1,878 chars | unchanged |
  | **Static total from the sync** | **about 47.8k chars, about 12.0k tokens** | **about 60.5k chars, about 15.1k tokens** |
  | Owner `~/.claude/skills` + `~/.agents/skills` (out of scope, MET-112) | 73,829 chars, measured 2026-11-22 | same |

  The coordinator's grill and plan runs get no worktree sync and read this repo's spec and decision records instead: about 86.1k and 74.5k chars for this repo. The skill row counts the folders a worktree cut from `main` holds, read from `HEAD`, not only the files sync generates. The test is `the committed skill pack…` in `prompt-size.test.ts`.

  **Per harness, first turn.** The same files reach every harness, but each reads its own layout. The static total is an upper bound: a harness that loads a skill body on demand sends less.

  | Harness | What the sync adds | First turn |
  |---|---|---|
  | Claude Code | `AGENTS.md`, `.claude/skills/`, `.mcp.json` with `harnessd-memory` | not measured on a real run; about 12.0k static tokens |
  | Codex | `AGENTS.md`, `.agents/skills/`, `.codex/config.toml`, `.codex/hooks.json` | not measured on a real run; about 12.0k static tokens |
  | OpenCode 2.3.2 | `AGENTS.md`, `.claude/skills/` and `.agents/skills/`, `opencode.json` | **9,328 tokens** (8,944 input + 384 cache read) on the first `step_finish` of a short real run in this worktree, deepseek-v4.1-flash |

  The same prompt in an empty folder, with no project files, took **7,437 tokens** (5,645 input + 1,792 cache read). That is OpenCode's system prompt and built-in tool schemas. The worktree files and the `harnessd-memory` tool list add about **1.9k tokens**. The static skill count is an upper bound because OpenCode exposes skills through its `skill` tool and loads a body only when it uses it.

  **What grows the turn.** The MET-128 build averaged about **190k tokens per turn**: 12,257,280 cached tokens over about 65 turns, plus the new input. The base prompt is about 9k to 12k of that. The rest is the conversation and the tool output it carries, which every later turn sends again.

  - OpenCode caps one tool result at `tool_output.max_lines` 2,000 and `max_bytes` 51,200 (about 50 KiB) by default.
  - Automatic compaction is on by default: near the context limit OpenCode replaces older conversation with a summary, keeps about `compaction.keep.tokens` 15,000 recent tokens, and shortens long tool output in that tail. It can only reclaim conversation, not fixed instructions and tool schemas.
  - So a full test run or a large file read stays in context as one capped tool result, then in the summary and the recent tail after compaction. Focused tests and file ranges keep those results small.

  **Owner-level gaps, measured and out of scope:** D-032 says Codex still reads `$CODEX_HOME/AGENTS.md` and user skills, because `CODEX_HOME` must hold `auth.json`. D-036 says OpenCode still loads `~/.claude/skills` and `~/.agents/skills`. On 2026-11-22 the SKILL.md bodies in those two folders total 73,829 chars; a run that used one of those skills would load that body too. The loop cannot remove them without breaking the owner's sign-in or setup (MET-112).

## Pause
The global kill switch (D-014). It stops every agent in every workspace within 10 s.

```sh
harnessd pause [--reason <text>]   # "Paused. 2 runs cancelled; worktrees kept."
harnessd resume                    # "Resumed."
```

- **The flag.** `~/.harnessd/state/paused.json` (`$HARNESSD_HOME/state/` when set) holds `{ "paused": true, "since": "…", "reason": "…" }`. It is written atomically. A missing file means running. An unreadable one counts as paused, and `harnessd resume` replaces it.
- **The commands.** Both write the flag first, then POST to the daemon that `daemon.json` names, so the effect is immediate. They exit 0 even when no daemon is running, since the flag still applies. The UI button (MET-18) uses the same API (docs/API.md).
- **What stops.** While paused, a tick dispatches nothing, and grills and splits are skipped. Every run in flight is cancelled through its adapter (SIGTERM to the process group, then SIGKILL after the grace period, 5 s by default). Grill and plan runs are cancelled too, and their issue is grilled again after resume.
- **No daemon reachable.** The loop re-reads the flag at the start of every tick and, while runs are in flight, every second. So a pause written with the daemon unreachable still stops runs within 10 s.
- **A cancelled run:**
  - keeps its worktree, for inspection;
  - is listed under `interrupted` in `loop.json`, with the worktree path;
  - goes back to Ready with the comment "Paused by harnessd pause; worktree kept at <path>";
  - counts no attempt.

  The run is marked in `loop.json` before it is killed. If the process stops before the cancel is recorded, the restart still keeps the worktree.
- **A cancelled QA round** stops its tests and its QA agent, keeps the PR checkout in use and is recorded the same way. It posts no review, counts no QA failure and sends no part back. When QA runs again, the kept checkout is removed and the PR head is checked out afresh, in the same round.
- **Resume.** The next dispatch of that sub-issue **reuses** the kept worktree: same branch and path, with the earlier work, committed or not. The prompt then says so, after any QA feedback. This is also how a worktree kept for unshipped work resumes. The kept worktree is removed only if the branch name changed in the meantime (the issue was renamed), and the guard still keeps it when it holds unshipped work. Once the resumed run finishes, its worktree is removed when it holds no unshipped work.
- **Restart.** Paused survives a restart. `harnessd run` while paused starts the API and the loop in the paused state and prints `harnessd run: paused since … Run "harnessd resume" to dispatch again.`

## QA
QA reviews one PR, when that part reaches In Review (D-040). It checks the PR against the parent's "Done when" list before anything merges (D-013). QA does not read the whole repo.

Before a review, the loop reads the PR's `headRefOid` and compares it with the part's **reviewed head** in `loop.json`:
- the same sha as an approved part: QA does not run again;
- a new sha: QA runs once;
- an approved part whose PR head did not change stays approved and goes to the merge gate.

For each part:
1. **Find the PR.** It is the newest open PR with the part's key in its title (`gh pr list --json`). With no PR, the part is sent back.
2. **Check it out.** The PR's head commit is checked out in a worktree of its own, detached, and removed afterwards even when it has local changes. A QA checkout is never kept (D-041).
3. **Run the tests.** harnessd runs `qa.setup_command` and then `qa.test_command` (default `pnpm test`) in that worktree.
4. **Ask the QA agent.** Its prompt holds the PR diff from `gh pr diff`, cut to a fixed limit, with the file list after the cut; the parent's "Done when"; the part brief; the CI result from `statusCheckRollup`; and the harnessd test result. It judges from the diff, the CI result and the tests, and opens a file only to check a line the diff touches. Its last message must be strict JSON, one item per "Done when" item:

   ```json
   { "items": [{ "text": "…", "pass": true, "evidence": "…" }], "testsPassed": true }
   ```

5. **Review.** harnessd approves only when every item passes and the tests pass, both when harnessd ran them and for the agent. Otherwise it requests changes and lists each failing item with its evidence. GitHub does not let you approve your own PR, so when every agent shares one `gh` login, the verdict is posted as a comment review.

Output that is not valid JSON, or that has the wrong number of items, is a failed QA run: it counts a failure. No review is posted for it.

After the round:

| Result | What happens |
|---|---|
| approved | The part's PR goes to `merges` in `loop.json` as one entry with one PR, pinned to the reviewed head, and the merge gate takes it. QA stays Ready for the next part. |
| changes requested, first failure | The part goes back to Ready with a comment that links its review. The reviewed head records `changes_requested`; QA runs again only on a new head. |
| QA could not set up the review | QA goes back to Ready and runs again. No QA failure is counted and no comment is posted: the PR lookup, checkout, worktree sync, or the budget before the agent failed (D-041). |
| second failure | QA and the parent move to Needs input. One comment goes on the parent and one notice is sent. Nothing is sent back again (D-014). |

The QA sub-issue moves to Done after the last part of the parent merges. The final check on main and the follow-up issue stay in MET-86.

A QA agent run that ends `limited` stops the round. No review is posted, no QA failure is counted and QA goes back to Ready.

The whole round runs within the QA sub-issue's size budget. Failures are counted per parent, up to `limits.qa_max_failures` (default 2).

## Token budget and usage
Each run ends with one log line: `<key>: <agent> used <input> input, <cached> cached, <output> output tokens in <n> turns`, where cached is cache read plus cache write. `n` is the harness's own count: OpenCode's `step_start` steps, Codex's `turn.completed` turns, or Claude Code's `num_turns`. A run with no count keeps the line without `in <n> turns`. The loop adds the run's raw tokens to the parent's **usage sum** in `loop.json` under `usage`, so the sum survives a restart. The board shows the sum as one compact count with a tooltip that splits input, cached and output.

The **token budget** is weighted (D-043): `limits.token_budget`, keyed by size like `budget_minutes`: S 3M, M 6M. An unknown size counts as M. The weighted sum is `input + output + round(cached × limits.cached_token_weight)`, with `limits.cached_token_weight` from 0 to 1 and default 0.1; at 1 it is the old raw count. `cached` is cache read plus cache write. It sums every run of the parent over its grill, plan, part and QA runs. Before the loop starts a new part run, QA run or rework round, it compares the weighted sum with the budget:
- below the budget: the run starts;
- at or over it: nothing starts. The parent moves to Needs input, with one comment that states the weighted total, the budget, and the raw input, cached and output parts with the weight, and one notice (the D-011 escalation shape). A run in flight finishes normally.

The raw sum at escalation is recorded as `usageBaseline` in `loop.json`, as the parent's cumulative sum (not the delta), so the next count subtracts it. When a human moves the parent back to Ready, the budget counts from that point, also after a second escalation. `usage` and `usageBaseline` stay raw, so an old `loop.json` loads and the board count is unchanged.

## Usage limits
A run that ends `limited` hit the harness's usage or rate limit. It is no task failure (MET-70). Claude Code says it in the result text or the last stderr line. Codex says it as a spent usage limit or quota; that run ends `limited` with reason `usage_limit` and no reset time, so the hold uses the backoff. OpenCode says it as a `provider.quota` or `provider.rate-limit` error; the reset time comes from the error's retry time when it gives one.

- **Part run.** The worktree is removed when it holds no unshipped work, or kept with its keep comment when it holds some (see Dispatch). The sub-issue goes back to Ready. No attempt is counted and no other comment is posted.
- **QA run.** See QA: no review and no QA failure.
- **Grill or plan run.** Nothing is written, nothing escalates and the issue stays in Ready. A limited plan is not replaced by the fallback plan.

The limit also starts a **hold** on that harness, kept in `loop.json` under `limits`:

| The harness says | The hold ends |
|---|---|
| a reset time | at the reset time |
| no reset time | after a backoff: 15 minutes, doubled after each hold that ended, at most 2 hours |

While a hold lasts, no part, QA, grill or plan run starts on that harness. An agent with a usable `fallback_harness` runs on its fallback harness and model instead (docs/CONFIG.md "Fallback harness", MET-81). A fallback is usable when it has an adapter and no hold of its own. Otherwise the issue waits in Ready and nothing is logged per tick. Agents on other harnesses dispatch as usual. Runs in flight are not cancelled. More limited runs during a hold do not double it. An ok run that ends after the hold clears the backoff. An ok run that ends during the hold leaves the hold as it is.

The log gets one line when a hold starts and one when it ends, in the daemon's local time:

```
Claude Code limited until 18:37
Claude Code limited until 17:52 (backoff)
Claude Code available again
MET-61: backend on Codex while Claude Code is limited
```

GET /api/loop and the `agents` event list the holds in force under `limits` (docs/API.md). The app reads them for "Claude Code limited until HH:MM".

The daily summary records each hold's start and end. It adds one line per harness with the limited time since the last summary, such as `Claude Code limited 2h 10m`. A hold still open counts up to the summary time and carries over to the next. A hold that expired while the daemon was off counts only up to its recorded expiry. An end entry also carries the hold's own start. So a hold with no recorded start counts from its start, not from the last summary. A day with no hold has no such line. No Slack notice goes out per hold.

## Merge
The merge gate (D-013). Code: `packages/daemon/src/coordinator/merge.ts`. A PR merges only when **all** of these hold:
- QA approved it, at the head it still has;
- CI is green;
- it touches no protected path.

**Approval.** GitHub's review state cannot be the record: on a PR opened by the same `gh` login, the verdict is only a comment review. So harnessd records the approval itself. Each approved part adds one entry to `merges` in `loop.json`, with the part's PR number and the head sha QA checked out and reviewed (D-040).

**Each tick**, every PR in `merges` is read again with one call, `gh pr view <n> --json number,url,state,headRefOid,mergeable,statusCheckRollup,files,changedFiles`. Then, in this order:

| Finding | What happens |
|---|---|
| merged on GitHub | A human merged it: the part moves to Done. |
| closed, not merged | The parent moves to Needs input, with a comment and one notice. The approval is dropped. |
| head is not the approved sha | Nothing merges unreviewed. QA moves back to Ready with a comment and runs again on the new head. No QA failure is counted. |
| a changed file matches `merge.protected_paths` | Needs a human (below). |
| GitHub listed fewer files than `changedFiles` | Needs a human: the paths could not all be checked. |
| a check failed, or the PR conflicts with its base | Sent back (below). |
| a check is pending, there are no checks yet, or mergeability is still UNKNOWN | Nothing happens. The next tick looks again. |
| every check passed | `gh pr merge <n> --squash --match-head-commit <approved sha>`. The part moves to Done, with a comment and a notice to the notifier (D-015). |

- **CI green** means at least one check, and every check passed: a check run that completed with SUCCESS, NEUTRAL or SKIPPED, or a commit status of SUCCESS. When a check was re-run, only its latest run counts. Any other conclusion fails. A PR with no checks waits, because D-013 needs CI green.
- **Needs a human.** The PR gets the `merge.label` label (default `needs-human`; the label is created when the repo lacks it). The parent moves to Needs input with one comment, and one notice is sent. The notice is recorded under `humanPings` in `loop.json`, keyed by the PR URL, before it is sent. So a PR gets one notice, across ticks, restarts and new QA rounds. harnessd never merges that PR. It keeps reading it, and once a human merges it, the part moves to Done. A merge GitHub refuses (branch protection, a draft) goes the same way, with gh's error in the comment.
- **Sent back.** A failed check or a conflict is a gate failure for the parent. The rule is the QA one: sent back once, then escalated (SPEC step 6, D-014).
  - The first failure sends each failing part back to Ready. Its next prompt lists the failing checks, like QA feedback, and it pushes to its open PR. QA moves to Ready and runs again once the parts are back in review.
  - The `limits.qa_max_failures`-th failure (default 2) moves QA and the parent to Needs input, with one comment and one notice. Nothing is sent back again.
  - Gate failures are counted per parent under `gateFailures`, apart from QA failures. A new QA approval does not reset them. A parent reaching Done does.
- **Done.** Once every PR of an approval is merged, its entry leaves `merges`. When every part of the parent is Done, the QA sub-issue moves to Done and the parent moves to Done too (D-040).
- **Pause.** No merge happens while paused. The flag is checked at the start of the tick, before each PR is read, and again right before each `gh pr merge`. A pause that lands mid-tick stops the gate before the next merge. The approval stays in `loop.json` for after resume. A flag that cannot be read counts as paused here.
- **Protected paths** are globs in `merge.protected_paths` (docs/CONFIG.md). They are matched against each changed file's repo path, ignoring case. `**` spans directories, `*` and `?` stay within one directory, and `{a,b}` matches either. A glob without a `/` matches the file name at any depth. GitHub's file list gives a renamed file's new path only.
- `merge.method` (default `squash`) picks `--squash`, `--merge` or `--rebase`.

## Self-update
When harnessd merges into its own repo, it rebuilds and restarts itself (MET-63). Code: `packages/daemon/src/selfupdate/` (the updater) and `packages/daemon/src/coordinator/loop.ts` (when it runs). `[daemon] self_update = false` turns it off (docs/CONFIG.md). The rules are in D-033 and D-042. `harnessd run` builds the updater when the start detection finds the install clone. It asks GitHub for the default branch, falls back to `origin/HEAD`, then to `main` when the remote sets no HEAD.

```
merge (harnessd or a human) ─┐
daemon start and loop ticks ──┴─► check ─► pending ─► safe point ─► apply ─┬─► ok: restart, new process logs from -> to
                                             │      (inFlight empty)       └─► blocked / failed: old build kept,
                                  no dispatch, grill, split or merge                paused, Needs input, one notice
```

- **Check.** The loop asks the updater for a target after each tick where the merge gate saw a PR merged, by harnessd or by a human. A pause in the same pass keeps the check for the first tick after resume. The merged part's parent is the **trigger issue**. The loop also checks at daemon start and on active ticks before it dispatches more work, so it finds merges outside the merge queue. A check that finds a new target outside the merge queue has no trigger issue. The updater finds no target when the repo is not the install clone, or the install already runs the default branch head. A `pending` record with no target left is dropped.
- **Kept local changes.** A check does not block on the files harnessd writes itself: every path `harnessd sync` owns (`AGENTS.md`, `CLAUDE.md`, `.claude/settings.json`, `.claude/agents/`, the generated `.claude/skills/` and `.agents/` folders, `.mcp.json`, `.codex/`, `opencode.json`), the workspace vault `.harnessd/vault/`, and `.harnessd/config.toml`. Any other local change blocks the update. The check logs one line, `self-update: not updating: <reason>`, such as `self-update: not updating: Local changes in the install clone: src/x.ts`. It logs the same reason only once, and again when the reason changes or a target appears. A blocked check before a target exists does not pause the loop, send a notice or ask for input.
- **Pending.** A target is recorded as `selfUpdate` in `loop.json` with the state `pending`. While it is pending, a tick dispatches nothing and skips grills, splits and merges. Runs in flight, grill and plan runs included, finish normally.
- **Safe point.** The first tick with `inFlight` empty. A run that has run longer than its size budget (D-014: S 30 min, M 2 h) while the update waits is stopped like a paused run: its worktree is kept, it is listed under `interrupted` with the reason `self-update`, it goes back to Ready, and it counts no attempt. If the move to Ready fails, the run stays in `inFlight` and the next tick tries the move again. The run starts again in the same worktree after the restart.
- **Apply.** The state becomes `applying` and is saved. The updater stashes the kept tracked changes under `harnessd self-update <from7>`, fast-forwards the install clone, and pops the stash. The kept untracked paths stay in place; a fast-forward that would add one of them is refused. It runs `pnpm install --frozen-lockfile` and `pnpm build` with the service's Node, then `harnessd sync` with the new build, and restarts through launchd. If the pop conflicts, it resets to `from` and pops the stash there; the update ends `blocked` and names the conflicting paths. A stash is never dropped before a clean pop. Until the restart, the old process dispatches nothing. The new process reads the `applying` record. If its build commit matches the target, it logs `self-update: <from7> -> <to7>` and sets the state to `done`. Otherwise, it changes the state to `pending` and checks for a target on the next unpaused tick.
- **Blocked or failed.** A local change that harnessd did not write blocks the update; harnessd never discards it. A failed pull, install, build or sync keeps the old build; harnessd never restarts into a broken build. Either way:
  - paused.json gets the reason `self-update blocked: <reason>` or `self-update failed: <step>: <last error lines>`;
  - one notice goes to the notifier;
  - the trigger issue, if any, gets a comment with the error and moves to Needs input. A start-time failure makes no Linear call.

  The target commit is recorded under `selfUpdateNotices` before the notice, as `humanPings` is for a PR. So a repeat failure for the same target pauses again but sends no second notice or comment.
- **Resume.** After `harnessd resume`, the next tick checks again. If the pause flag write fails, the loop logs the error and stays paused in memory until the daemon receives the resume request.
- **The app.** GET /api/loop returns the record as `selfUpdate` (docs/API.md).

## State file
`<repo>/.harnessd/state/loop.json` is written atomically (temp file, fsync, rename). The folder has its own `.gitignore`.

```json
{ "version": 1, "lastPollAt": "…", "inFlight": [{ "issueId": "…", "issueKey": "MET-41", "role": "backend", "agent": "backend", "worktree": "…", "branch": "…", "startedAt": "…", "pid": 123, "pausedAt": "…", "stopReason": "self-update", "excludesFile": "…" }], "interrupted": [{ "issueId": "…", "issueKey": "MET-42", "role": "frontend", "agent": "frontend", "worktree": "…", "branch": "…", "interruptedAt": "…", "reason": "paused", "excludesFile": "…" }], "attempts": { "<issueId>": 1 }, "qaFailures": { "<parentId>": 1 }, "qaFeedback": { "<partId>": { "prUrl": "…", "reviewUrl": "…", "failing": ["…"] } }, "merges": [{ "qaId": "…", "qaKey": "MET-43", "parentId": "…", "parentKey": "MET-40", "parentUrl": "…", "approvedAt": "…", "prs": [{ "partId": "…", "partKey": "MET-41", "number": 7, "url": "…", "sha": "…", "mergedAt": "…", "needsHuman": "…", "labeled": true, "closedAt": "…" }] }], "gateFailures": { "<parentId>": 1 }, "humanPings": { "<prUrl>": "…" }, "selfUpdateNotices": { "<sha>": "…" }, "selfUpdate": { "from": "<sha>", "to": "<sha>", "at": "…", "state": "pending", "error": "…", "trigger": { "id": "…", "key": "MET-40", "url": "…" } }, "limits": { "claude-code": { "until": "…", "since": "…", "backoffMs": 900000, "endedAt": "…" } }, "shipped": { "<partId>": { "key": "MET-41", "branch": "…", "prUrl": "…", "at": "…" } }, "reviewedHeads": { "<partId>": { "sha": "…", "verdict": "approved" } }, "usage": { "<parentId>": { "input": 0, "cached": 0, "output": 0 } }, "usageBaseline": { "<parentId>": { "input": 0, "cached": 0, "output": 0, "at": "…" } } }
```

`pausedAt` is set only on an in-flight run that a pause is cancelling. `stopReason: "self-update"` is set with it when a waiting self-update stops the run. `interrupted[].reason` is `paused`, `self-update`, `uncommitted changes` or `commits not on the remote`; a file from before these reasons loads as `paused`. `excludesFile` is the run's exclude file, so synced files do not count as uncommitted changes; it is optional. `selfUpdate.state` is `pending`, `applying`, `done`, `blocked` or `failed`. `endedAt` is set only on an ended hold kept for its backoff.

Linear stays the source of truth. The file only records in-flight runs, paused runs, failure counts, the QA feedback a sent-back part gets in its prompt, the QA approvals waiting to merge, the needs-human notices already sent and the usage-limit holds. `reviewedHeads`, `usage` and `usageBaseline` are additive and optional: a file from before D-040 still loads. `shipped` is optional too: a file from before MET-128 loads with no shipped parts. An approval that cannot be read back whole is dropped rather than merged on a guess. If the file is unreadable, it is moved aside to `loop.json.corrupt-<ts>` and the loop starts empty.
