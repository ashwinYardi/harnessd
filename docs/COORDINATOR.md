# Coordinator: the grill

Before any work starts, the coordinator grills each picked issue itself (SPEC "Autonomy loop" steps 2 and 3, D-011). It uses the grill-with-docs method (D-017), run headless (D-022). Code: `packages/daemon/src/coordinator/`. Types and trigger names: `packages/shared/src/coordinator.ts`.

## Contract
`grillIssue(issue, deps)` returns `{ calls, escalation, outcome }`, where `outcome` is `proceed`, `needs_input` or `error`.

`deps` holds everything with a side effect, so tests are pure:

| Dep | What it is |
|---|---|
| `adapter` | A `HarnessAdapter` (D-002). Its id must match the coordinator's harness. |
| `agent` | `resolveAgentConfig(merged, "coordinator")`: model and instructions. |
| `context` | `loadGrillContext(repo, { skillsDir })`: `docs/SPEC.md`, `docs/decisions/*.md`, `GLOSSARY.md`, the workspace vault glossary and the method. |
| `cwd` | The repo. The model may read code and `.harnessd/vault/`; it cannot edit: read-only tools only. |
| `linear` | `comment(issueId, body)` and `moveTo(issueId, state)`. `LinearClient` fits. |
| `notifier` | `Notifier { notify(notice) }`: Slack #harnessd, or `NullNotifier` without a webhook (D-021). |
| `decisions` | `DecisionSink { write(note), term?(note), draft?(note) }`. `createFileDecisionSink(vault)` is the default. |

## Read-only
The coordinator plans and decides. It never edits code, commits or pushes. Every coordinator-role run — grill, plan and any later coordinator step — is a read-only run: it builds its `Task` through `coordinatorTask` in `packages/daemon/src/coordinator/grill.ts`, which sets `readOnly: true`. Builder and QA tasks leave it unset.

| Harness | Flags of a read-only run |
|---|---|
| Claude Code | `--tools Read,Grep,Glob` with `--disallowedTools Edit,Write,NotebookEdit,Bash,mcp__harnessd-memory__write_note`; no `--permission-mode auto` and no `--dangerously-skip-permissions`. |
| Codex | `--sandbox read-only` instead of `danger-full-access` (`-c sandbox_mode="read-only"` on a resume); the D-031 and D-032 isolation and approval flags stay. |
| OpenCode | An inline `OPENCODE_CONFIG_CONTENT` that denies `edit`, `bash`, `webfetch`, `websearch`, `task`, `external_directory` and `question`. `--auto` approves only pending requests and cannot override a deny (checked on 2.3.2). |

The coordinator edits no fix: a failed QA round goes back to the part's builder as a send-back, resumed when possible (D-046). A blocking review goes to a coordinator decision, which sends the builder one hint per finding or, under a D-011 trigger, asks the owner (D-062). At `limits.qa_max_failures` QA and the parent go to Needs input and no builder or coordinator run starts (D-014, D-056). An interactive coordinator session cannot get a harness flag from the loop, so `.harnessd/AGENTS.md` carries the same rule. The record is D-059; it amends D-031, D-032 and D-036.

## Review decision (D-062)
A `changes_requested` review is a message to the coordinator. Before the first Linear write, the loop runs one read-only coordinator task (`decideReview` in `packages/daemon/src/coordinator/review-decision.ts`) in the owner's checkout. It has a 10-minute budget and the coordinator turn cap (50). The decision goes to `pendingReviewSettle` in `loop.json`, so a restart replays it with no second run and sends the notice once.

**Prompt.** It holds the part key, title and parent; the part's Goal, Done when, Files, Verify and Out of scope; the Done-when items; every open blocking finding as `R1`…`Rn` with its file, line and kind; `Round <n> of <limits.max_review_rounds>`; the earlier rounds' findings; the D-011 trigger list; and the reply contract. It carries no PR diff: the run opens the files it needs in the checkout. It edits nothing.

**Reply contract.** The final message is strict JSON only, with no prose and no code fence. Either:

```json
{ "decision": "fix", "findings": [{ "id": "R1", "hint": "string" }] }
```

with exactly one non-empty hint per open `R<n>`, or:

