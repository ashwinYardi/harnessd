# Agent instructions for this repo

- **Reading by role.** The coordinator (grill, plan) reads `docs/SPEC.md` and every decision record in `docs/decisions/`. A builder or QA run reads only its brief and the decision records the brief names by ID. It reads another record only when the brief or the code points to it.
- If a change contradicts a decision, add a new decision record (D-044). Don't silently diverge.
- Work only on Linear issues in **Ready** (team Meta Harness, project harnessd). One issue = one branch = one small PR. Put `MET-<n>` in the PR title.
- Harness integration goes through CLIs only (D-002). Never add a vendor SDK.
- UI: dense, quiet, keyboard-first and professional. No gradients, emoji, or filler copy.
- Every PR has tests or a clear reason why not. CI must be green.
- **Builder runs.** harnessd commits, pushes and opens the PR after your run. Do not run `git commit`, `git push` or `gh pr create`.
- Don't touch protected paths without human review: auth, payments, secrets, release config, merge-gate config.
- Reports: one line of result, at most 3 bullets.

## QA
- QA checks the result, not only the diff. Run the tests, then check each "Done when" item and each item of the build plan.
- **For a change to the UI or the API, check it in a browser, only when your harness gives you a working browser tool** (Claude: Playwright MCP). Build the PR's worktree. Start it as a second daemon with its own `HARNESSD_HOME` (a temp folder) and a free `daemon.port`, such as 4748. Check the changed screens at 1280x800 and 390x844.
- **On Codex, do not start a browser.** Chrome cannot start inside the Codex sandbox: it aborts, and each abort shows a crash dialog on the owner's screen. Do not use `agent-browser`, Puppeteer, Playwright or any other Chrome launcher from a Codex run. Check UI changes with the tests and the static demo build instead, and write "browser check skipped: no browser in this harness" in the PR comment. MET-74 adds a browser that works for every harness.
- Never try a browser launch more than once. If it fails, stop and report it.
- **Never restart the main harnessd service during QA.** It runs the loop, and QA runs inside that loop. After the merge, the main service updates itself (MET-63). Until then, a human pulls, builds and restarts it.
- Put screenshots and the checked items in the PR comment. Stop the side daemon and delete its temp folder when you finish, also after a failure.

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
- **Coordinator: before you grill an issue,** read and follow `.claude/skills/grill-with-docs/SKILL.md` and the two skills it names. Run it on autopilot: answer each question yourself from the spec, decisions, code and vault. Ask the human only for a D-011 trigger. Write new terms to `GLOSSARY.md` and new precedent as a decision record.
- **Builder: write code test-first** with `.claude/skills/tdd/`. Use `diagnosing-bugs` for a bug, and `codebase-design` before a new module.
- **QA: before you approve a PR,** run `.claude/skills/code-review/` on the diff.
- **Frontend: for any UI work,** use `.claude/skills/impeccable/` for real, never in a degraded mode without saying so in the PR. Read PRODUCT.md and DESIGN.md first, and read `impeccable/reference/craft-floor.md` before every UI edit.
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
