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
4. **Retry pending QA and reviews.** Post unfinished GitHub reviews and finish the Linear writes for verdicts in `pendingQa` or `pendingReview`. Each retry skips completed writes.
5. **State repair.** A shipped part that Linear moved back to In Progress goes to In Review again, before dispatch (see Ship). A split record whose parent is Done or Canceled is dropped (see Split).
6. **Orphan sweep.** The first tick after the daemon starts moves each part or QA sub-issue listed in a split record that Linear shows In Progress with no run in flight, no `pendingQa` record and no `shipped` record back to Ready, with one line: `<key>: In Progress with no run after restart, back to Ready` (MET-214, D-039, D-057, D-058). A split parent is never moved, because it is In Progress by design. A failed move is logged and kept in memory, and later ticks retry it until it succeeds; the sweep itself does not run again.
7. **Merge.** Every QA approval recorded in `loop.json` goes one step through the merge gate (see Merge).
8. **Dispatch** eligible sub-issues of admitted parents, then **split** the Ready issues the queue admits, then **dispatch** again.
9. **Save** `loop.json`.

The Linear client drops its connection pool after a network-class request error. A tick with any Linear network-class error advances an in-memory streak, and a clean tick clears it. On the third consecutive failed tick the loop resets the pool again, logs `Linear unreachable for 3 ticks, connections reset`, and clears the streak (D-058).

## Split
Every Ready issue without a part marker that the queue admits is first grilled (docs/COORDINATOR.md). The Ready column is the queue: `limits.max_parents` (default 1, D-050) caps the parents in flight, from a parent's grill until it is Done or Canceled (D-050, D-057), and the loop takes the top Ready parent in Linear's manual order (`sortOrder`, then priority, then oldest). A split parent in Needs input keeps its slot, and none of its parts or QA start until the owner moves it on. A parent without a split record, such as a grill escalation or a second bad plan, holds no slot. The other parents stay untouched in Ready. Each waiting parent logs one line per wait, `<key> waits, <in-flight key> is in flight`; with more than one in-flight parent the keys join with `, ` and the line says `are in flight`. A holder in Needs input reads `<parent> needs input` instead: two or more such holders join with `, ` and the line says `need input`, and with mixed holders the two clauses join with `, `. The loop logs again only when that set changes, each holder's Needs-input flag included, or the parent stops waiting and then waits again. Admission is by split record time, oldest first: the first `max_parents` in-flight parents are admitted, and no new grill starts while the count is at or over the limit. `max_parents` sits next to `limits.max_concurrent` and does not replace it: `max_concurrent` still caps agent runs at once (Dispatch).
- If the grill escalates, the issue goes to Needs input.
- If the grill errors, the issue is retried on the next tick.

The coordinator's harness then returns a plan as strict JSON:

```json
{
  "parts": [{
    "role": "backend",
    "title": "…",
    "size": "S",
    "goal": "one sentence",
    "doneWhen": [1, 2],
    "files": ["repo/relative/path.ts"],
    "steps": ["one action"],
    "verify": [{ "run": "command", "expect": "what its output must show" }],
    "outOfScope": "what this part leaves to another part",
    "decisions": [{ "id": "D-NNN", "line": "why it applies" }],
    "calls": [1, "a grill question this part follows"]
  }],
  "reason": "why the issue stayed one part, or why it split"
}
```

`role` is `backend` or `frontend`, and `size` is `S` or `M`. Only the parts the plan lists are created.

**Size rule (D-049).** A ticket stays one part only when it is small: one area (backend or UI), about 3 Done-when items or fewer, and about 5 files or fewer. Otherwise it splits. A part is at most size M. `MAX_PLAN_PARTS` (6) is the outer cap.

**Area split (D-049).** Backend work (shared types, API, daemon) comes first, in a backend part, and blocks the frontend part. The frontend part builds against the merged contract and runs on the frontend agent with its design checks. Docs changes go in the part whose code they describe; there is no separate docs part. Parts that list the same file are chained with `blocks`.

**Brief shape (D-049).** Each part has `goal`, `doneWhen`, `files`, `steps`, `verify` and `outOfScope`, all non-empty. The sub-issue body shows them as **Goal**, **Done when**, **Files**, **Steps**, **Verify** and **Out of scope** after the marker. **Decisions**, **Grill calls**, **Why**, **Spec links** and **Size** follow. The part's own Done when replaces the parent's full checklist. There is no free-text **Brief** section.

**Plan check (D-049).** The loop rejects a plan where a part has an empty field, more than about 3 Done-when items or more than 8 files, or where one parent Done-when item is in no part. It also rejects a part that lists a file in the other area, a frontend part before a backend part, and a docs-only part in a multi-part plan. A rejected plan goes back to the coordinator once with every error. A second bad plan moves the parent to Needs input.

**Role-scoped reading (D-044).** Each part names the decision records it depends on in `decisions`, one line each. A malformed entry makes the plan invalid. A well-formed id with no record file is dropped with one log line. The brief names those IDs and does not tell the agent to read the whole spec or every record. The builder reads its brief and the named records only.

**Grill calls (D-044).** Each part names the grill calls that apply to it in `calls`: the call numbers, or their question texts. The split writes them after the brief in the sub-issue body.

harnessd always adds a QA sub-issue, "QA: <parent title>". Every part blocks it (a Linear relation of type `blocks`).

**Serial parts (D-040, D-049).** When the split has more than one part, part 1 blocks part 2, part 2 blocks part 3, and so on. A part starts only after the part before it is merged (Done), so no two PRs of one parent are open at the same time. An interrupted split adds the missing relations on the next tick.

Sub-issues are Linear children of the parent, in the same team and project.
- They start in Ready and carry the parent's area label.
- Their body has the part marker, the fixed brief, Size, the decision IDs the part depends on, the grill calls it follows, Why and Spec links.

**Split note (D-049).** The parent comment lists each part with its key, role, size, goal and files, and the QA sub-issue with its blockers. It always ends with `Reason: <reason>`, for a split and for a one-part plan. While `qa.kind` is missing, the first split note also carries `QA runs no live app: .harnessd/config.toml has no [qa] kind (docs/CONFIG.md).` just before the reason, once per repo (MET-180).

When the split is done, the parent moves to In Progress.

**Idempotent.** The first line of each sub-issue body is a plain-text marker (Linear may drop HTML comments), such as `harnessd part: backend`, `backend-2` or `qa`.
- The split reuses a child only from the explicit reuse set the caller passes, and only when that child is not Canceled or Done. With a split record, the set is the record's part and QA ids; without one, it is this tick's plan: a live child whose marker matches a planned part and that was not in the child list before the grill. Every other child is left alone and is never reused.
- If a split was interrupted, the next tick finds the record, reuses its live children and finishes the split without grilling again.

