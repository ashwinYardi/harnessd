# Issue tracker: Linear

Work for this repo lives in Linear: team **Meta Harness** (key `MET`), project **harnessd**. Use the Linear MCP tools when a session has them. Otherwise, the issue text is in your brief.

## Conventions
- Filing rules are in docs/SPEC.md, "Linear filing rules": the title is the outcome; the body has Why, Done when, Spec links and Size; there is one area label.
- States: Backlog → Ready → In Progress → In Review → Done, plus Needs input. Only **Ready** issues are worked.
- Each issue belongs to one milestone (docs/RELEASING.md).
- Blocking: use Linear `blocks` relations. An issue is startable when all its blockers are Done.
- One issue = one branch = one PR. Put `MET-<n>` in the PR title **only** for the one issue that PR closes. Linear's GitHub link moves every issue named in a PR title, and it marks them Done on merge.

## When a skill says "publish to the issue tracker"
Create a Linear issue in team MET, project harnessd, in Backlog. A human or the coordinator moves it to Ready.

## When a skill says "fetch the relevant ticket"
Read the Linear issue, or use the issue text in your brief.
