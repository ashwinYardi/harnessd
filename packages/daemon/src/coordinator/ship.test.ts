import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { CreatePrInput, GitHub, PullRequest } from "../github/client.ts";
import { createGitWorktrees } from "../worktrees/index.ts";
import { MAX_COMMIT_BODY, prBody, shipPart, shipTitle } from "./ship.ts";

const roots: string[] = [];
after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function remoteGit(remote: string, ...args: string[]): string {
  return execFileSync("git", ["--git-dir", remote, ...args], { encoding: "utf8" }).trim();
}

function fakeGithub(open?: PullRequest) {
  const created: CreatePrInput[] = [];
  const github: GitHub = {
    async defaultBranch() {
      return "main";
    },
    async findPrByHead(branch) {
      return open?.headRefName === branch ? open : undefined;
    },
    async findPrForIssue(key) {
      return open?.title.startsWith(`${key}:`) ? open : undefined;
    },
    async createPr(input) {
      created.push(input);
      return "https://github.test/o/r/pull/99";
    },
    prFiles: () => Promise.reject(new Error("ship never reads files")),
    prDiff: () => Promise.reject(new Error("ship never reads the diff")),
    postReview: () => Promise.reject(new Error("ship never reviews")),
    prStatus: () => Promise.reject(new Error("ship never reads the status")),
    mergePr: () => Promise.reject(new Error("ship never merges")),
    addLabel: () => Promise.reject(new Error("ship never labels")),
  };
  return { github, created };
}

/** A repo with a bare origin, the branch checked out in a worktree, and a git identity. */
async function repo() {
  const root = await mkdtemp(join(tmpdir(), "harnessd-ship-"));
  roots.push(root);
  const remote = join(root, "remote.git");
  const dir = join(root, "repo");
  execFileSync("git", ["init", "-q", "--bare", remote]);
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  git(dir, "config", "user.name", "Test Owner");
  git(dir, "config", "user.email", "owner@example.test");
  await writeFile(join(dir, "README.md"), "hi\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
  git(dir, "remote", "add", "origin", remote);
  git(dir, "push", "-q", "-u", "origin", "main");
  const worktrees = createGitWorktrees({ repoDir: dir, root: join(root, "worktrees") });
  const worktree = await worktrees.create({ issueKey: "MET-41", title: "Ship it" });
  return { root, dir, remote, worktree };
}

function excludesEnv(file: string): Record<string, string> {
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.excludesFile",
    GIT_CONFIG_VALUE_0: file,
  };
}

test("shipPart commits the worktree, pushes the branch and opens a PR as the daemon", async () => {
  const r = await repo();
  const { github, created } = fakeGithub();
  await writeFile(join(r.worktree.path, "ship.ts"), "export const shipped = true;\n");

  const result = await shipPart({
    worktree: r.worktree.path,
    branch: r.worktree.branch,
    issueKey: "MET-41",
    title: "Ship it",
    issueUrl: "https://linear.test/MET-41",
    finalText: "Add the ship step.\n\nChecked with pnpm test.",
    github,
  });

  assert.deepEqual(result, {
    ok: true,
    committed: true,
    prUrl: "https://github.test/o/r/pull/99",
    created: true,
  });
  const local = git(r.worktree.path, "rev-parse", "HEAD");
  assert.equal(remoteGit(r.remote, "rev-parse", `refs/heads/${r.worktree.branch}`), local);
  assert.equal(git(r.worktree.path, "log", "-1", "--format=%s"), "MET-41: Ship it");
  assert.match(git(r.worktree.path, "log", "-1", "--format=%b"), /Add the ship step\./);
  assert.equal(git(r.worktree.path, "log", "-1", "--format=%an"), "Test Owner");
  assert.deepEqual(created, [
    {
      base: "main",
      head: r.worktree.branch,
      title: "MET-41: Ship it",
      body: "Add the ship step.\n\nChecked with pnpm test.\n\nIssue: https://linear.test/MET-41",
    },
  ]);
});

test("a part title with a parent key prefix gives a commit and PR title with one key", async () => {
  const r = await repo();
  const { github, created } = fakeGithub();
  await writeFile(join(r.worktree.path, "ship.ts"), "export const shipped = true;\n");

  const result = await shipPart({
    worktree: r.worktree.path,
    branch: r.worktree.branch,
    issueKey: "MET-124",
    title: "MET-123: cut token spend per parent",
    github,
  });

  assert.equal(result.ok, true);
  const subject = "MET-124: cut token spend per parent";
  assert.equal(git(r.worktree.path, "log", "-1", "--format=%s"), subject);
  assert.equal(created[0]?.title, subject, "the PR names only the part key");
  assert.deepEqual(created[0]?.title.match(/MET-\d+/g), ["MET-124"]);
});

