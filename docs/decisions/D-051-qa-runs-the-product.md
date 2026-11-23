# D-051 QA runs the product, and stops its process tree

Status: accepted 2026-11-23. Issue: MET-178, part of MET-169. Amends D-013 and D-041. References D-048 and D-014. Updates docs/LOOP.md "QA".

QA read the diff, the CI result and the test output. It never ran the product, so it repeated the code review and missed bugs that show only in a running app. A repo now declares how harnessd starts its product in `[qa]` (MET-177: `kind`, `start`, `url`, `health`, `build`, `seed`, `env`), and QA judges each Done-when item against that running product.

## Decision

**When.** live QA is on only when `[qa]` sets `kind`. A repo without it keeps today's review: the tests and the diff only.

**Order.** For each part's PR, after the checkout: `qa.setup_command`, `qa.test_command`, `qa.build`, `qa.seed`, a free port, `qa.start`, `qa.health`, then the QA agent. If `qa.test_command` fails, the app does not start and the review follows the normal test-failure path (`request_changes`). A build broken by the PR is therefore a test result, not a setup error.

**Port and start.** harnessd listens on `127.0.0.1` port 0, reads the port and closes the socket. It replaces `{port}` in `qa.url` and `qa.start` with that port. `qa.start` runs through `sh -c` in the QA worktree, in its own process group (`detached`), with `PORT` set. Each review gets its own port.

**Environment.** `build`, `seed`, `start` and `health` get only `PATH`, `HOME`, `USER`, `SHELL`, `TMPDIR`, `LANG`, `TERM`, `PORT`, `HARNESSD_QA_AREA` (backend or frontend, from the part's role) and each variable name in `qa.env`, taken from the daemon's environment. Build and seed run before the port is picked, so they get no `PORT`. The daemon's own secrets, such as `LINEAR_API_KEY` and the Slack webhook, do not reach the product unless `env` names them. A named variable that is not set is skipped with one log line per review. `setup_command` and `test_command` keep their current environment.

**Health.** A `health` value that starts with `/` is a path: harnessd sends HTTP GET to the url origin plus that path, and a 2xx or 3xx answer passes. Any other value is a shell command (`sh -c`) run in the QA worktree, and exit 0 passes. Each probe has a 5 s limit. harnessd polls once a second, for 2 minutes in total.

**Stop.** The start process is registered with `adapters/process.ts`, so `killAllLiveRuns` stops its tree when the daemon exits. The app is stopped in every teardown path of the round: approve, `request_changes`, error, limited, a setup error, a timeout and a pause. The stop is `killProcessTree` with a 5 s grace (D-048). A pause keeps the checkout (D-041) but still stops the app.

**Failure.** A non-zero `build` or `seed`, a start process that exits before health passes, and a health check that does not pass within 2 minutes are QA setup errors. The review carries the D-041 setup marker, `settleQa` re-queues QA and counts no QA failure, and nothing is posted. The log line is `<QA key>: QA not judged (app <step> failed: <last 5 output lines joined by " | ">), re-queued`; the output is masked like check output.

**Retry cap.** D-041 has no retry cap, so a real app setup fault on one head would re-queue forever. `qa.ts` keeps an in-memory count of app setup errors per part and PR head. On the third consecutive app setup error on the same head, the review runs with no live app and keeps the reason on the result (`PrReview.appSetup`): a later prompt part shows `not run live (app <step> failed)`. That round counts no QA failure and adds nothing to `loop.json`. The count resets on a new head, and a successful start clears it.

**cli.** A `cli` product is a command QA calls, not a server: harnessd runs `build` and `seed`, then `health` once if set, and starts no process and picks no port.

**Budget.** The whole round, including build, seed, start and health, runs within the QA sub-issue's size budget (D-014). A budget that runs out before the agent runs stays the existing D-041 setup error. A setup error counts no QA failure.

## Why

A QA that never runs the product cannot see a layout overlap, a broken route or a slow endpoint. MET-159 found one by reading CSS classes, and the owner checked the fix in a browser by hand. harnessd is generic: a web app, an API and a cli each declare how to start, so the coordinator stays product-agnostic. Running the product is the only way to judge a Done-when item that says "works".

## Consequences

- D-013: QA judges each Done-when item against the running product, not only the diff and tests.
- D-041: an app build, seed, start or health failure is a setup error, with a 3-try fallback on the same head. Its log line and re-queue rule apply unchanged.
- The same tree kill as a run stops the app and every descendant (D-048).
- docs/LOOP.md "QA" describes the lifecycle. The QA prompt names the app's url and kind; the "not run live" line and the browser are later parts (MET-179 and on).
