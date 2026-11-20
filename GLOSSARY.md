# harnessd

harnessd is a local daemon. It runs a coordinator and agents on harness CLIs, and it builds work from Linear issues.

## Visibility

**Notice**:
One line to the owner about one event: a merge or a block. It links the issue and the PR, when there is a PR.
_Avoid_: ping, alert, notification

**Block**:
Work that stops until a human acts: Needs input, an escalation, two QA or gate failures, or a protected PR that waits for a human.
_Avoid_: blocker, failure

**Daily summary**:
One message per day, at the summary time, that lists the merges, the blocks and the work in progress since the last daily summary.
_Avoid_: digest, report, recap
