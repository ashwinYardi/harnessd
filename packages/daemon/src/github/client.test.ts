import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, before, test } from "node:test";
import {
  createGhCli,
  GitHubError,
  parsePullRequestFiles,
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
    "number,title,url,headRefName,headRefOid,baseRefName,isDraft",
  ]);
  assert.equal(call?.env.GH_TOKEN, "ghp_from_env", "the token reaches gh from the environment");
  assert.equal(call?.env.GH_PROMPT_DISABLED, "1");
  assert.equal(await gh.findPrForIssue("MET-99"), undefined);
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
