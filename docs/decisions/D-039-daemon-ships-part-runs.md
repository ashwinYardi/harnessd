# D-039 The daemon ships every part run; agents get no git write and no GitHub login
Status: accepted 2026-11-22. Issue: MET-109 (part 4, MET-116). Amends D-032 and docs/LOOP.md.

**The ship step.**
- After a part run ends `ok`, the daemon commits the worktree, pushes the branch and opens or updates the PR. The agent does not commit, push or open a PR.
- The commit uses the run's excludes file, so generated harness files stay out. The commit subject is `<key>: <title>`; the body is the agent's last message.
- The daemon pushes with `git push -u origin <branch>`. It never force-pushes.
- The daemon looks for an open PR with the run's head branch. The push updates that PR. If there is no match, the daemon looks for an open PR with the issue key in its title. If that PR has a different head branch, the run fails and reports both branches. The daemon opens a PR with `gh pr create` only if both lookups find no PR. It puts the issue key in the title and uses the agent's last message in the body.
- A run with no new commit and no commit ahead of base fails as `no changes`. A failed commit or push fails as `push failed: <reason>`. A failed PR fails as `pr failed: <reason>`.
- A ship failure is a failed run. It counts an attempt, as an error run does. It is never "done, In Review".
- The QA round keeps its own path: it reads the PR, checks it out and posts the review.

**The keep guard.**
- `removeWorktree` refuses a worktree with unshipped work: uncommitted changes, or commits that are not on `origin/<branch>`.
- The loop keeps that worktree, lists it under `interrupted`, and posts one Linear comment: "worktree kept at <path>: uncommitted changes" or "…: commits not on the remote". The next run resumes it on the same branch.
- The guard runs on every removal, so a failed, cancelled or limited run keeps its worktree too when it holds unshipped work. The keep comment is the only comment such a run posts.
- The keep guard also applies to a QA PR-head scratch checkout. If the checkout has no remote branch, the guard asks each remote for its live branch heads (`git ls-remote`), because a local tracking ref can outlive a deleted branch. If no live head holds the checkout's HEAD, or the remote cannot be reached, the daemon keeps the checkout and reports "commits not on the remote".
- A run that a pause (D-014) or a self-update (D-033) stopped keeps its worktree.

**The `harness.<id>.worktree_write` check.**
- Each harness an agent uses gets a `harness.<id>.worktree_write` check. Setup and doctor run it.
- For Codex in `workspace-write`, the daemon runs Codex in a scratch folder under the worktrees root and checks that Codex wrote the file. For harnesses with no OS sandbox, such as Claude Code, OpenCode and Codex in `danger-full-access`, the daemon writes the file itself to check filesystem permissions. The check needs no token or GitHub login.
- A fail names the reason and the fix. So a sandbox that blocks a worktree write fails loudly before a run.

Why:
- On 2026-11-21 every Codex builder run wrote and tested its code, then failed at the last step. The macOS seatbelt hid the keychain, so `gh` reported "The token in default is invalid". It also kept every `.git` folder read-only, so `git commit` could not write the index.
- The loop still logged "done, In Review" with no PR, then removed the worktree. Work from MET-64, MET-65, MET-79 and MET-80 was lost or saved only as dangling objects.
- One daemon path works for every harness. A sandbox needs no git write and no GitHub login, and "done" means that a PR exists.
- The trade-off: agents lose control of commit shape and PR text, and the daemon needs the owner's push access. The keep guard makes sure a failed ship does not lose work.

Consequences:
- D-032 keeps full access for the agent's build and tests. The agent still needs no git write and no GitHub login to ship.
- docs/LOOP.md "Dispatch" describes the ship step, the failure texts and the keep guard.
- A new term, "ship step", is in `GLOSSARY.md`.
