import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, before, test } from "node:test";
import {
  createGhCli,
  GitHubError,
  parsePullRequestFiles,
  parsePullRequestStatus,
  parsePullRequests,
  titleHasKey,
} from "./client.ts";

const FAKE = join(import.meta.dirname, "../../test/fixtures/fake-gh.mjs");

let dir = "";
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "harnessd-gh-"));
  // A `gh` on PATH that runs the fake, so the wrapper is tested as it runs for real.
  await writeFile(join(dir, "gh"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`, {
    mode: 0o755,
  });
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface Call {
  argv: string[];
  cwd: string;
  stdin: string;
  env: { GH_TOKEN: string | null; GH_PROMPT_DISABLED: string | null };
}

async function client(mode = "ok") {
  const record = join(dir, `record-${Math.random().toString(36).slice(2)}.jsonl`);
  const env: NodeJS.ProcessEnv = {
    PATH: `${dir}${delimiter}${process.env.PATH ?? ""}`,
    FAKE_GH_RECORD: record,
    FAKE_GH_MODE: mode,
    GH_TOKEN: "ghp_from_env",
  };
  const gh = createGhCli({ cwd: dir, env });
  const calls = async (): Promise<Call[]> =>
    (await readFile(record, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Call);
  return { gh, calls };
}

test("findPrForIssue lists open PRs with --json and picks the newest whose title has the key", async () => {
  const { gh, calls } = await client();
  const pr = await gh.findPrForIssue("MET-41");
  assert.deepEqual(pr, {
    number: 9,
    title: "MET-41: Serve avatars, take two",
    url: "https://github.test/o/r/pull/9",
    headRefName: "met-41-take-two",
    headRefOid: "sha9",
    baseRefName: "main",
    isDraft: false,
  });
  const [call] = await calls();
  assert.deepEqual(call?.argv, [
    "pr",
    "list",
    "--state",
    "open",
    "--search",
    "MET-41 in:title",
    "--limit",
    "30",
    "--json",
    "number,title,url,headRefName,headRefOid,baseRefName,isDraft,isCrossRepository",
  ]);
  assert.equal(call?.env.GH_TOKEN, "ghp_from_env", "the token reaches gh from the environment");
  assert.equal(call?.env.GH_PROMPT_DISABLED, "1");
  assert.equal(await gh.findPrForIssue("MET-99"), undefined);
});

test("findPrByHead lists open PRs for the exact branch and skips forks", async () => {
  const { gh, calls } = await client();
  assert.equal((await gh.findPrByHead("met-41-serve-avatars"))?.number, 7);
  const [call] = await calls();
  assert.deepEqual(call?.argv, [
    "pr",
    "list",
    "--head",
    "met-41-serve-avatars",
    "--state",
    "open",
    "--json",
    "number,title,url,headRefName,headRefOid,baseRefName,isDraft,isCrossRepository",
  ]);
  assert.equal(await gh.findPrByHead("met-41-missing"), undefined);
});

test("createPr sends the title and the body on stdin and returns the PR URL", async () => {
  const { gh, calls } = await client();
  const url = await gh.createPr({
    base: "main",
    head: "met-113-ship",
    title: "MET-113: Ship the work",
    body: "Summary\n\nHow: pnpm test",
  });
  assert.equal(url, "https://github.test/o/r/pull/99");
  const [call] = await calls();
  assert.deepEqual(call?.argv, [
    "pr",
    "create",
    "--base",
    "main",
    "--head",
    "met-113-ship",
    "--title",
    "MET-113: Ship the work",
    "--body-file",
    "-",
  ]);
  assert.equal(call?.stdin, "Summary\n\nHow: pnpm test");
});

test("prFiles reads gh pr view --json files", async () => {
  const { gh, calls } = await client();
  assert.deepEqual(await gh.prFiles(9), [
    { path: "src/a.ts", additions: 10, deletions: 2 },
    { path: "src/a.test.ts", additions: 30, deletions: 0 },
  ]);
  assert.deepEqual((await calls())[0]?.argv, ["pr", "view", "9", "--json", "files"]);
});

test("postReview sends the review as JSON on stdin through gh api and returns its URL", async () => {
  const { gh, calls } = await client();
  const url = await gh.postReview(9, {
    event: "REQUEST_CHANGES",
    body: 'Fails: "x"\n- y',
    commitId: "sha9",
  });
  assert.equal(url, "https://github.test/o/r/pull/9#pullrequestreview-99");
  const [call] = await calls();
  assert.deepEqual(call?.argv, [
    "api",
    "--method",
    "POST",
    "repos/{owner}/{repo}/pulls/9/reviews",
    "--input",
    "-",
  ]);
  assert.deepEqual(JSON.parse(call?.stdin ?? ""), {
    event: "REQUEST_CHANGES",
    body: 'Fails: "x"\n- y',
    commit_id: "sha9",
  });
});

test("prStatus reads one gh pr view with the gate's fields; the latest run of a check wins", async () => {
  const { gh, calls } = await client();
  const status = await gh.prStatus(7);
  assert.deepEqual((await calls())[0]?.argv, [
    "pr",
    "view",
    "7",
    "--json",
    "number,url,state,headRefOid,mergeable,statusCheckRollup,files,changedFiles",
  ]);
  assert.equal(status.state, "OPEN");
  assert.equal(status.headRefOid, "sha7");
  assert.equal(status.mergeable, "MERGEABLE");
  assert.equal(status.changedFiles, 2);
  assert.deepEqual(
    status.files.map((f) => f.path),
    ["src/a.ts", "src/auth/session.ts"],
  );
  assert.deepEqual(status.checks, [
    {
      name: "CI / test",
      state: "pass",
      detail: "SUCCESS",
      url: "https://github.test/o/r/actions/runs/2",
    },
    { name: "CI / lint", state: "pending", detail: "IN_PROGRESS" },
    { name: "ci/legacy", state: "pass", detail: "SUCCESS", url: "https://ci.test/1" },
  ]);
});

test("mergePr squashes at the approved head; addLabel creates a missing label once", async () => {
  const { gh, calls } = await client();
  await gh.mergePr(7, { method: "squash", matchHeadCommit: "sha7" });
  await gh.addLabel(7, "needs-human");
  assert.deepEqual(
    (await calls()).map((c) => c.argv),
    [
      ["pr", "merge", "7", "--squash", "--match-head-commit", "sha7"],
      ["pr", "edit", "7", "--add-label", "needs-human"],
    ],
  );

  const missing = await client("no-label");
  await missing.gh.addLabel(7, "needs-human");
  assert.deepEqual(
    (await missing.calls()).map((c) => c.argv.slice(0, 3)),
    [
      ["pr", "edit", "7"],
      ["label", "create", "needs-human"],
      ["pr", "edit", "7"],
    ],
  );
});

test("parsePullRequestStatus grades check runs and commit statuses", () => {
  const status = (rollup: unknown[], extra: Record<string, unknown> = {}) =>
    parsePullRequestStatus(
      JSON.stringify({
        number: 1,
        url: "u",
        state: "OPEN",
        headRefOid: "s",
        files: [],
        statusCheckRollup: rollup,
        ...extra,
      }),
    );
  const run = (status: string, conclusion: string) => ({
    __typename: "CheckRun",
    name: `${status}-${conclusion}`,
    status,
    conclusion,
  });
  const ctx = (state: string) => ({ __typename: "StatusContext", context: state, state });
  assert.deepEqual(
    status([
      run("COMPLETED", "SUCCESS"),
      run("COMPLETED", "NEUTRAL"),
      run("COMPLETED", "SKIPPED"),
      run("COMPLETED", "FAILURE"),
      run("COMPLETED", "CANCELLED"),
      run("COMPLETED", "TIMED_OUT"),
      run("QUEUED", ""),
      ctx("SUCCESS"),
      ctx("PENDING"),
      ctx("EXPECTED"),
      ctx("ERROR"),
      { __typename: "Mystery" },
    ]).checks.map((c) => c.state),
    [
      "pass",
      "pass",
      "pass",
      "fail",
      "fail",
      "fail",
      "pending",
      "pass",
      "pending",
      "pending",
      "fail",
      "pending",
    ],
  );
  const bare = status([], { statusCheckRollup: null });
  assert.deepEqual(bare.checks, []);
  assert.equal(bare.mergeable, "UNKNOWN");
  assert.equal(bare.changedFiles, 0);
  assert.throws(() => status([], { state: "DRAFT" }), /state: unexpected "DRAFT"/);
});

test("a failing gh call or unreadable output is a GitHubError with gh's message", async () => {
  const failing = await client("fail");
  await assert.rejects(
    failing.gh.postReview(9, { event: "APPROVE", body: "ok" }),
    (e: unknown) =>
      e instanceof GitHubError && /exited with code 1: HTTP 422: Can not approve/.test(e.message),
  );
  const garbage = await client("garbage");
  await assert.rejects(garbage.gh.findPrForIssue("MET-41"), /not JSON/);
  const missing = createGhCli({ cwd: dir, bin: join(dir, "no-such-gh"), env: {} });
  await assert.rejects(missing.prFiles(1), /could not run/);
});

test("the parsers reject wrong shapes", () => {
  assert.throws(() => parsePullRequests("{}"), /expected a JSON array/);
  assert.throws(() => parsePullRequests('[{"number":"1"}]'), /number: expected a number/);
  assert.throws(() => parsePullRequestFiles("[]"), /files array/);
});

test("titleHasKey matches the key as a whole word", () => {
  assert.equal(titleHasKey("MET-41: Serve avatars", "MET-41"), true);
  assert.equal(titleHasKey("feat: thing (met-41)", "MET-41"), true);
  assert.equal(titleHasKey("MET-410: other", "MET-41"), false);
  assert.equal(titleHasKey("XMET-41: other", "MET-41"), false);
});