**Split record (MET-154).** After `splitIssue` returns, and before the move to In Progress, the loop writes the parent id, its part ids, the QA id and the time to `splits` in `loop.json`. It saves at once, not at the end of the tick. Linear reads can lag a few seconds behind writes, so this record guards the next tick:
- `splitReady` reads the children once. If any recorded part id or the QA id is missing, the read is stale. It skips the parent with one line: `<key>: already split at <time>, Linear read is stale; skipped`.
- If the read holds every recorded id and no recorded work part is live, that is, every one is Canceled or Done, the loop drops the record and grills the parent again. The QA state is not part of this check. Before that grill it logs one line naming the marked children it leaves alone, in Linear child order, QA included: `<key>: old parts not reused: <key>, <key>`. It logs nothing when the parent has no marked children.
- Otherwise it goes on to the split, which reuses the record's live parts and QA, and does not grill again.

A re-split keeps the record's first `at` and only updates its parts and QA ids; a new record, after no recorded work part was live, gets a new time (MET-210).

**Re-read before the create (MET-154).** After the grill and plan, the loop reads the children again and builds the reuse set from that read: a live child whose marker matches a planned part and that was not in the child list before the grill. It passes that set to `splitIssue`, not a list matched by marker alone. So a part that shows up in the fresh read is reused, never created twice; an older plan's child is left alone. A Canceled or Done child is never reused.

**Dropping the record (MET-154).** Two rules, and no time window:
- An early-tick sweep reads each recorded parent. It drops the record when the state is Done, Canceled or Cancelled, ignoring case. A read error logs one line and keeps the record.
- The owner canceled or finished every recorded work part and moved the parent back to Ready on purpose. The record is dropped and the parent is grilled again. The old marked children are left alone, and the one `<key>: old parts not reused: ...` line names them before the grill.

## Sizes and budgets
- S runs for `limits.budget_minutes.S` (30 min), M for `limits.budget_minutes.M` (2 h). An issue with no size counts as M.
- L is never run. If the plan, or the fallback, still contains an L part, the issue goes to Needs input with a comment and one notice. The same happens to an L sub-issue.

## Dispatch
- `limits.max_concurrent` runs at once (default 1, D-040). Parallel parts of one parent touched the same files, and each merge sent the next PR back for another build and QA round, so the default is serial. A user may still set up to 3 (D-014 cap).
- At most `limits.max_parents` parents are in flight, and only the admitted parents' parts and QA dispatch (see Split, D-050). Admission is by split record time, oldest first, so parts of the other in-flight parents wait and log `<part key> waits, <in-flight key> is in flight`. A part or QA of a parent in Needs input does not start even when the parent is admitted: it keeps its place with no move and no comment, and logs `<part key> waits, <parent> needs input` (D-057). A marked child whose parent has a split record that does not list its id belongs to an older plan: dispatch leaves it alone, with no move and no comment (MET-217). A part whose parent has no split record was not split by the loop and runs as before. A per-part QA round reviews only the parts the record lists.
- A part is eligible when it is in Ready and nothing unfinished blocks it. With serial parts, part 2's blocker is part 1 until part 1 is Done (merged).
- A QA sub-issue is eligible when a part of its parent is In Review at a head QA has not approved (see QA).
- Each run:
  - gets its own worktree and branch (D-012);
  - uses the adapter for its agent's harness;
  - gets a prompt made of the agent's layered instructions plus the sub-issue body;
  - runs within the budget for its size;
  - stops at its turn cap (D-045): a builder part's `limits.max_turns` for its size, QA 40 for S and 80 for M (D-047), or coordinator grill and plan 50.
- Before a part or QA run starts, and before a rework run, the loop checks the parent's weighted token sum against `limits.token_budget`. At or over it, nothing starts and the parent goes to Needs input (see Token budget).
- The prompt tells the agent to edit and test in the worktree only. It does not commit, push or open the PR: the daemon ships the work after the run (D-039). A part that QA sent back gets the failing items and works on its open PR; when the harness and worktree allow it, the run resumes the part's own earlier session (see QA, D-046).
- A QA sub-issue runs the QA round below instead of a single agent run.
- When the sub-issue starts it moves to In Progress. When the run finishes:

