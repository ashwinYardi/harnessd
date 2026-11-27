# D-058 A network error while QA settles is no QA verdict

Status accepted 2026-11-27 for MET-213, part of MET-184. Refines D-041 and D-014. Uses the not-judged and case rules from D-052, D-054 and D-056.

A GitHub review post or a Linear settlement write can fail after QA already judged the PR. A transport error, including a timeout or an HTTP 5xx response, contributes no QA failure and leaves the not-judged count untouched. The error itself never triggers a Needs input comment or notice. Network errors during QA setup still use the D-041 re-queue rule.

Keep the verdict in the optional `pendingQa` key in `loop.json`, keyed by QA sub-issue id. The record holds the original reviews and their cases, the PR numbers and heads, the payloads for unfinished posts, and the completed posts and settlement steps. Older state files load without this key. The loader drops a malformed record.

Before dispatch on each tick, retry unfinished GitHub posts and then finish settlement. A network error pauses the remaining writes until the next tick. Successful steps are recorded so a later retry can skip them. Once settlement completes, remove the record and apply the original verdict under the usual rules. A request-changes verdict counts its one failure at settlement and keeps the original cases.

The Linear client drops its connection pool after a network-class request error. The loop also resets the pool after three consecutive ticks with a Linear network error, logs the reset, and clears the in-memory streak. A clean tick clears the streak.
