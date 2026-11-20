# Agent instructions for this repo

- Read docs/SPEC.md and docs/decisions/ before any change. If a change contradicts a decision, add a new decision record. Don't silently diverge.
- Work only on Linear issues in **Ready** (team Meta Harness, project harnessd). One issue = one branch = one small PR. Put `MET-<n>` in the PR title.
- Harness integration goes through CLIs only (D-002). Never add a vendor SDK.
- UI: dense, quiet, keyboard-first and professional. No gradients, emoji, or filler copy.
- Every PR has tests or a clear reason why not. CI must be green.
- Don't touch protected paths without human review: auth, payments, secrets, release config, merge-gate config.
- Reports: one line of result, at most 3 bullets.

## What goes in this public repo
This repo is public. Every file in it must be one of these:
- Original code, docs or assets made for harnessd.
- Code or assets from a source made for reuse (for example shadcn/ui, an MIT library, or Simple Icons). Note the source and license in the file and in a notices file.

Never commit these:
- Code, assets, copy or screenshots copied from another product.
- Secrets: keys, tokens, webhook URLs or passwords.
- Personal data, such as names, emails or account ids, outside the git author fields.
- Local paths from your machine, or links to agent sessions.

## Skills (vendored in .claude/skills, see VENDORED.md)
- **Before you build an issue,** read and follow `.claude/skills/grill-with-docs/SKILL.md` and the two skills it names. Run it on autopilot: answer each question yourself from the spec, decisions, code and vault. Ask the human only for a D-011 trigger. Write new terms to `GLOSSARY.md` and new precedent as a decision record.
- **Write code test-first** with `.claude/skills/tdd/`. Use `diagnosing-bugs` for a bug, and `codebase-design` before a new module.
- **Before you open a PR,** run `.claude/skills/code-review/` on your own diff.
- **For any UI work,** use `.claude/skills/impeccable/` for real, never in a degraded mode without saying so in the PR. Read PRODUCT.md and DESIGN.md first, and read `impeccable/reference/craft-floor.md` before every UI edit.
  - Plan with `/impeccable shape`. Before the PR, run `/impeccable critique` and `/impeccable audit`, then `/impeccable polish`.
  - The design hook in `.claude/settings.json` scans each UI file you edit, and runs a deep pass when you stop. Fix its findings; do not silence them.
  - Ask the `impeccable-finish-reviewer` agent to review the finished UI, and `impeccable-motion-reviewer` for motion. Apply their material fixes.
  - CI runs `impeccable detect` on `packages/ui/app/src`. A finding fails CI.
  - Follow the UX rules in PRODUCT.md.

## Agent skills

### Issue tracker

Linear, team MET, project harnessd. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context: `GLOSSARY.md` at the root, decisions in `docs/decisions/`. See `docs/agents/domain.md`.