| Result | What happens |
|---|---|
| ok | The daemon ships the run (see Ship). The sub-issue then moves to In Review. |
| error, timeout or turn cap, first time | A comment is posted and the sub-issue goes back to Ready for one retry. |
| error, timeout or turn cap, second time | A comment is posted, the sub-issue moves to Needs input and one notice is sent. |
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
- **Role skill set (D-040, D-043, D-044, MET-222).** A worktree run gets the pack for its role. `frontend` keeps `impeccable` and `domain-modeling`, and drops `grilling`, `research`, `prototype`, `grill-with-docs` and `code-review`. `coordinator` keeps the grill, reading and domain-modeling skills, and drops `impeccable` and `code-review`. `backend` and `qa` drop those five and `impeccable`, because their work needs none of those bodies. `reviewer` keeps `code-review`, `codebase-design`, `tdd`, `diagnosing-bugs` and `domain-modeling`, and drops `impeccable`, `grilling`, `research`, `prototype` and `grill-with-docs`. The map is built in, not config: `enabled = false` still turns a skill off for everyone. A worktree cut from `main` already holds the skill folders the repo commits, so the loop removes a withheld folder from that worktree and marks its tracked files `skip-worktree`; git sees no deletion and the agent commits, pushes and opens the PR as usual. The main checkout is not touched. A later run that does not withhold a folder puts the committed folder back. The D-028 hook stays for frontend runs.
- **MCP servers (D-040).** A worktree run gets only `harnessd-memory`. A `[mcp.<name>]` server in the config does not load into a worktree run, so its tool list is not sent.
- **Measured size.** The base prompt is measured, not guessed. The numbers below are from `packages/daemon/src/coordinator/prompt-size.test.ts`, this repo's committed skill pack and its sync output. A character is about a quarter of a token.

  | Item | Builder or QA run | Frontend run |
  |---|---|---|
  | Part prompt (fixture issue) | about 1.1k chars | unchanged: it is already only the agent, the task and the memory pointer |
  | QA prompt (one PR, diff cut at 24k chars) | about 3.6k chars | unchanged: the diff, CI, tests and checklist are the whole job |
  | `AGENTS.md` (this repo, rules included) | 4,775 chars | unchanged: agents must read the repo rules |
  | `SKILL.md` bodies, committed pack | 37,065 chars (8 of 14) | 49,727 chars (9 of 14; keeps `impeccable`) |
  | QA run `SKILL.md` bodies | 37,065 chars (8 of 14; no `code-review`) | — |
  | Reviewer run `SKILL.md` bodies | 43,756 chars (9 of 14; keeps `code-review`) | — |
  | `opencode.json` MCP and permission tables | 687 chars | unchanged |
  | `harnessd-memory` tool list | 1,878 chars | unchanged |
  | **Static total from the sync** | **about 44.2k chars, about 11.1k tokens** | **about 56.9k chars, about 14.2k tokens** |
  | Owner `~/.claude/skills` + `~/.agents/skills` (out of scope, MET-112) | 73,829 chars, measured 2026-11-22 | same |

  The coordinator's grill and plan runs get no worktree sync and read this repo's spec and decision records instead: about 86.1k and 74.5k chars for this repo. The skill row counts the folders a worktree cut from `main` holds, read from `HEAD`, not only the files sync generates. The test is `the committed skill pack…` in `prompt-size.test.ts`.

  **Builder first turn, before and after role-scoped reading (D-044).** The first turn measures the part prompt plus what the run reads because of it. Before D-044 the rules told every builder to read the spec and every record, so the before row includes both. After D-044 the part body names the records and the grill calls it needs, so the after row includes only those.

  | Builder first turn | Chars | About tokens (4 chars each) |
  |---|---|---|
  | Before: part prompt with the read-spec brief + SPEC + all decision records + AGENTS.md + the full builder skill pack | 121,436 | 30,359 |
  | After: part prompt with decision lines and grill calls + the named records + AGENTS.md + the reduced skill pack | 49,051 | 12,263 |

  The test `role-scoped reading shrinks the builder's first turn` asserts that after is smaller and prints both numbers.

  **Per harness, first turn.** The same files reach every harness, but each reads its own layout. The static total is an upper bound: a harness that loads a skill body on demand sends less.

  | Harness | What the sync adds | First turn |
  |---|---|---|
  | Claude Code | `AGENTS.md`, `.claude/skills/`, `.mcp.json` with `harnessd-memory` | not measured on a real run; about 10.3k static tokens |
  | Codex | `AGENTS.md`, `.agents/skills/`, `.codex/config.toml`, `.codex/hooks.json` | not measured on a real run; about 10.3k static tokens |
  | OpenCode 2.3.2 | `AGENTS.md`, `.claude/skills/` and `.agents/skills/`, `opencode.json` | **9,328 tokens** (8,944 input + 384 cache read) on the first `step_finish` of a short real run in this worktree, deepseek-v4.1-flash |

  The same prompt in an empty folder, with no project files, took **7,437 tokens** (5,645 input + 1,792 cache read). That is OpenCode's system prompt and built-in tool schemas. The worktree files and the `harnessd-memory` tool list add about **1.9k tokens**. The static skill count is an upper bound because OpenCode exposes skills through its `skill` tool and loads a body only when it uses it.

  **What grows the turn.** The MET-128 build averaged about **190k tokens per turn**: 12,257,280 cached tokens over about 65 turns, plus the new input. The base prompt is about 9k to 12k of that. The rest is the conversation and the tool output it carries, which every later turn sends again.

  - OpenCode caps one tool result at `tool_output.max_lines` 2,000 and `max_bytes` 51,200 (about 50 KiB) by default. A builder worktree run sets `max_bytes` to 20,000 (about 20 KiB) and leaves `max_lines` at 2,000 (D-045).
  - Automatic compaction is on by default: near the context limit OpenCode replaces older conversation with a summary, keeps about `compaction.keep.tokens` 15,000 recent tokens, and shortens long tool output in that tail. A builder worktree run sets `keep.tokens` to 20,000 and `buffer` to `"50%"`, so compaction starts near 100k tokens of a 200k window (D-045). It can only reclaim conversation, not fixed instructions and tool schemas.
  - So a full test run or a large file read stays in context as one capped tool result, then in the summary and the recent tail after compaction. Focused tests and file ranges keep those results small.
  - Claude Code and Codex cap one tool result near 5k tokens: `BASH_MAX_OUTPUT_LENGTH=20000` and `-c tool_output_token_limit=5000` (D-045).

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

## Review
The reviewer judges each part PR's code before QA (D-060). It runs read-only in a scratch checkout of the PR head, holds one `max_concurrent` slot, and uses the part's size budget and reviewer turn cap. Code: `packages/daemon/src/coordinator/review.ts`.

A review starts when a shipped part is In Review and `reviewerHeads` in `loop.json` has no verdict for the current PR head. Only an admitted parent's parts get a review, and a parent in Needs input keeps its slot with no new review (D-050, D-057). A head equal to an approved or sent-back sha gets no new review. A part this daemon never shipped in its state, or one of a parent it never split, still gets its review when a QA round is waiting on it: the wait starts the review, holds the QA sub-issue Ready and logs the same wait line (MET-226).

The reviewer returns strict JSON:

```json
{
  "decision": "approve" | "changes_requested",
  "findings": [
    { "file": "string", "line": 1, "severity": "blocking" | "nit", "kind": "code" | "design", "text": "string" }
  ]
}
```

The daemon posts one GitHub `COMMENT` review at the head with every blocking finding and nit, each with its file and line. Nits stay on the PR: they never send a part back, never reach `qaFeedback` and never start the builder.

After the verdict:

| Result | What happens |
|---|---|
| approved | Nothing is sent back. `reviewerHeads` records the approved head, and QA may start on it. |
| blocking code finding | `qaFeedback[part.id]` gets `source: "review"` and a numbered fix list, `R1 (file:line) text`. The part goes to Ready, and its next run is a send-back: it resumes the builder's own session when D-046 allows it, otherwise it starts cold. The prompt says to fix only these findings, run focused tests and the Verify commands, and not commit. Nothing goes to the coordinator (D-059). |
| blocking design finding | The part and the parent move to Needs input. One parent comment lists the design findings, and one `needs_input` notice goes out with the reason `reviewer found a design fault`. Nothing is sent back to the builder. In a mixed verdict, the design rule wins (D-059). |
| review failed twice on one part | The part and the parent move to Needs input with one comment and one notice, and nothing is sent back again. `reviewFailures` counts failed reviews per part, apart from QA and gate failures, and reuses `limits.qa_max_failures` (default 2, D-014). It is cleared at Done and on escalation. |
| not judged | A turn cap, a timeout, a stall or a reply that is not JSON after the backslash repair is not judged (D-052). The same head is re-queued with no review failure and no `reviewerHeads` entry, and one log line says `<part key>: review not judged (<reason>), re-queued`. A timeout or stall also moves the next run to the next harness (D-048). |
| not judged twice on one head | The part and the parent move to Needs input. One comment on the parent states both reasons and one notice goes out with the reason `review not judged twice`. No review failure is counted. The in-memory count clears on a judged verdict, a new head and an escalation. The loop writes the decision and its reasons to `pendingReviewSettle` in `loop.json` before the first write, so a restart finishes the escalation from the saved reasons and sends the notice once (MET-232, D-052, D-058). |

