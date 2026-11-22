import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import {
  branchName,
  checkoutWorktree,
  createWorktree,
  MANIFEST_FILE,
  MAX_BRANCH_LENGTH,
  readManifest,
  recoverOnStartup,
  removeWorktree,
} from "./index.ts";

describe("branchName", () => {
  test("lowercases the key and slugs the title", () => {
    assert.equal(
      branchName("MET-12", "Coordinator splits issues into sub-issues"),
      "met-12-coordinator-splits-issues-into-sub-issues",
    );
  });

  test("folds accents and drops other non-ascii", () => {
    assert.equal(branchName("MET-1", "Café naïve résumé"), "met-1-cafe-naive-resume");
    assert.equal(branchName("MET-2", "日本語 only 🚀"), "met-2-only");
    assert.equal(branchName("MET-3", "日本語"), "met-3");
  });

  test("collapses punctuation and trims dashes", () => {
    assert.equal(branchName("MET-4", "  Fix: `foo()` -- bar!! "), "met-4-fix-foo-bar");
    assert.equal(branchName("MET-5", "a/b\\c_d.e"), "met-5-a-b-c-d-e");
  });

  test("empty or symbol-only titles give just the key", () => {
    assert.equal(branchName("MET-6", ""), "met-6");
    assert.equal(branchName("MET-7", "   "), "met-7");
    assert.equal(branchName("MET-8", "?!#"), "met-8");
  });

  test("caps the name at a word boundary", () => {
    const name = branchName(
      "MET-9",
      "Each task runs in its own git worktree and branch with crash safe cleanup on restart",
    );
    assert.ok(name.length <= MAX_BRANCH_LENGTH, name);
    assert.equal(name, "met-9-each-task-runs-in-its-own-git-worktree-and-branch-with");
  });

  test("a word that ends exactly at the cap is kept whole", () => {
    const title = `${"a".repeat(10)} ${"b".repeat(MAX_BRANCH_LENGTH - "met-1-".length - 11)} c`;
    const name = branchName("MET-1", title);
    assert.equal(name.length, MAX_BRANCH_LENGTH);
    assert.ok(name.endsWith("b"));
  });

  test("hard-cuts a single word longer than the budget", () => {
    const name = branchName("MET-10", "x".repeat(100));
    assert.equal(name.length, MAX_BRANCH_LENGTH);
    assert.ok(name.startsWith("met-10-xxx"));
  });

  test("rejects keys that are not <team>-<n>", () => {
    assert.throws(() => branchName("", "t"), /invalid issue key/);
    assert.throws(() => branchName("MET", "t"), /invalid issue key/);
    assert.throws(() => branchName("12", "t"), /invalid issue key/);
  });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    encoding: "utf8",
  }).trim();
}

/** A pid that existed a moment ago and is now gone: a crashed daemon. */
function deadPid(): number {
  const { pid } = spawnSync(process.execPath, ["-e", ""]);
  assert.ok(pid);
  return pid;
}

