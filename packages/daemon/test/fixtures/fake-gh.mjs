#!/usr/bin/env node
// Stand-in for the `gh` CLI in GitHub wrapper tests.
// FAKE_GH_RECORD: file each call appends {argv, cwd, stdin, env} to, one JSON line per call.
// FAKE_GH_MODE: ok (default) | fail | garbage
import { appendFileSync, readFileSync } from "node:fs";

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
if (cmd === "pr" && sub === "list") {
  process.stdout.write(
    JSON.stringify([
      pr(7, "MET-41: Serve avatars", "met-41-serve-avatars"),
      pr(9, "MET-41: Serve avatars, take two", "met-41-take-two"),
      pr(11, "MET-410: Something else", "met-410-else"),
      pr(12, "Mentions MET-4 only", "met-4"),
    ]),
  );
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