**Delta review (D-060).** `reviewerHeads[part.id]` holds `{ sha, verdict, findings, at }`. On a new head, the review diffs the recorded `sha..head` when the recorded sha is an ancestor of the head, and otherwise reviews the full PR diff, for example after a gate conflict merge. Either prompt lists the earlier blocking findings so the reviewer checks that they are fixed.

## QA
QA reviews one PR, when that part reaches In Review (D-040, D-049). It checks the part's own "Done when" and "Verify" sections against the running product before anything merges (D-013, D-051). A part body from before D-049 has no such sections; QA then falls back to the parent's checklist. QA does not read the whole repo.

QA starts only after the reviewer approved the same PR head (MET-226, D-060). While a part of the round waits for its review, the QA sub-issue stays Ready and the loop logs `<QA key> waits, <part key> review pending`, once per wait and again only when the pending set changes (D-050). A `QA: tests` part waits the same way (D-053). If the PR head moves while the round runs, the verdict names a head the reviewer has not seen: the round posts no review, re-queues with no QA failure, and the delta review then QA run on the new head (MET-226).

Before QA, the loop reads the PR's `headRefOid` and compares it with the part's **reviewed head** in `loop.json`:
- the same sha as an approved part: QA does not run again;
- a new sha: QA runs once, after the reviewer approved that head, as a full round or a re-QA;
- an approved part whose PR head did not change stays approved and goes to the merge gate.

A round is a **re-QA** when the reviewed head has verdict `changes_requested`, a non-empty `cases` array and a sha that differs from the PR's head (D-055). The cases are written to `reviewedHeads[part].cases` when QA requests changes, next to the sha and verdict, so they survive the builder's ok run that deletes `qaFeedback`. An approval writes no cases. With no saved cases (a legacy entry, a missing-PR send-back or a merge-gate send-back) or the same head, the round is a full round 1. A `QA: tests` part reruns its Verify commands as today (step 4).

For each part:
1. **Find the PR.** It is the newest open PR with the part's key in its title (`gh pr list --json`). With no PR, the part is sent back.
2. **Check it out.** The PR's head commit is checked out in a worktree of its own, detached, and removed afterwards even when it has local changes. A QA checkout is never kept (D-041).
3. **Run the tests.** harnessd runs `qa.setup_command` and then `qa.test_command` (default `pnpm test`) in that worktree.
4. **QA from tests (D-053).** A part whose body says `**QA**: tests` and whose every Verify line has a backticked command before `→` starts no app, no browser and no QA agent. After step 3, harnessd runs each Verify command in order, taken from the backticked text before the arrow, through the same runner in the PR-head checkout; all the commands share the round's budget. A command passes on exit 0 only: a timeout or a spawn error is a failing command, and the first failure stops the run. When every command exits 0 the daemon approves, with one passing item per part Done-when item plus the `Verify` item, each carrying the commands and their exit codes as evidence. A failing command requests changes with `Verify: \`<cmd>\` exited with code <n>`, gets daemon case `T1` with item `Verify` (D-054), and the last 3,000 characters of its output become `qaFeedback.testTail` for the send-back. The review body starts with `not run live: QA from Verify commands`, no usage or turns are recorded, and the round logs `<QA key>: QA from Verify commands on <part key>, <n> commands`. A Verify line with no backticked command logs one line and falls back to the QA agent at step 6.
5. **Start the app (D-051).** When `[qa]` sets `kind`, harnessd runs `qa.build` and `qa.seed`, picks a free port on 127.0.0.1, replaces `{port}` in `qa.url` and `qa.start`, runs `qa.start` through `sh -c` with `PORT` set and its own process group, and waits for `qa.health`. A `health` value that starts with `/` is a path: HTTP GET to the url origin plus the path passes on a 2xx or 3xx answer. Any other value is a command, and exit 0 passes. Each probe has a 5 s limit, and harnessd polls once a second for 2 minutes. `build`, `seed`, `start` and `health` get only `PATH`, `HOME`, `USER`, `SHELL`, `TMPDIR`, `LANG`, `TERM`, `PORT`, `HARNESSD_QA_AREA` and the names in `qa.env`, taken from the daemon's environment; an unset name is skipped with one log line. `setup_command` and `test_command` keep their environment. A cli runs `build`, `seed` and one `health` command; harnessd starts no server for it. A failing `qa.test_command` skips the app, so a PR that breaks the build is a test result, not a setup error. The app is stopped in every teardown of the round (approve, changes requested, error, limited, setup error, timeout and pause) with the tree kill (D-048).

   A **web** review also gets a browser (MET-179). After health passes, harnessd finds an installed Google Chrome first and then a Playwright Chromium, and launches it headless with remote debugging on a free loopback port. It downloads nothing. A missing browser, a browser that exits before it answers and a debug port that stays quiet are `browser` setup errors (D-041), and the log line names the fix: install Google Chrome, or a Playwright Chromium with `pnpm exec playwright install chromium`. The browser is stopped with the tree kill at teardown, like the app. Only the QA run's environment gets `HARNESSD_QA_BROWSER` (the CDP endpoint), `HARNESSD_QA_RUN` (the run id) and a `PATH` with the `qa-browser` folder first; builder and coordinator runs get neither. `@harnessd/daemon` ships `qa-browser` as a bin, and it drives the page the last command left open:

   ```text
   qa-browser open <url> --width <n> --height <n>
   qa-browser click <selector>
   qa-browser type <selector> <text>
   qa-browser text <selector>
   qa-browser check <file.js>
   qa-browser screenshot <name>
   ```

   Every command prints one JSON object, `{ ok, command, result | error }`, and exits 0 when ok and 1 when not. `open` sets the viewport, and the commands that follow and their screenshots keep that size. `check` evaluates the file in the page and returns its value. Screenshots go to `<HARNESSD_HOME>/qa/<run id>/<name>.png`, and the JSON returns the path relative to `HARNESSD_HOME`.
