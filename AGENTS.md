# Agent instructions for this repo

- Read docs/SPEC.md and docs/decisions/ before any change. If a change contradicts a decision, add a new decision record. Don't silently diverge.
- Work only on Linear issues in **Ready** (team Meta Harness, project harnessd). One issue = one branch = one small PR. Put `MET-<n>` in the PR title.
- Harness integration goes through CLIs only (D-002). Never add a vendor SDK.
- UI: dense, quiet, professional (t3.code / cloudroom.dev). No gradients, emoji, or filler copy.
- Every PR has tests or a clear reason why not. CI must be green.
- Don't touch protected paths without human review: auth, payments, secrets, release config, merge-gate config.
- Reports: one line of result, at most 3 bullets.
