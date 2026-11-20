# Domain docs

How the engineering skills read this repo's domain docs. This is a single-context repo.

## Before exploring, read these
- `GLOSSARY.md` at the repo root, if it exists.
- `docs/SPEC.md`.
- `docs/decisions/`: this repo's ADRs. They are named `D-NNN-<slug>.md`, not `docs/adr/NNNN-*.md`. Read the ones that touch your area.

If a file is missing, proceed silently. `domain-modeling` creates `GLOSSARY.md` when the first term is resolved.

## Writing decisions
- A new decision is a new file `docs/decisions/D-<next number>-<slug>.md`, in the same short style as the existing ones: a title line, then `Status: accepted <date>.` and the decision, its reason, and the issues it covers.
- A change to a decision is a new record that says what it amends or replaces. Update the old record's status line to point to it. Never silently diverge (AGENTS.md).

## Use the glossary's vocabulary
Use terms as `GLOSSARY.md` defines them, in issue titles, test names and docs.

## Flag decision conflicts
If your work contradicts a decision record, say so in the PR: _Contradicts D-0NN (…), because…_