```json
{
  "decision": "escalate",
  "trigger": "irreversible" | "money" | "secret_or_account" | "public_api_data_model_or_protected_path" | "taste_no_precedent",
  "question": "string",
  "options": ["string"],
  "recommendation": "string"
}
```

An escalate needs one D-011 trigger, a non-empty question, at least one option and a recommendation. A design finding alone is no trigger: the coordinator fixes it, and escalates only when the fix crosses a D-011 line such as the public API, the data model, a protected path, a secret or an account change, money, an irreversible step, or a taste call with no precedent.

**Fix fallback.** An invalid or unusable reply, an unknown finding id, a failed or limited run, or an escalate whose trigger is missing or unknown is a fix send-back with no hints. The loop logs one `review decision failed` or `escalation without a D-011 trigger, sent back as fix` line. The verdict still counts one review round, as any `changes_requested` verdict does. Nothing waits on a human by accident.

**Cap.** At or over `limits.max_review_rounds` (default 6) the loop starts no decision run. It saves the cap on the pending settlement before the first write, then escalates with one parent comment listing the open findings, moves both issues to Needs input and sends one notice with the reason `review round cap reached`. The round counter (`reviewFailures`) is separate from failed review runs (`reviewRunFailures`), so a failed run never consumes a round and a round never consumes a failed run.

## Method: grill-with-docs
grill-with-docs (D-017) is the `grilling` and `domain-modeling` skills together. Its SKILL.md has `disable-model-invocation: true`, so a headless run cannot start it with the Skill tool. The prompt carries the method instead.

- `loadGrillMethod(skillsDir)` reads `grilling/SKILL.md` and `domain-modeling/SKILL.md` from the installed skill pack (`~/.harnessd/skills/`, MET-21). It drops the frontmatter.
- If either file is missing or empty, the prompt uses `BUILT_IN_GRILL_METHOD`, a short form of the two skills.
- The skills are written for a human who answers each round. Headless rules come first and override them. The coordinator builds the design tree and answers each frontier question itself, with a basis. It stops when the frontier is empty. It asks the human only for a D-011 trigger. It does not edit or write files.

## Glossary
The grill checks each issue against two glossaries. Both are in the prompt.

- `GLOSSARY.md` at the repo root. A human reviews it. The loop never writes it.
- The workspace vault glossary: one note per term in `<repo>/.harnessd/vault/glossary/<slug>.md` (docs/MEMORY.md). The grill writes new terms here.

A term note uses the GLOSSARY-FORMAT style: `**Term**:`, the definition, then `_Avoid_:` words. The first definition of a term wins: a note that exists is never overwritten. To promote a term, copy it into `GLOSSARY.md` in a docs PR.

## Model reply
The prompt carries the method, the coordinator instructions, the issue (title, body, Done when), the spec, every decision record and both glossaries. The model replies with strict JSON only:

```json
{
  "calls": [{ "question": "…", "answer": "…", "basis": "…" }],
  "escalation": null,
  "terms": [{ "term": "…", "definition": "…", "avoid": ["…"] }],
  "precedents": [{ "title": "…", "decision": "…", "why": "…" }],
  "normalizedDoneWhen": ["…"]
}
```

`terms`, `precedents` and `normalizedDoneWhen` are optional; a reply without them is valid. `avoid` is optional. A precedent is a call that is hard to reverse, surprising without context and the result of a real trade-off (the domain-modeling decision-record test). It is also listed in `calls`.

`normalizedDoneWhen` is set only when the ticket's Done-when list cannot pass the plan check: a docs-only ticket with more than 3 items, or more than 18 items (`MAX_PLAN_PARTS` x `MAX_PART_DONE_WHEN`). The list keeps every original requirement and fits the plan rules. The loop saves it on the parent's description with a comment that shows the old and new lists, then plans from it (D-063). An empty array or a blank entry is invalid. This is a reversible ticket clarification, not a D-011 trigger.

`escalation` is `null` or `{ "trigger", "question", "why" }`. `trigger` is one of the D-011 categories (`ESCALATION_TRIGGERS`): `irreversible`, `money`, `secret_or_account`, `public_api_data_model_or_protected_path`, `taste_no_precedent`.

