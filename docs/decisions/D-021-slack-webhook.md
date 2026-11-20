# D-021 Slack goes through an incoming webhook from the environment
Status: accepted 2026-11-20. Refines D-015. Amended by D-030: Settings can save the webhook. Amends the MET-16 issue text ("bot token from the secret store").
- harnessd posts to Slack with an incoming webhook and plain HTTPS. It adds no Slack SDK (D-002 spirit).
- The webhook URL comes only from `HARNESSD_SLACK_WEBHOOK_URL`, like `LINEAR_API_KEY`. It is never written to config, logs or fixtures. A secret store is a protected path and stays out of scope.
- The webhook fixes the channel. `slack.channel` is a label for the start line only.
- With no URL, harnessd uses `NullNotifier` and logs one warning at start.
- A Slack failure never stops or slows the loop. A send runs in the background, is retried at most 3 times with backoff, then dropped and logged.
- The daily summary goes out at `slack.summary_time` (default 21:00) in `slack.time_zone` (default `Asia/Kolkata`). It lists merges, blocks and runs in progress since the last summary. A summary missed while the daemon was off is sent once at the next start. The first start sends none.
- Spend is not in the summary yet: harnessd records no spend. It joins the summary when D-019 logs cost per run.

Why: a webhook needs no Slack app review or bot scopes, and the owner sets it in one step. Issue: MET-16.
