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

A failed QA or review round is never fixed by the coordinator: it goes back to the part's builder as a send-back, resumed when possible (D-046). At `limits.qa_max_failures` QA and the parent go to Needs input and no builder or coordinator run starts (D-014, D-056). An interactive coordinator session cannot get a harness flag from the loop, so `.harnessd/AGENTS.md` carries the same rule. The record is D-059; it amends D-031, D-032 and D-036.

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
  "precedents": [{ "title": "…", "decision": "…", "why": "…" }]
}
```

`terms` and `precedents` are optional; a reply without them is valid. `avoid` is optional. A precedent is a call that is hard to reverse, surprising without context and the result of a real trade-off (the domain-modeling decision-record test). It is also listed in `calls`.

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
