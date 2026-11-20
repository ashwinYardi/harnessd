# D-021 The coordinator runs grill-with-docs headless
Status: draft 2026-11-20. Extends D-017.
- The prompt carries the method. It is built from `grilling/SKILL.md` and `domain-modeling/SKILL.md` in the installed skill pack. A built-in short form is the fallback.
- Headless rules override the skills. The coordinator answers each frontier question itself, with a basis. It asks the human only for a D-011 trigger.
- The reply contract adds optional `terms` and `precedents`. A reply without them stays valid.
- New terms go to `.harnessd/vault/glossary/`, one note per term. The loop never writes `GLOSSARY.md`.
- A precedent becomes a draft record in `.harnessd/vault/decision-drafts/`, numbered `D-NNN`. A docs PR gives it a number. The loop does not open that PR.
- Term notes and drafts are never overwritten.

Why:
- grill-with-docs has `disable-model-invocation: true`, so the Skill tool cannot start it.
- Nobody answers a headless round, so the coordinator must answer it.
- `GLOSSARY.md` and `docs/decisions/` stay human-reviewed. Two parallel grills cannot take the same D-number.

Issue: MET-22.
