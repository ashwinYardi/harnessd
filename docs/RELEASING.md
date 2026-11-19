# Releasing

Linear milestones, GitHub milestones and GitHub releases map one to one, all named by the release tag.

| Tag | Linear milestone (project harnessd) | Issues |
|---|---|---|
| v0.1.0-alpha.1 | Foundation | MET-5, 6, 7, 17 |
| v0.1.0-alpha.2 | One agent ships a task | MET-8, 9, 10 |
| v0.1.0-alpha.3 | Autopilot loop | MET-11, 12, 13, 14, 15 |
| v0.1.0-beta.1 | Visible and installable | MET-16, 18, 19 |
| v0.1.0 | Self-hosting | MET-20 |
| v0.2.0 | Cloud, sandboxes and canvas | to be filed |

## Rules
1. Every Linear issue belongs to exactly one milestone. A new issue goes in the earliest milestone that needs it. If it fits none, it goes in the next one.
2. Every PR is assigned the GitHub milestone with the same tag as its issue's Linear milestone, and has `MET-n` in the title.
3. A release ships when every issue in the milestone is Done and CI on main is green:
   - Tag `main` with the milestone tag (SemVer; `-alpha.N` and `-beta.N` are GitHub pre-releases).
   - Create a GitHub release from the tag. Notes: the milestone's goal in one line, then one line per issue (`MET-n title (#PR)`), then known gaps.
   - Close the GitHub milestone and mark the Linear milestone complete. Post the release link to Slack #harnessd.
4. Moving an issue between milestones is a decision. Note it on the Linear milestone with the reason.
5. Releases are cut by the coordinator (by the Developer bot until MET-20 lands). Tags are never moved or deleted.
