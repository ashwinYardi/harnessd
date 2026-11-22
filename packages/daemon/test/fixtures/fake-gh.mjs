#!/usr/bin/env node
// Stand-in for the `gh` CLI in GitHub wrapper tests.
// FAKE_GH_RECORD: file each call appends {argv, cwd, stdin, env} to, one JSON line per call.
// FAKE_GH_MODE: ok (default) | fail | garbage | no-label (`pr edit` fails until `label create` ran)
import { appendFileSync, existsSync, readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const mode = process.env.FAKE_GH_MODE ?? "ok";
const stdin = readFileSync(0, "utf8");
if (process.env.FAKE_GH_RECORD) {
  const env = {
    GH_TOKEN: process.env.GH_TOKEN ?? null,
    GH_PROMPT_DISABLED: process.env.GH_PROMPT_DISABLED ?? null,
  };
  appendFileSync(
    process.env.FAKE_GH_RECORD,
    `${JSON.stringify({ argv, cwd: process.cwd(), stdin, env })}\n`,
  );
}

if (mode === "fail") {
  process.stderr.write("HTTP 422: Can not approve your own pull request\n");
  process.exit(1);
}
if (mode === "garbage") {
  process.stdout.write("not json\n");
  process.exit(0);
}

const pr = (number, title, branch) => ({
  number,
  title,
  url: `https://github.test/o/r/pull/${number}`,
  headRefName: branch,
  headRefOid: `sha${number}`,
  baseRefName: "main",
  isDraft: false,
});

const [cmd, sub] = argv;
if (cmd === "repo" && sub === "view") {
  process.stdout.write(JSON.stringify({ defaultBranchRef: { name: "main" } }));
} else if (cmd === "pr" && sub === "list") {
  process.stdout.write(
    JSON.stringify([
      { ...pr(13, "From a fork", "met-41-serve-avatars"), isCrossRepository: true },
      pr(7, "MET-41: Serve avatars", "met-41-serve-avatars"),
      pr(9, "MET-41: Serve avatars, take two", "met-41-take-two"),
      pr(11, "MET-410: Something else", "met-410-else"),
      pr(12, "Mentions MET-4 only", "met-4"),
    ]),
  );
} else if (cmd === "pr" && sub === "create") {
  process.stdout.write("https://github.test/o/r/pull/99\n");
} else if (cmd === "pr" && sub === "view" && argv.at(-1)?.includes("statusCheckRollup")) {
  process.stdout.write(
    JSON.stringify({
      number: Number(argv[2]),
      url: `https://github.test/o/r/pull/${argv[2]}`,
      state: "OPEN",
      headRefOid: `sha${argv[2]}`,
      mergeable: "MERGEABLE",
      changedFiles: 2,
      files: [
        { path: "src/a.ts", additions: 10, deletions: 2 },
        { path: "src/auth/session.ts", additions: 1, deletions: 0 },
      ],
      statusCheckRollup: [
        {
          __typename: "CheckRun",
          name: "test",
          workflowName: "CI",
          status: "COMPLETED",
          conclusion: "FAILURE",
          startedAt: "2026-11-19T10:00:00Z",
          completedAt: "2026-11-19T10:01:00Z",
          detailsUrl: "https://github.test/o/r/actions/runs/1",
        },
        {
          __typename: "CheckRun",
          name: "test",
          workflowName: "CI",
          status: "COMPLETED",
          conclusion: "SUCCESS",
          startedAt: "2026-11-19T10:05:00Z",
          completedAt: "2026-11-19T10:06:00Z",
          detailsUrl: "https://github.test/o/r/actions/runs/2",
        },
        {
          __typename: "CheckRun",
          name: "lint",
          workflowName: "CI",
          status: "IN_PROGRESS",
          conclusion: "",
          startedAt: "2026-11-19T10:05:00Z",
          completedAt: "0001-01-01T00:00:00Z",
        },
        {
          __typename: "StatusContext",
          context: "ci/legacy",
          state: "SUCCESS",
          startedAt: "2026-11-19T10:02:00Z",
          targetUrl: "https://ci.test/1",
        },
      ],
    }),
  );
} else if (cmd === "pr" && sub === "merge") {
  process.stdout.write(`Squashed and merged pull request #${argv[2]}\n`);
} else if (cmd === "pr" && sub === "edit") {
  const created =
    process.env.FAKE_GH_RECORD &&
    existsSync(process.env.FAKE_GH_RECORD) &&
    readFileSync(process.env.FAKE_GH_RECORD, "utf8").includes('"label","create"');
  if (mode === "no-label" && !created) {
    process.stderr.write(`could not add label: '${argv.at(-1)}' not found\n`);
    process.exit(1);
  }
  process.stdout.write(`https://github.test/o/r/pull/${argv[2]}\n`);
} else if (cmd === "label" && sub === "create") {
  process.stdout.write("");
} else if (cmd === "pr" && sub === "view") {
  process.stdout.write(
    JSON.stringify({
      files: [
        { path: "src/a.ts", additions: 10, deletions: 2 },
        { path: "src/a.test.ts", additions: 30, deletions: 0 },
      ],
    }),
  );
} else if (cmd === "api") {
  const body = JSON.parse(stdin);
  process.stdout.write(
    JSON.stringify({
      id: 99,
      state: body.event === "APPROVE" ? "APPROVED" : "CHANGES_REQUESTED",
      html_url: "https://github.test/o/r/pull/9#pullrequestreview-99",
    }),
  );
} else {
  process.stderr.write(`fake gh: unknown command ${argv.join(" ")}\n`);
  process.exit(2);
}