describe("worktrees", () => {
  let tmp: string;
  let repoDir: string;
  let root: string;
  let origin: string;
  let n = 100;
  // Each test uses its own issue so branches never collide.
  const nextKey = () => `MET-${n++}`;

  before(async () => {
    tmp = await realpath(await mkdtemp(join(tmpdir(), "harnessd-wt-")));
    repoDir = join(tmp, "repo");
    root = join(tmp, "worktrees");
    origin = join(tmp, "origin.git");
    git(tmp, "init", "-q", "--bare", "-b", "main", origin);
    await mkdir(repoDir);
    git(repoDir, "init", "-q", "-b", "main");
    await writeFile(join(repoDir, "README.md"), "hello\n");
    git(repoDir, "add", ".");
    git(repoDir, "commit", "-q", "-m", "init");
    git(repoDir, "remote", "add", "origin", origin);
    git(repoDir, "push", "-q", "origin", "main");
  });

  after(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  const registered = () => git(repoDir, "worktree", "list", "--porcelain");
  const branches = () => git(repoDir, "branch", "--format=%(refname:short)").split("\n");
  const entry = async (path: string) =>
    (await readManifest(root)).entries.find((e) => e.path === path);

  test("creates <root>/<repo>/<branch> on a new branch from main", async () => {
    const wt = await createWorktree({ repoDir, issueKey: "MET-12", title: "Split issues", root });
    assert.equal(wt.branch, "met-12-split-issues");
    assert.equal(wt.path, join(root, "repo", "met-12-split-issues"));
    assert.equal(wt.resumed, false);
    assert.ok(existsSync(join(wt.path, "README.md")));
    assert.equal(git(wt.path, "rev-parse", "--abbrev-ref", "HEAD"), wt.branch);
    assert.equal(git(wt.path, "rev-parse", "HEAD"), git(repoDir, "rev-parse", "main"));
    assert.match(registered(), new RegExp(`worktree ${wt.path}`));

    const e = await entry(wt.path);
    assert.ok(e);
    assert.equal(e.status, "active");
    assert.equal(e.pid, process.pid);
    assert.equal(e.issueKey, "MET-12");
    assert.equal(e.repoDir, repoDir);
    assert.ok(!Number.isNaN(Date.parse(e.createdAt)));

    // Atomic writes leave no tmp files behind.
    assert.deepEqual(
      (await readdir(root)).filter((f) => f.startsWith(MANIFEST_FILE)),
      [MANIFEST_FILE],
    );
  });

  test("calling create twice reuses the live worktree", async () => {
    const issueKey = nextKey();
    const first = await createWorktree({ repoDir, issueKey, title: "twice", root });
    const second = await createWorktree({ repoDir, issueKey, title: "twice", root });
    assert.equal(second.path, first.path);
    assert.equal(second.resumed, true);
    assert.equal((await readManifest(root)).entries.filter((e) => e.path === first.path).length, 1);
  });

  test("remove keeps the branch by default and reuses it on resume", async () => {
    const issueKey = nextKey();
    const wt = await createWorktree({ repoDir, issueKey, title: "resume me", root });
    await writeFile(join(wt.path, "work.txt"), "progress\n");
    git(wt.path, "add", ".");
    git(wt.path, "commit", "-q", "-m", "progress");
    git(wt.path, "push", "-q", "origin", wt.branch);

    await removeWorktree({ repoDir, path: wt.path, root });
    assert.equal(existsSync(wt.path), false);
    assert.doesNotMatch(registered(), new RegExp(`worktree ${wt.path}`));
    assert.equal(await entry(wt.path), undefined);
    assert.ok(branches().includes(wt.branch));

    const again = await createWorktree({ repoDir, issueKey, title: "resume me", root });
    assert.equal(again.resumed, true);
    assert.equal(again.branch, wt.branch);
    assert.ok(existsSync(join(again.path, "work.txt")));
  });

  test("remove keeps a worktree with uncommitted changes and says why", async () => {
    const wt = await createWorktree({ repoDir, issueKey: nextKey(), title: "dirty", root });
    await writeFile(join(wt.path, "wip.txt"), "not shipped\n");

    const result = await removeWorktree({ repoDir, path: wt.path, root });

    assert.deepEqual(result, { removed: false, kept: "uncommitted changes" });
    assert.ok(existsSync(join(wt.path, "wip.txt")));
    assert.match(registered(), new RegExp(`worktree ${wt.path}`));
    assert.equal((await entry(wt.path))?.status, "active", "the entry stays for the resume");
  });

  test("remove keeps a worktree with a commit that is not on the remote", async () => {
    const wt = await createWorktree({ repoDir, issueKey: nextKey(), title: "local only", root });
    await writeFile(join(wt.path, "local.txt"), "not pushed\n");
    git(wt.path, "add", ".");
    git(wt.path, "commit", "-q", "-m", "local only");

    const result = await removeWorktree({ repoDir, path: wt.path, root });

    assert.deepEqual(result, { removed: false, kept: "commits not on the remote" });
    assert.ok(existsSync(join(wt.path, "local.txt")));
    assert.match(registered(), new RegExp(`worktree ${wt.path}`));
  });

  test("remove removes a clean worktree whose commit is pushed", async () => {
    const wt = await createWorktree({ repoDir, issueKey: nextKey(), title: "pushed", root });
    await writeFile(join(wt.path, "pushed.txt"), "shipped\n");
    git(wt.path, "add", ".");
    git(wt.path, "commit", "-q", "-m", "shipped");
    git(wt.path, "push", "-q", "origin", wt.branch);

    const result = await removeWorktree({ repoDir, path: wt.path, root });

    assert.deepEqual(result, { removed: true });
    assert.equal(existsSync(wt.path), false);
    assert.equal(await entry(wt.path), undefined);
  });

  test("a clean scratch checkout is removed", async () => {
    const wt = await createWorktree({ repoDir, issueKey: nextKey(), title: "scratch", root });

    const result = await removeWorktree({ repoDir, path: wt.path, root, scratch: true });

    assert.deepEqual(result, { removed: true });
    assert.equal(existsSync(wt.path), false);
  });

  test("a scratch checkout with uncommitted changes is kept", async () => {
    const wt = await createWorktree({ repoDir, issueKey: nextKey(), title: "scratch dirty", root });
    await writeFile(join(wt.path, "draft.txt"), "not shipped\n");

    const result = await removeWorktree({ repoDir, path: wt.path, root, scratch: true });

    assert.deepEqual(result, { removed: false, kept: "uncommitted changes" });
    assert.ok(existsSync(join(wt.path, "draft.txt")));
    assert.match(registered(), new RegExp(`worktree ${wt.path}`));
  });

  test("a scratch checkout with a commit not on the remote is kept", async () => {
    const other = join(tmp, "scratch-commit");
    git(tmp, "clone", "-q", origin, other);
    git(other, "switch", "-q", "-c", "met-62-scratch-head");
    await writeFile(join(other, "pr.txt"), "pr\n");
    git(other, "add", ".");
    git(other, "commit", "-q", "-m", "pr");
    const sha = git(other, "rev-parse", "HEAD");
    git(other, "push", "-q", "origin", "met-62-scratch-head");

    const wt = await checkoutWorktree({
      repoDir,
      issueKey: "MET-62",
      title: "scratch head",
      branch: "met-62-scratch-head",
      sha,
      root,
    });
    await writeFile(join(wt.path, "local.txt"), "detached work\n");
    git(wt.path, "add", ".");
    git(wt.path, "commit", "-q", "-m", "detached work");

    const result = await removeWorktree({ repoDir, path: wt.path, root, scratch: true });

    assert.deepEqual(result, { removed: false, kept: "commits not on the remote" });
    assert.ok(existsSync(join(wt.path, "local.txt")));
  });

  test("a detached scratch checkout with a local-only commit and no remote branch is kept", async () => {
    const wt = await createWorktree({ repoDir, issueKey: nextKey(), title: "scratch local", root });
    git(wt.path, "checkout", "-q", "--detach");
    await writeFile(join(wt.path, "local-only.txt"), "never pushed\n");
    git(wt.path, "add", ".");
    git(wt.path, "commit", "-q", "-m", "local only");

    const result = await removeWorktree({ repoDir, path: wt.path, root, scratch: true });

    assert.deepEqual(result, { removed: false, kept: "commits not on the remote" });
    assert.ok(existsSync(join(wt.path, "local-only.txt")));
  });

  test("a branch deleted on the remote leaves its commits unsent", async () => {
    const wt = await createWorktree({ repoDir, issueKey: nextKey(), title: "deleted", root });
    await writeFile(join(wt.path, "deleted.txt"), "remote branch deleted\n");
    git(wt.path, "add", ".");
    git(wt.path, "commit", "-q", "-m", "deleted on the remote");
    git(wt.path, "push", "-q", "origin", wt.branch);
    // The remote drops the branch. The local tracking ref stays, so it would wrongly
    // say the commit is shipped; only the remote itself knows.
    git(origin, "branch", "-D", wt.branch);
    assert.ok(existsSync(join(wt.path, "deleted.txt")));
    assert.equal(git(repoDir, "ls-remote", "--heads", "origin", wt.branch), "");
    assert.equal(
      git(repoDir, "rev-parse", "--verify", `refs/remotes/origin/${wt.branch}`),
      git(wt.path, "rev-parse", "HEAD"),
      "the tracking ref is stale",
    );

    const result = await removeWorktree({ repoDir, path: wt.path, root });

    assert.deepEqual(result, { removed: false, kept: "commits not on the remote" });
    assert.ok(existsSync(join(wt.path, "deleted.txt")));
    assert.match(registered(), new RegExp(`worktree ${wt.path}`));
  });

  test("the run's excludes file keeps sync output out of the dirty check", async () => {
    const wt = await createWorktree({ repoDir, issueKey: nextKey(), title: "excluded", root });
    await writeFile(join(wt.path, "AGENTS.md"), "synced\n");
    const excludesFile = join(tmp, "excludes.gitignore");
    await writeFile(excludesFile, "/AGENTS.md\n");

    const kept = await removeWorktree({ repoDir, path: wt.path, root });
    assert.deepEqual(kept, { removed: false, kept: "uncommitted changes" });

    const result = await removeWorktree({ repoDir, path: wt.path, root, excludesFile });
    assert.deepEqual(result, { removed: true });
    assert.equal(existsSync(wt.path), false);
  });

  test("a branch that exists on origin is cut from origin/<branch>", async () => {
    const other = join(tmp, "origin-branch");
    git(tmp, "clone", "-q", origin, other);
    git(other, "switch", "-q", "-c", "met-61-remote-head");
    await writeFile(join(other, "remote.txt"), "on the remote\n");
    git(other, "add", ".");
    git(other, "commit", "-q", "-m", "remote head");
    const sha = git(other, "rev-parse", "HEAD");
    git(other, "push", "-q", "origin", "met-61-remote-head");
    // Move local main ahead, so starting from main would be wrong.
    await writeFile(join(repoDir, "later.txt"), "later\n");
    git(repoDir, "add", ".");
    git(repoDir, "commit", "-q", "-m", "later");
    git(repoDir, "push", "-q", "origin", "main");
    git(repoDir, "fetch", "-q", "origin");

    const wt = await createWorktree({
      repoDir,
      issueKey: "MET-61",
      title: "remote head",
      root,
    });

    assert.equal(wt.resumed, false);
    assert.equal(git(wt.path, "rev-parse", "HEAD"), sha);
    assert.notEqual(git(wt.path, "rev-parse", "HEAD"), git(repoDir, "rev-parse", "main"));
  });

  test("a resumed branch behind origin is fast-forwarded to origin/<branch>", async () => {
    const issueKey = nextKey();
    const first = await createWorktree({ repoDir, issueKey, title: "behind", root });
    await writeFile(join(first.path, "one.txt"), "one\n");
    git(first.path, "add", ".");
    git(first.path, "commit", "-q", "-m", "one");
    git(first.path, "push", "-q", "origin", first.branch);
    await removeWorktree({ repoDir, path: first.path, root });

    // Another clone adds a commit to the same branch and pushes it.
    const other = join(tmp, `behind-${issueKey}`);
    git(tmp, "clone", "-q", origin, other);
    git(other, "switch", "-q", first.branch);
    await writeFile(join(other, "two.txt"), "two\n");
    git(other, "add", ".");
    git(other, "commit", "-q", "-m", "two");
    const sha = git(other, "rev-parse", "HEAD");
    git(other, "push", "-q", "origin", first.branch);
    git(repoDir, "fetch", "-q", "origin");

    const again = await createWorktree({ repoDir, issueKey, title: "behind", root });

    assert.equal(again.resumed, true);
    assert.equal(git(again.path, "rev-parse", "HEAD"), sha);
    assert.ok(existsSync(join(again.path, "two.txt")));
  });

  test("remove can delete the branch", async () => {
    const wt = await createWorktree({ repoDir, issueKey: nextKey(), title: "throwaway", root });
    await writeFile(join(wt.path, "done.txt"), "shipped\n");
    git(wt.path, "add", ".");
    git(wt.path, "commit", "-q", "-m", "shipped");
    git(wt.path, "push", "-q", "origin", wt.branch);
    await removeWorktree({ repoDir, path: wt.path, root, deleteBranch: true });
    assert.equal(existsSync(wt.path), false);
    assert.ok(!branches().includes(wt.branch));
  });

  test("remove refuses paths outside the root", async () => {
    await assert.rejects(
      removeWorktree({ repoDir, path: repoDir, root }),
      /outside worktrees root/,
    );
    assert.ok(existsSync(join(repoDir, "README.md")));
  });

  test("checkout fetches a remote branch and detaches at its head; remove cleans it up", async () => {
    // A PR branch that exists only on the remote, pushed from another clone.
    const other = join(tmp, "other");
    git(tmp, "clone", "-q", origin, other);
    git(other, "switch", "-q", "-c", "met-41-pr-head");
    await writeFile(join(other, "feature.txt"), "pr\n");
    git(other, "add", ".");
    git(other, "commit", "-q", "-m", "pr");
    const sha = git(other, "rev-parse", "HEAD");
    git(other, "push", "-q", "origin", "met-41-pr-head");
    assert.throws(
      () =>
        execFileSync("git", ["-C", repoDir, "cat-file", "-e", `${sha}^{commit}`], {
          stdio: "ignore",
        }),
      "not local yet",
    );

    const input = {
      repoDir,
      issueKey: "MET-43",
      title: "pr 7",
      branch: "met-41-pr-head",
      sha,
      root,
    };
    const wt = await checkoutWorktree(input);
    assert.equal(wt.path, join(root, "repo", "met-43-pr-7"));
    assert.equal(wt.branch, "met-41-pr-head");
    assert.equal(git(wt.path, "rev-parse", "HEAD"), sha);
    assert.equal(git(wt.path, "rev-parse", "--abbrev-ref", "HEAD"), "HEAD", "detached");
    assert.ok(existsSync(join(wt.path, "feature.txt")));
    assert.equal((await entry(wt.path))?.status, "active");

    const draft = join(wt.path, "scratch.txt");
    await writeFile(draft, "left behind\n");
    assert.deepEqual(await removeWorktree({ repoDir, path: wt.path, root, scratch: true }), {
      removed: false,
      kept: "uncommitted changes",
    });
    await assert.rejects(checkoutWorktree(input), /worktree kept at .*: uncommitted changes/);
    assert.equal(await readFile(draft, "utf8"), "left behind\n");

    git(wt.path, "add", "scratch.txt");
    git(wt.path, "commit", "-q", "-m", "local QA work");
    const localHead = git(wt.path, "rev-parse", "HEAD");
    await assert.rejects(checkoutWorktree(input), /worktree kept at .*: commits not on the remote/);
    assert.equal(git(wt.path, "rev-parse", "HEAD"), localHead);
    assert.equal(await readFile(draft, "utf8"), "left behind\n");

    git(wt.path, "reset", "--hard", sha);
    assert.equal((await checkoutWorktree(input)).path, wt.path);
    await removeWorktree({ repoDir, path: wt.path, root, scratch: true });
    assert.equal(existsSync(wt.path), false);
    assert.equal(await entry(wt.path), undefined);
    assert.ok(!registered().includes(wt.path));
    assert.ok(!branches().includes("met-41-pr-head"), "no local branch was created");

    await assert.rejects(
      checkoutWorktree({ ...input, branch: "nope", sha: "0".repeat(40) }),
      /git fetch/,
    );
    assert.equal(existsSync(wt.path), false);
  });

  test("create fails cleanly on an unknown base and leaves no entry", async () => {
    const issueKey = nextKey();
    await assert.rejects(
      createWorktree({ repoDir, issueKey, title: "bad base", base: "nope", root }),
      /git worktree add/,
    );
    const path = join(root, "repo", branchName(issueKey, "bad base"));
    assert.equal(await entry(path), undefined);
  });

  describe("recoverOnStartup", () => {
    test("dead owner, folder intact: marked stale, folder and branch kept, then resumed", async () => {
      const issueKey = nextKey();
      const wt = await createWorktree({ repoDir, issueKey, title: "crash", root, pid: deadPid() });
      await writeFile(join(wt.path, "wip.txt"), "uncommitted\n");

      const report = await recoverOnStartup({ root });
      assert.ok(report.resumed.includes(wt.path));
      assert.ok(!report.removed.includes(wt.path));
      assert.equal((await entry(wt.path))?.status, "stale");
      assert.ok(existsSync(join(wt.path, "wip.txt")));
      assert.ok(branches().includes(wt.branch));

      const again = await createWorktree({ repoDir, issueKey, title: "crash", root });
      assert.equal(again.resumed, true);
      assert.ok(existsSync(join(again.path, "wip.txt")));
      const e = await entry(wt.path);
      assert.equal(e?.status, "active");
      assert.equal(e?.pid, process.pid);
    });

    test("folder deleted behind git's back: pruned, kept stale, re-created on resume", async () => {
      const issueKey = nextKey();
      const wt = await createWorktree({ repoDir, issueKey, title: "gone", root, pid: deadPid() });
      git(wt.path, "commit", "-q", "--allow-empty", "-m", "on branch");
      await rm(wt.path, { recursive: true, force: true });
      assert.match(registered(), new RegExp(`worktree ${wt.path}`));

      const report = await recoverOnStartup({ root });
      assert.ok(report.pruned.includes(wt.path));
      assert.ok(report.resumed.includes(wt.path));
      assert.doesNotMatch(registered(), new RegExp(`worktree ${wt.path}`));
      assert.equal((await entry(wt.path))?.status, "stale");

      const again = await createWorktree({ repoDir, issueKey, title: "gone", root });
      assert.equal(again.resumed, true);
      assert.equal(git(again.path, "log", "-1", "--format=%s"), "on branch");
    });

    test("crash mid-remove (status done): finishes the removal and drops the entry", async () => {
      const wt = await createWorktree({ repoDir, issueKey: nextKey(), title: "half", root });
      const manifest = await readManifest(root);
      for (const e of manifest.entries) if (e.path === wt.path) e.status = "done";
      await writeFile(join(root, MANIFEST_FILE), JSON.stringify(manifest));

      const report = await recoverOnStartup({ root });
      assert.ok(report.removed.includes(wt.path));
      assert.equal(existsSync(wt.path), false);
      assert.doesNotMatch(registered(), new RegExp(`worktree ${wt.path}`));
      assert.equal(await entry(wt.path), undefined);
      assert.ok(branches().includes(wt.branch));
    });

    test("removes orphan folders git no longer knows about", async () => {
      // A worktree whose git record was pruned while the folder survived.
      const wt = await createWorktree({ repoDir, issueKey: nextKey(), title: "orphan", root });
      const manifest = await readManifest(root);
      manifest.entries = manifest.entries.filter((e) => e.path !== wt.path);
      await writeFile(join(root, MANIFEST_FILE), JSON.stringify(manifest));
      await rm(join(repoDir, ".git", "worktrees", wt.branch), { recursive: true, force: true });
      // And a stray folder with no .git at all.
      const stray = join(root, "repo", "met-999-stray");
      await mkdir(stray, { recursive: true });

      const report = await recoverOnStartup({ root });
      assert.ok(report.removed.includes(wt.path));
      assert.ok(report.removed.includes(stray));
      assert.equal(existsSync(wt.path), false);
      assert.equal(existsSync(stray), false);
    });

    test("leaves worktrees owned by a live process alone", async () => {
      const wt = await createWorktree({
        repoDir,
        issueKey: nextKey(),
        title: "alive",
        root,
        pid: process.ppid,
      });
      const report = await recoverOnStartup({ root });
      assert.ok(!report.resumed.includes(wt.path));
      assert.ok(!report.removed.includes(wt.path));
      assert.equal((await entry(wt.path))?.status, "active");
      assert.ok(existsSync(wt.path));
    });

    test("treats its own pid as a reused pid from a dead daemon", async () => {
      const wt = await createWorktree({ repoDir, issueKey: nextKey(), title: "self", root });
      const report = await recoverOnStartup({ root });
      assert.ok(report.resumed.includes(wt.path));
      assert.equal((await entry(wt.path))?.status, "stale");
    });

    test("moves a corrupt manifest aside and still starts", async () => {
      const other = join(tmp, "corrupt-root");
      await mkdir(other);
      await writeFile(join(other, MANIFEST_FILE), "{ not json");
      const report = await recoverOnStartup({ root: other });
      assert.deepEqual(report, { resumed: [], removed: [], pruned: [] });
      const files = await readdir(other);
      assert.ok(files.some((f) => f.startsWith(`${MANIFEST_FILE}.corrupt-`)));
    });

    test("a missing root is a no-op", async () => {
      const report = await recoverOnStartup({ root: join(tmp, "never-created") });
      assert.deepEqual(report, { resumed: [], removed: [], pruned: [] });
    });
  });
});
