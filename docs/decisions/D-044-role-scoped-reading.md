# D-044 Role-scoped reading for builder and QA runs
Status: accepted 2026-11-22. Issue: MET-147. Part of MET-141. Amends D-040 and D-043 (role skill sets) and refines D-011 and D-017 (only the coordinator grills against the whole spec).

- The coordinator (grill, plan) reads `docs/SPEC.md` and every decision record in `docs/decisions/`. A builder or QA run reads only its brief and the decision records the brief names by ID. It reads another record only when the brief or the code points to it.
- Every role keeps the rule: if a change contradicts a decision, add a new decision record. Do not diverge silently.
- The plan reply gives each part an optional `decisions` array of `{ id, line }`. `id` is `D-NNN` and names a file in `docs/decisions/`; `line` is one sentence on why it applies. The plan prompt asks for it. The prompt never tells the agent to read the whole spec or every record.
- A missing or empty `decisions` array is valid. A malformed entry makes the plan invalid, like any other shape error. A well-formed id with no record file is dropped with one log line; it does not cause the one-part fallback.
- The plan reply also gives each part an optional `calls` array of grill call numbers or question texts. The split writes a **Decisions** section and a **Grill calls** section in the sub-issue body. The part prompt already carries the body, so builder and QA send-back runs see both. Nothing new goes into `loop.json`.
- The one-part fallback carries every grill call and no decision ids.
- A builder run gets no `grill-with-docs` and no `code-review`. QA gets no `grill-with-docs` and keeps `code-review`. The coordinator keeps `grill-with-docs` and gets no `code-review`. `enabled = false` still turns a skill off for everyone.
- The QA prompt reads the part diff, the parent's "Done when", CI, the tests and the decision IDs in the part body. It does not read `docs/SPEC.md` or every record. The verdict contract does not change.

Why:
- `AGENTS.md` told every builder run to read the spec and all decision records before any change. On 2026-11-22 there were 43 records. The text stayed in context and went out again on every turn.
- The coordinator already read the spec and the records in its grill. The builder repeated that work.
- A builder needs its slice: the brief and the records the brief names. A record the brief does not name is not part of the part.