test("shipTitle cuts leading key prefixes only, and never adds a second key", () => {
  assert.equal(shipTitle("MET-124", "MET-123: cut spend"), "MET-124: cut spend");
  assert.equal(shipTitle("MET-124", "[MET-123] cut spend"), "MET-124: cut spend");
  assert.equal(shipTitle("MET-124", "MET-123 cut spend"), "MET-124: cut spend");
  assert.equal(shipTitle("MET-124", "MET-123: MET-120: cut spend"), "MET-124: cut spend");
  assert.equal(shipTitle("MET-124", "MET-123"), "MET-124", "a title that is only a key");
  assert.equal(
    shipTitle("MET-124", "Cut MET-123 from the title"),
    "MET-124: Cut MET-123 from the title",
  );
  assert.equal(shipTitle("MET-124", "UTF-8 support"), "MET-124: UTF-8 support");
  assert.equal(shipTitle("MET-124", "OTHER-9: work"), "MET-124: OTHER-9: work");
});

test("a run with no changes fails as no changes and pushes nothing", async () => {
  const r = await repo();
  const { github, created } = fakeGithub();

  const result = await shipPart({
    worktree: r.worktree.path,
    branch: r.worktree.branch,
    issueKey: "MET-41",
    title: "Ship it",
    github,
  });

  assert.deepEqual(result, { ok: false, error: "no changes" });
  assert.deepEqual(created, []);
  assert.throws(
    () => remoteGit(r.remote, "rev-parse", "--verify", `refs/heads/${r.worktree.branch}`),
    /fatal/,
  );
});

test("a rejected push fails with push failed and never forces", async () => {
  const r = await repo();
  const { github, created } = fakeGithub();
  const hook = join(r.remote, "hooks", "pre-receive");
  await mkdir(join(r.remote, "hooks"), { recursive: true });
  await writeFile(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  await writeFile(join(r.worktree.path, "ship.ts"), "export const shipped = true;\n");

  const result = await shipPart({
    worktree: r.worktree.path,
    branch: r.worktree.branch,
    issueKey: "MET-41",
    title: "Ship it",
    github,
  });

  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /^push failed: /);
  assert.deepEqual(created, []);
  assert.equal(git(r.worktree.path, "log", "-1", "--format=%s"), "MET-41: Ship it");
});

test("the push updates an open PR on the run branch even after its PR title changes", async () => {
  const r = await repo();
  const open: PullRequest = {
    number: 7,
    title: "Ship it",
    url: "https://github.test/o/r/pull/7",
    headRefName: r.worktree.branch,
    headRefOid: "sha7",
    baseRefName: "main",
    isDraft: false,
  };
  const { github, created } = fakeGithub(open);
  await writeFile(join(r.worktree.path, "ship.ts"), "export const shipped = true;\n");

  const result = await shipPart({
    worktree: r.worktree.path,
    branch: r.worktree.branch,
    issueKey: "MET-41",
    title: "Ship it",
    github,
  });

  assert.deepEqual(result, {
    ok: true,
    committed: true,
    prUrl: "https://github.test/o/r/pull/7",
    created: false,
  });
  assert.deepEqual(created, []);
  assert.equal(
    remoteGit(r.remote, "rev-parse", `refs/heads/${r.worktree.branch}`),
    git(r.worktree.path, "rev-parse", "HEAD"),
  );
});

test("an open PR for the issue on a different branch blocks a second PR", async () => {
  const r = await repo();
  const { github, created } = fakeGithub({
    number: 7,
    title: "MET-41: Old title",
    url: "https://github.test/o/r/pull/7",
    headRefName: "met-41-old-title",
    headRefOid: "sha7",
    baseRefName: "main",
    isDraft: false,
  });
  await writeFile(join(r.worktree.path, "ship.ts"), "export const shipped = true;\n");

  const result = await shipPart({
    worktree: r.worktree.path,
    branch: r.worktree.branch,
    issueKey: "MET-41",
    title: "Ship it",
    github,
  });

  assert.deepEqual(result, {
    ok: false,
    error: `the open PR for MET-41 is on branch met-41-old-title, not ${r.worktree.branch}`,
  });
  assert.deepEqual(created, []);
});

test("the run's excludes file keeps a synced file out of the commit", async () => {
  const r = await repo();
  const { github, created } = fakeGithub();
  await writeFile(join(r.worktree.path, "AGENTS.md"), "# generated by sync\n");
  await writeFile(join(r.worktree.path, "ship.ts"), "export const shipped = true;\n");
  const excludes = join(r.root, "run.gitignore");
  await writeFile(excludes, "/AGENTS.md\n");

  const result = await shipPart({
    worktree: r.worktree.path,
    branch: r.worktree.branch,
    issueKey: "MET-41",
    title: "Ship it",
    env: excludesEnv(excludes),
    github,
  });

  assert.equal(result.ok, true);
  const tree = remoteGit(r.remote, "ls-tree", "-r", "--name-only", r.worktree.branch);
  assert.match(tree, /ship\.ts/);
  assert.doesNotMatch(tree, /AGENTS\.md/);
  assert.equal(created.length, 1);
});

test("prBody has the final text and one issue line", () => {
  assert.equal(
    prBody("Summary\n\nHow: pnpm test", "https://linear.test/MET-41"),
    "Summary\n\nHow: pnpm test\n\nIssue: https://linear.test/MET-41",
  );
  assert.equal(
    prBody(undefined, "https://linear.test/MET-41"),
    "Issue: https://linear.test/MET-41",
  );
  assert.equal(prBody("  ", undefined), "");
  assert.equal(MAX_COMMIT_BODY, 2_000);
});