6. **Ask the QA agent.** Its prompt holds the PR diff from `gh pr diff`, cut to a fixed limit, with the file list after the cut; the part's own "Done when" and "Verify" sections; the part brief, including the decision IDs it names and the grill calls it follows; the CI result from `statusCheckRollup`; the harnessd test result; and, for a live app, its url and kind. It reads the part diff, those decision IDs, the part's items and Verify commands, CI and the tests. It does not read `docs/SPEC.md` or every record. It judges each item only against the running product and the tests. The diff and CI show what changed and where to test, not whether an item passes, and QA does not review the code: the reviewer does that (D-060). Its last message must be strict JSON, one item per part "Done when" item plus one last item, `Verify`, and one case per failing item (D-054):

   ```json
   {
     "items": [{ "text": "…", "pass": true, "evidence": "…" }],
     "testsPassed": true,
     "cases": [{ "id": "C1", "item": "…", "repro": "…", "expected": "…", "actual": "…" }]
   }
   ```

   In the `Verify` item, QA runs each command of the part's Verify section and quotes its result as the evidence. A part body without the sections uses the parent's checklist, as before.

   **Cases (D-054).** `cases` is a top-level array of `{ id, item, repro, expected, actual }`, every field a non-empty string. `id` is `C1`, `C2`, … in reply order. `item` is the exact `text` of a verdict item whose `pass` is false, or `Verify`. `repro` is the exact command or numbered steps that reproduce the fault, `expected` is what should happen and `actual` is what happened. One case per failing item. When every item passes, QA sends `cases: []`. A missing or empty field, an unknown key, an id out of order or an `item` that names no failing verdict item and is not `Verify` is a schema error, and counts a QA failure.

   **Re-QA prompt and verdict (D-055).** A re-QA still runs steps 3 and, for a `QA: agent` part, step 5, so the app and browser follow the D-051 rules unchanged. The QA agent's prompt holds only the PR and its head, each saved case with its `repro`, `expected` and `actual`, the part's Verify commands, the test command with its result, and the running app when there is one. It holds no diff, file list, part brief, Done-when list, decisions or memory. It tells QA to run each repro and each Verify command, judge each saved case pass or fail, and write no new probes. Its last message is strict JSON with exactly one entry per saved case id and one `verify` result:

   ```json
   {
     "cases": [{ "id": "C1", "pass": true, "evidence": "…" }],
     "verify": { "pass": true, "evidence": "…" }
   }
   ```

   A missing, duplicate or unknown case id, an unknown key or empty evidence is a schema error and counts a QA failure. Invalid JSON after the backslash repair stays not judged, as in D-052. The round then follows step 7, with the saved cases and the `verify` result in place of the item list. The round logs `<QA key>: re-QA of <part key> at <head7>, <n> saved case(s)`.

   **Re-QA result (D-056).** A re-QA approves only when every saved case passes, the `verify` result passes and `qa.test_command` exited 0. Its review lists every saved case as `C<n> (<item>): pass: <evidence>` or `fail: <evidence>`, plus a `Verify` line, and an approval sends the part to `merges` with `reviewedHeads` approved and no cases. A failing re-QA sends back only the saved cases that still fail: each keeps its `id`, `item`, `repro` and `expected` and gets the new `actual` from its evidence. A failing test or `verify` keeps or adds daemon case `T1`, and the re-QA adds no other case. It counts one QA failure, so with `qa_max_failures` 2 the second failed round moves QA and the parent to Needs input.

   **Live run (MET-180).** For a running product the prompt names the kind and the url with its real port, or the command for a cli, and tells QA how to test each item: a web app with `qa-browser` at 390x844 and 1280x800, an api with curl (or another HTTP client), a cli by running its commands. Each item's evidence is the command it ran, the response it got or the screenshot path. QA judges each item only against the running product and the tests: the diff shows what changed and where to look, not whether an item passes, and QA does not review the code (D-060). With no live app — no `qa.kind`, or the third app setup error on one head — the prompt judges each item from the tests, and the posted review body starts with `not run live: no [qa] kind in .harnessd/config.toml` or `not run live: app <step> failed` (D-013). An item the live product cannot reach is judged from the tests, with evidence `not reachable live: <reason>; <test>`, and it fails only when no test proves it.

7. **Review.** harnessd approves only when every item passes and the tests pass, both when harnessd ran them and for the agent. Otherwise it requests changes and lists each failing item with its evidence. When the daemon itself fails `qa.test_command`, it builds case `T1` with item `Tests`; when a `QA: tests` part's Verify command fails, `T1` gets item `Verify`. Its repro is the command, expected is `exit 0`, and actual is the exit code or `timed out` plus the test tail. A missing PR keeps its failing line and gets no case. GitHub does not let you approve your own PR, so when every agent shares one `gh` login, the verdict is posted as a comment review.

Output that is not valid JSON after the backslash repair is **not judged** (D-052). A reply with the wrong number of items, an unknown key, missing evidence or a malformed case is a schema error and still a failed QA run: it counts a failure. A request-changes verdict from the agent with `cases: []` is not judged with reason `no_cases`, log line reason `verdict has no failing case` (D-052, D-054). No review is posted for either.

**Backslash repair (D-052).** A model reply sometimes holds a stray backslash inside a JSON string, for example before a backtick or a dollar sign. Only after the first `JSON.parse` fails, `parseQaVerdict` scans the text left to right inside strings and turns a backslash before a character JSON does not allow after it into an escaped backslash plus that character. A valid pair such as `\\` or `\"` is kept as it is, and `\u` with bad hex is not repaired. The repair runs on the extracted text and on each trailing-object candidate, so a verdict in prose is still found.

After the round:

| Result | What happens |
|---|---|
| pending settlement | A network error while posting the review or settling its Linear writes leaves the QA ticket In Progress and saves the verdict in `pendingQa`. Later ticks resume the unfinished writes without rerunning QA (D-058). The saved review keeps its `stale` flag, so a reload after a restart re-queues the round with no QA failure and no escalation (MET-232). |
| approved | The part's PR goes to `merges` in `loop.json` as one entry with one PR, pinned to the reviewed head, and the merge gate takes it. `reviewedHeads` records `approved` with no cases (D-055). QA stays Ready for the next part. |
| changes requested, first failure | The part goes back to Ready with a comment that links its review. The reviewed head records `changes_requested` with the cases; QA runs again only on a new head, as a re-QA of those cases (D-055). Its next run resumes the part's own session on the same harness and worktree when it can, with only the failures; otherwise it starts cold (D-046). The cases are saved in `qaFeedback` and the send-back prompt gives them as a numbered fix list (D-054). A failed re-QA saves only the cases that still fail, each with its new actual (D-056). |
| QA could not set up the review | QA goes back to Ready and runs again. No QA failure is counted and no comment is posted: the PR lookup, checkout, worktree sync, the budget before the agent, an app build, seed, start or health step, or the browser step failed (D-041, D-051). |
| QA not judged | QA goes back to Ready and runs again. No QA failure is counted, no review is posted, nothing goes to `reviewedHeads` and the same head runs again: the QA agent run ended on its turn cap, its time limit or a stall, its verdict was not valid JSON after the backslash repair, or it requested changes with `cases: []`. The log line is `<QA key>: QA not judged (<reason>), re-queued`, with `turn cap (<n> turns)`, `timed out`, `stalled`, `verdict not JSON: <error>` or `verdict has no failing case`. A round that mixes setup errors and not-judged reviews is re-queued the same way; any `request_changes` in it still counts one failure (D-052, D-054). |
| QA not judged twice in a row on one head | QA and the parent move to Needs input. One comment on the parent states the reason and one notice says `QA not judged twice`. `qaFailures` and the part's session do not change, and the part's saved cases are deleted from `reviewedHeads` and `qaFeedback`, so the next QA after a human move is a full round. The in-memory count clears. A judged verdict or a new head clears the count; a setup error leaves it as it is (D-052, D-056). |
| app setup failed three times on one head | The review runs with no live app, counts no QA failure and keeps `app <step> failed` as the reason; its body starts with `not run live: app <step> failed` (D-051, MET-180). A new head resets the count. |
| second failure | QA and the parent move to Needs input. One comment goes on the parent and one notice is sent. Nothing is sent back again, and the parts' saved cases are deleted from `reviewedHeads` and `qaFeedback`, so a later QA after a human move is a full round (D-014, D-056). |

A network-class write error during settlement contributes no QA failure or not-judged count and does not trigger a Needs input escalation. After the writes recover, the original verdict follows the usual rules. A request-changes verdict counts once and keeps its original cases. The setup-phase re-queue rule still applies (D-041).

**Send-back (D-046).** A part goes back to Ready when QA requests changes, and for a failed check or a conflict at the merge gate. Its next run is a send-back, because `qaFeedback` holds its failures. The loop writes the run's session to `sessions` in `loop.json` when a part run ends with one. On the send-back it resumes that session when all of these hold: a session is stored; the stored harness is the harness this run starts on; the new worktree path and branch are the stored ones; and the adapter can resume. Then it logs `<key>: resuming <harness> session` and the prompt holds only the PR and review urls, the failures and the tail of the failing tests. It says: fix only these items, run focused tests, and do not commit, push or open a PR (D-039). The brief, the decisions, the grill calls, the memory and the AGENTS text are left out: the session already holds them. A cold send-back keeps the full part prompt, review included.

**Cases in the send-back (D-054).** When QA saved cases, both the cold and the resumed prompt replace the bullet list with a numbered fix list: `1. C1 (<item>)`, then `repro:`, `expected:` and `actual:` lines. They say: fix only these cases, add one test per case, then run the part's Verify commands. The resumed prompt also lists the part's Verify commands from the part body, because it carries no brief. With no cases, the prompt keeps the `failing` list above.

When a resume is not possible, the run starts cold and logs `<key>: cold run (<reason>)`. The reason is `no session`, `session on <harness>, run on <harness>` after a fallback (D-035), `other worktree` when a title change moved the branch, or `<harness> cannot resume`. When the tests failed before the review, `qaFeedback.testTail` holds the last 3,000 characters of their output, and the resume prompt shows them. A passing test run stores no tail.

Some resumed runs end `error` with zero turns, or with no turn count, and with no ship: the harness no longer has the session. The loop then drops the session, logs `<key>: resume failed (<error>), cold next`, counts no attempt and moves the part back to Ready. The next dispatch starts cold. A resumed run that took turns and then failed follows the normal error rule (D-014). A resumed run gets the same budget, turn cap and token accounting as any part run (D-043, D-045).

The QA sub-issue moves to Done after the last part of the parent merges. The final check on main and the follow-up issue stay in MET-86.

A QA agent run that ends `limited` stops the round. No review is posted, no QA failure is counted and QA goes back to Ready.

A QA agent run that ends at its turn cap (S 40, M 80) is not judged: it re-queues with no QA failure and the same head runs again (D-052). A timeout, a stall and a verdict that is not JSON after the repair follow the same rule. The second not-judged run in a row on that head goes to the human.

The whole round runs within the QA sub-issue's size budget. Failures are counted per parent, up to `limits.qa_max_failures` (default 2).

## Token budget and usage
Each run ends with one log line: `<key>: <agent> used <input> input, <cached> cached, <output> output tokens in <n> turns`, where cached is cache read plus cache write. `n` is the harness's own count: OpenCode's `step_start` steps, Codex's completed tool items (a command run, a file change, an MCP tool call or a web search), or Claude Code's `num_turns`. A run with no count keeps the line without `in <n> turns`. The loop adds the run's raw tokens to the parent's **usage sum** in `loop.json` under `usage`, so the sum survives a restart. The board shows the sum as one compact count with a tooltip that splits input, cached and output.

Some runs report no usage. A Codex run that is killed or stopped before its first completed turn sends no `turn.completed`, so its token zeros mean unknown, not zero. Its line is `<key>: <agent> usage unknown in <n> turns`, or `<key>: <agent> usage unknown` when the harness reported no turn count. That run adds nothing to the parent's usage sum or weighted budget: a killed Codex run reports no usage and adds 0 to the budget. When every reply of a QA round, grill or plan has unknown usage, that round's sum is unknown too; when only some replies are unknown, the loop adds the known ones and logs the normal line. A run that reports real usage counts in full, with the D-043 weighting.

The **token budget** is weighted (D-043): `limits.token_budget`, keyed by size like `budget_minutes`: S 3M, M 6M. An unknown size counts as M. The weighted sum is `input + output + round(cached × limits.cached_token_weight)`, with `limits.cached_token_weight` from 0 to 1 and default 0.1; at 1 it is the old raw count. `cached` is cache read plus cache write. It sums every run of the parent over its grill, plan, part and QA runs. Before the loop starts a new part run, QA run or rework round, it compares the weighted sum with the budget:
- below the budget: the run starts;
- at or over it: nothing starts. The parent moves to Needs input, with one comment that states the weighted total, the budget, and the raw input, cached and output parts with the weight, and one notice (the D-011 escalation shape). A run in flight finishes normally.

The raw sum at escalation is recorded as `usageBaseline` in `loop.json`, as the parent's cumulative sum (not the delta), so the next count subtracts it. When a human moves the parent back to Ready, the budget counts from that point, also after a second escalation. `usage` and `usageBaseline` stay raw, so an old `loop.json` loads and the board count is unchanged.