- The final assistant text is parsed. A ```` ```json ```` fence is tolerated. Unknown keys and empty strings are rejected.
- If the reply is invalid or the run fails, the grill retries once with the error. If the retry also fails, the outcome is `error`. Nothing is written: no comment, no note, no state change and no ping.
- An escalation whose trigger is not a D-011 category is not escalated. It is recorded as a call ("not a D-011 trigger, the coordinator decides") and the grill proceeds.

## Side effects
These run in this order. If one fails, the steps after it are skipped and the outcome is `error`.
1. One decision note per call: `<repo>/.harnessd/vault/decisions/<ISSUE>-<slug>.md`, with YAML frontmatter (`issue`, `question`, `decision`, `basis`) and a body. Existing notes are never overwritten.
2. One term note per new term: `<repo>/.harnessd/vault/glossary/<slug>.md`.
3. One draft decision record per precedent: `<repo>/.harnessd/vault/decision-drafts/<ISSUE>-<slug>.md`. It is in the `docs/decisions/` style, numbered `D-NNN`, with `Status: draft <date>.`. To accept it, a docs PR gives it the next number and moves it to `docs/decisions/`. The loop does not open that PR.
4. One Linear comment. It has a header, then one bullet per call (`question → answer (basis: …)`). It then lists new terms and draft decision records, if any. When escalating, it also has the question for the human and the D-011 trigger.
5. On escalation only, the issue moves to **Needs input**.
6. On escalation only, exactly one notice is sent: `<KEY> needs input (<trigger>): <question> <url>`.

Term notes and drafts are never overwritten. A sink without `term` or `draft` skips them; the comment still lists them.

On `proceed`, the issue's state is left alone; the loop goes on to split and assign the issue (docs/LOOP.md).

## Split (D-049)
After the grill, the coordinator plans the parts. `MAX_PLAN_PARTS` is 6.

**Size rule.** A ticket stays one part only when it is small: one area (backend or UI), about 3 Done-when items or fewer, and about 5 files or fewer. Otherwise it splits. A part is at most size M.

**Area split.** Backend work (shared types, API, daemon) comes first, in a backend part, and blocks the frontend part. The frontend part builds against the merged contract and runs on the frontend agent with its design checks. Docs changes go in the part whose code they describe; there is no separate docs part. Parts that list the same file are chained with `blocks`.

**Brief shape.** Each part has these fields, and the part's Linear description shows them as sections in this order: the marker, **Goal**, **Done when** (the covered parent items, copied as text), **Files**, **Steps**, **Verify** (each command with what its output must show) and **Out of scope**. **Decisions**, **Grill calls**, **Why**, **Spec links** and **Size** follow. The part's own Done when replaces the parent's checklist. There is no free-text **Brief** section.

- Each part has an optional `decisions` array of `{ id, line }`. `id` is `D-NNN` and names a record in `docs/decisions/`; `line` is one sentence on why it applies. The plan prompt asks for it, and forbids "Read docs/SPEC.md and docs/decisions/" in the brief (D-044).
- A missing or empty `decisions` array is valid. A malformed entry makes the plan invalid. A well-formed id with no record file is dropped with one log line.
- Each part also has an optional `calls` array of grill call numbers (1-based) or question texts. The split writes a **Decisions** section (`- D-031: …`) and a **Grill calls** section (question → answer) after the brief in the sub-issue body. The part prompt carries the body, so the builder and QA send-back runs see both.
- The reply always states a `reason`: why the issue stayed one part, or why it split. A plan with no reason is invalid.

**Plan check.** The loop rejects a plan where a part has an empty field, more than about 3 Done-when items or more than 8 files, or where one parent Done-when item is in no part. It also rejects a part that lists a file in the other area, a frontend part before a backend part, and a docs-only part in a multi-part plan. A rejected plan goes back to the coordinator once with every error. A second bad plan moves the parent to Needs input (MET-160).

**Split note.** The parent's split comment lists each part with its key, role, size, goal and files, and the QA sub-issue with its blockers. It always ends with `Reason: …`, for a split and for a one-part plan.

Parts of a split issue run one after another (docs/LOOP.md "Dispatch"). Each part blocks the next, so only one PR of the parent is open at a time. An L part is refused: the issue goes to Needs input (D-014).
