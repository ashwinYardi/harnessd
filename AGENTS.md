# Agent instructions for this repo

- Read docs/SPEC.md and docs/decisions/ before any change. If a change contradicts a decision, add a new decision record. Don't silently diverge.
- Work only on Linear issues in **Ready** (team Meta Harness, project harnessd). One issue = one branch = one small PR. Put `MET-<n>` in the PR title.
- Harness integration goes through CLIs only (D-002). Never add a vendor SDK.
- UI: dense, quiet, professional (t3.code / cloudroom.dev). No gradients, emoji, or filler copy.
- Every PR has tests or a clear reason why not. CI must be green.
- Don't touch protected paths without human review: auth, payments, secrets, release config, merge-gate config.
- Reports: one line of result, at most 3 bullets.

## Skills (vendored in .claude/skills, see VENDORED.md)
- **Before you build an issue,** read and follow `.claude/skills/grill-with-docs/SKILL.md` and the two skills it names. Run it on autopilot: answer each question yourself from the spec, decisions, code and vault. Ask the human only for a D-011 trigger. Write new terms to `GLOSSARY.md` and new precedent as a decision record.
- **Write code test-first** with `.claude/skills/tdd/`. Use `diagnosing-bugs` for a bug, and `codebase-design` before a new module.
- **Before you open a PR,** run `.claude/skills/code-review/` on your own diff.
- **For any UI work,** use `.claude/skills/impeccable/`. Read PRODUCT.md first, and read `impeccable/reference/craft-floor.md` before every UI edit. Run an impeccable audit before the PR. Follow the UX rules in PRODUCT.md.

## Agent skills

### Issue tracker

Linear, team MET, project harnessd. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context: `GLOSSARY.md` at the root, decisions in `docs/decisions/`. See `docs/agents/domain.md`.