### Turn cap
Every run has a turn cap (D-045). A builder part run uses `limits.max_turns` for its size (S 80, M 160; an unknown size counts as M). QA uses 40 for an S parent and 80 for an M parent (D-047), and coordinator grill and plan use 50. The caps come from the MET-131 measurements: 80 turns is about 1.8M weighted tokens, under the S budget of 3M, and 160 turns is about 3.6M, under the M budget of 6M.

- **Claude Code** gets `--max-turns <n>`. A result with subtype `error_max_turns` ends the run `error` with `turn cap (<n> turns)` and no failure reason.
- **Codex and OpenCode** count turns in the adapter: OpenCode at `step_start`, Codex at each completed tool item. At the cap the adapter kills the process group the way a cancel does and reports `error` with `turn cap (<n> turns)`, not `cancelled`.

A turn-capped run follows the normal error rule: it counts one attempt, it is not shipped, and the keep guard keeps unshipped work for the next attempt. A turn-capped QA run is not judged and counts no QA failure (D-052). A turn-capped grill or plan run is an error run; the plan retries once, and a second bad plan moves the parent to Needs input (D-049). The wall-clock budget and the token budget stay; the first limit that a run hits stops it, and a time-budget stop stays `timeout`.

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

While a hold lasts, no part, QA, grill or plan run starts on that harness. The run moves to the next usable harness in the fixed role order (D-048, replaces the D-035 fallback rule). A harness is usable when it has an adapter, no hold, and no `harness.<id>.cli` or `harness.<id>.auth` check in state fail or missing. A harness with no check result yet counts as usable. When none is usable, the issue waits in Ready and the loop logs `<key>: no harness left (<harness> <why>, ...)` once per set of reasons. Agents on other harnesses dispatch as usual. Runs in flight are not cancelled. More limited runs during a hold do not double it. An ok run that ends after the hold clears the backoff. An ok run that ends during the hold leaves the hold as it is.

The log gets one line when a hold starts and one when it ends, in the daemon's local time:

```
Claude Code limited until 18:37
Claude Code limited until 17:52 (backoff)
Claude Code available again
MET-61: Claude Code is limited, running on Codex
```

GET /api/loop and the `agents` event list the holds in force under `limits` (docs/API.md). The app reads them for "Claude Code limited until HH:MM".

The daily summary records each hold's start and end. It adds one line per harness with the limited time since the last summary, such as `Claude Code limited 2h 10m`. A hold still open counts up to the summary time and carries over to the next. A hold that expired while the daemon was off counts only up to its recorded expiry. An end entry also carries the hold's own start. So a hold with no recorded start counts from its start, not from the last summary. A day with no hold has no such line. No Slack notice goes out per hold.

## Harness switch (D-048)
A run that fails on its harness moves to the next harness in a fixed role order. The work stays in the same worktree. The order is in code (`HARNESS_ORDER` in `coordinator/limits.ts`): coordinator claude-code, codex; backend and frontend opencode, codex, claude-code; qa codex, claude-code. The run's list is the configured harness, then `fallback_harness` when it differs, then the role order, without duplicates and without unusable harnesses. `fallback_model` applies only on the `fallback_harness`; any other harness gets no `--model`.

| Run ends | Switch? | Attempt |
|---|---|---|
| `timeout`, a stall (`stalled`), reason `auth`, any other adapter error | yes | counted, as before (D-014) |
| `limited` | yes: the harness is held (D-034) | none |
| turn cap (D-045), ship failure (`no changes`, `push failed`, `pr failed`), invalid QA verdict, invalid grill or plan reply | no: same harness | as before |

A switch is recorded in `harnessSwitch` in `loop.json`. The next dispatch picks the first usable harness after `from`, or the first usable one when none follows. An ok run, Needs input and Done delete the record. A grill or plan timeout, stall or harness error records the switch on the parent, and the next tick uses the next coordinator harness. MAX_RUN_ATTEMPTS stays 2.

**Stall watchdog.** A run with no event for 10 minutes is stopped like a timeout and ends `error` with `stalled (no output for 10 min)` and reason `stalled`. Every stop (cap, stall, timeout, pause, cancel, daemon exit, the QA test command) signals the run's group and each descendant's group, then SIGKILLs after the grace time.

**Log lines.** `<key>: <from> <why>, retrying on <to>`, with `<why>` one of `timed out`, `stalled`, `hit its usage limit`, `is not signed in`, `failed (<error>)`. The line is logged when the next run starts. A hold with no earlier failure logs `<key>: <harness> is limited, running on <to>`. The run row in the app shows the run's harness and the reason.

## Merge
The merge gate (D-013). Code: `packages/daemon/src/coordinator/merge.ts`. A PR merges only when **all** of these hold:
- QA approved it, at the head it still has;
- the reviewer approved it, at the same head (MET-226, D-060);
- CI is green;
- it touches no protected path.

**Approval.** GitHub's review state cannot be the record: on a PR opened by the same `gh` login, the verdict is only a comment review. So harnessd records the approval itself. Each approved part adds one entry to `merges` in `loop.json`, with the part's PR number and the head sha QA checked out and reviewed (D-040). The reviewer's verdict in `reviewerHeads` must name that same sha and be `approved`; otherwise nothing merges.

**Each tick**, every PR in `merges` is read again with one call, `gh pr view <n> --json number,url,state,headRefOid,mergeable,statusCheckRollup,files,changedFiles`. Then, in this order:

| Finding | What happens |
|---|---|
| merged on GitHub | A human merged it: the part moves to Done. |
| closed, not merged | The parent moves to Needs input, with a comment and one notice. The approval is dropped. |
| head is not the approved sha | Nothing merges unreviewed. QA moves back to Ready. The delta review runs on the new head, then QA runs after approval. No QA failure is counted. |
| a changed file matches `merge.protected_paths` | Needs a human (below). |
| GitHub listed fewer files than `changedFiles` | Needs a human: the paths could not all be checked. |
| a check failed, or the PR conflicts with its base | Sent back (below). |
| a check is pending, there are no checks yet, or mergeability is still UNKNOWN | Nothing happens. The next tick looks again. |
| the reviewer has not approved the PR head | Nothing happens. The next tick looks again, after the review at that head. |
| every check passed and both approvals name the PR head | `gh pr merge <n> --squash --match-head-commit <approved sha>`. The part moves to Done, with a comment and a notice to the notifier (D-015). |

