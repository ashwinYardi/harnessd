# Coordinator: the grill

Before any work starts, the coordinator grills each picked issue itself (SPEC "Autonomy loop" steps 2 and 3, D-011). Code: `packages/daemon/src/coordinator/`. Types and trigger names: `packages/shared/src/coordinator.ts`.

## Contract
`grillIssue(issue, deps)` returns `{ calls, escalation, outcome }`, where `outcome` is `proceed`, `needs_input` or `error`.

`deps` holds everything with a side effect, so tests are pure:

| Dep | What it is |
|---|---|
| `adapter` | A `HarnessAdapter` (D-002). Its id must match the coordinator's harness. |
| `agent` | `resolveAgentConfig(merged, "coordinator")`: model and instructions. |
| `context` | `loadGrillContext(repo)`: `docs/SPEC.md` and `docs/decisions/*.md`. |
| `cwd` | The repo. The model may read code and `.harnessd/vault/`; it must not edit. |
| `linear` | `comment(issueId, body)` and `moveTo(issueId, state)`. `LinearClient` fits. |
| `notifier` | `Notifier { notify(text) }`. `NullNotifier` until Slack lands (MET-16). |
| `decisions` | `DecisionSink { write(note) }`. `createFileDecisionSink(vault)` is the default. |

## Model reply
The prompt carries the coordinator instructions, the issue (title, body, Done when), the spec and every decision record. The model replies with strict JSON only:

```json
{
  "calls": [{ "question": "…", "answer": "…", "basis": "…" }],
  "escalation": null
}
```

`escalation` is `null` or `{ "trigger", "question", "why" }`. `trigger` is one of the D-011 categories (`ESCALATION_TRIGGERS`): `irreversible`, `money`, `secret_or_account`, `public_api_data_model_or_protected_path`, `taste_no_precedent`.

- The final assistant text is parsed. A ```` ```json ```` fence is tolerated. Unknown keys and empty strings are rejected.
- If the reply is invalid or the run fails, the grill retries once with the error. If the retry also fails, the outcome is `error`. Nothing is written: no comment, no note, no state change and no ping.
- An escalation whose trigger is not a D-011 category is not escalated. It is recorded as a call ("not a D-011 trigger, the coordinator decides") and the grill proceeds.

## Side effects
These run in this order. If one fails, the steps after it are skipped and the outcome is `error`.
1. One decision note per call: `<repo>/.harnessd/vault/decisions/<ISSUE>-<slug>.md`, with YAML frontmatter (`issue`, `question`, `decision`, `basis`) and a body. Existing notes are never overwritten.
2. One Linear comment. It has a header, then one bullet per call (`question → answer (basis: …)`). When escalating, it also has the question for the human and the D-011 trigger.
3. On escalation only, the issue moves to **Needs input**.
4. On escalation only, exactly one ping is sent: `<KEY> needs input (<trigger>): <question> <url>`.

On `proceed`, the issue's state is left alone; the loop goes on to split and assign the issue.
