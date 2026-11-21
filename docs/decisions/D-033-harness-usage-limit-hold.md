# D-033 A harness usage limit holds that harness; it is no task failure
Status: accepted 2026-11-21. Issue: MET-70 (part 2, MET-80).

- A run that ends `limited` uses no attempt and counts no QA failure (D-014 counts task failures only). The issue goes back to Ready, or stays there for a grill or plan run. No comment, no escalation, no notice.
- The limit starts a hold on that harness. It ends at the reset time the harness gave, or after a backoff when it gave none.
- The backoff is 15 minutes, doubled after each hold that ended, at most 2 hours. An ok run on the harness clears it. More limited runs during an active hold do not double it, so several runs that hit the same limit at once count as one.
- The defaults live in code, not in config.
- While a hold lasts, no run starts on that harness. Agents on other harnesses dispatch as usual. Runs in flight are not cancelled.
- A limited plan run is not replaced by the fallback plan.
- Holds are kept in `loop.json` under `limits`, so a restart keeps them.

Why:
- On 2026-11-20 a Claude usage limit burned both attempts on four healthy issues in about two minutes and sent them to Needs input.
- A limit is a property of the harness and the account, not of the issue. Holding the harness stops the loop from trying again every tick.