- **CI green** means at least one check, and every check passed: a check run that completed with SUCCESS, NEUTRAL or SKIPPED, or a commit status of SUCCESS. When a check was re-run, only its latest run counts. Any other conclusion fails. A PR with no checks waits, because D-013 needs CI green.
- **Needs a human.** The PR gets the `merge.label` label (default `needs-human`; the label is created when the repo lacks it). The parent moves to Needs input with one comment, and one notice is sent. The notice is recorded under `humanPings` in `loop.json`, keyed by the PR URL, before it is sent. So a PR gets one notice, across ticks, restarts and new QA rounds. harnessd never merges that PR. It keeps reading it, and once a human merges it, the part moves to Done. A merge GitHub refuses (branch protection, a draft) goes the same way, with gh's error in the comment.
- **Sent back.** A failed check or a conflict is a gate failure for the parent. The rule is the QA one: sent back once, then escalated (SPEC step 6, D-014).
  - The first failure sends each failing part back to Ready. Its next prompt lists the failing checks, like QA feedback, and it pushes to its open PR. QA moves to Ready and runs again once the parts are back in review. The send-back writes no cases, so its next QA is a full round (D-056).
  - The `limits.qa_max_failures`-th failure (default 2) moves QA and the parent to Needs input, with one comment and one notice. Nothing is sent back again, and the parts' saved cases are deleted from `reviewedHeads` and `qaFeedback`, so a later QA after a human move is a full round (D-014, D-056).
  - Gate failures are counted per parent under `gateFailures`, apart from QA failures. A new QA approval does not reset them. A parent reaching Done does.
- **Done.** Once every PR of an approval is merged, its entry leaves `merges`. When every part of the parent is Done, the QA sub-issue moves to Done and the parent moves to Done too (D-040). A canceled part does not block this: it never gets a PR, so it does not count as an open part.
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
{ "version": 1, "lastPollAt": "…", "inFlight": [{ "issueId": "…", "issueKey": "MET-41", "role": "backend", "agent": "backend", "worktree": "…", "branch": "…", "startedAt": "…", "pid": 123, "pausedAt": "…", "stopReason": "self-update", "excludesFile": "…" }], "interrupted": [{ "issueId": "…", "issueKey": "MET-42", "role": "frontend", "agent": "frontend", "worktree": "…", "branch": "…", "interruptedAt": "…", "reason": "paused", "excludesFile": "…" }], "attempts": { "<issueId>": 1 }, "qaFailures": { "<parentId>": 1 }, "qaFeedback": { "<partId>": { "prUrl": "…", "reviewUrl": "…", "failing": ["…"], "testTail": "…", "cases": [{ "id": "C1", "item": "…", "repro": "…", "expected": "…", "actual": "…" }] } }, "merges": [{ "qaId": "…", "qaKey": "MET-43", "parentId": "…", "parentKey": "MET-40", "parentUrl": "…", "approvedAt": "…", "prs": [{ "partId": "…", "partKey": "MET-41", "number": 7, "url": "…", "sha": "…", "mergedAt": "…", "needsHuman": "…", "labeled": true, "closedAt": "…" }] }], "gateFailures": { "<parentId>": 1 }, "humanPings": { "<prUrl>": "…" }, "selfUpdateNotices": { "<sha>": "…" }, "selfUpdate": { "from": "<sha>", "to": "<sha>", "at": "…", "state": "pending", "error": "…", "trigger": { "id": "…", "key": "MET-40", "url": "…" } }, "limits": { "claude-code": { "until": "…", "since": "…", "backoffMs": 900000, "endedAt": "…" } }, "shipped": { "<partId>": { "key": "MET-41", "branch": "…", "prUrl": "…", "at": "…" } }, "splits": { "<parentId>": { "key": "MET-40", "parts": ["<partId>"], "qa": "<qaId>", "at": "…" } }, "reviewedHeads": { "<partId>": { "sha": "…", "verdict": "changes_requested", "cases": [{ "id": "C1", "item": "…", "repro": "…", "expected": "…", "actual": "…" }] } }, "usage": { "<parentId>": { "input": 0, "cached": 0, "output": 0 } }, "usageBaseline": { "<parentId>": { "input": 0, "cached": 0, "output": 0, "at": "…" } }, "sessions": { "<partId>": { "harness": "claude-code", "sessionId": "…", "worktree": "/wt/MET-41", "branch": "met-41-api", "at": "…" } }, "qaLiveWarned": "…" }
```

`pausedAt` is set only on an in-flight run that a pause is cancelling. `stopReason: "self-update"` is set with it when a waiting self-update stops the run. `interrupted[].reason` is `paused`, `self-update`, `uncommitted changes` or `commits not on the remote`; a file from before these reasons loads as `paused`. `excludesFile` is the run's exclude file, so synced files do not count as uncommitted changes; it is optional. `selfUpdate.state` is `pending`, `applying`, `done`, `blocked` or `failed`. `endedAt` is set only on an ended hold kept for its backoff.

`pendingQa` is optional and keyed by QA sub-issue id. Each entry holds the parent id, the reviews with their original cases and PR heads, the payloads and status of unfinished review posts, and the completed settlement steps. Older files load without the key. The loader drops malformed records (D-058).

`pendingReviewSettle` is optional and keyed by part id. Each entry holds the settle inputs and the completed steps, so a network error can finish the writes on a later tick. An entry may also carry `escalation: { reasons }`, the not-judged escalation the loop already decided. It is written before the first Linear write, so a restart replays the escalation with the saved reasons instead of counting the run again; a malformed key drops the record. Older files load without the key (MET-232, D-052, D-058).

Linear stays the source of truth. The file only records in-flight runs, paused runs, failure counts, the QA feedback a sent-back part gets in its prompt, the last session of each part run, the QA approvals waiting to merge, the needs-human notices already sent, the usage-limit holds and the parents the loop split. `sessions` is optional: a part run's last session, keyed by part id, with the harness, the worktree and branch it ran in, and the time. `qaFeedback.testTail` is optional: the last 3,000 characters of the tests when they failed. `qaFeedback.cases` is optional too: each failing case with its repro, for the numbered send-back list, and a malformed case drops the array, not the entry (D-054). `reviewedHeads`, `usage` and `usageBaseline` are additive and optional: a file from before D-040 still loads. A reviewed head's `cases` is optional too: the failing cases QA recorded at that head, kept for the re-QA after a send-back, and a malformed case drops the array, not the entry (D-054). `shipped` is optional too: a file from before MET-128 loads with no shipped parts. `splits` is optional: a file from before MET-154 loads with no split records. `harnessSwitch` is optional: keyed by issue id, `{ from, reason, at }`; a file from before D-048 loads, and a malformed entry is dropped. `qaLiveWarned` is optional: the time the first split note warned that the repo runs no live app (MET-180). A file from before it loads with no key, and the warning comes again only after the key is removed. An approval that cannot be read back whole is dropped rather than merged on a guess. If the file is unreadable, it is moved aside to `loop.json.corrupt-<ts>` and the loop starts empty.
