import assert from "node:assert/strict";
import { test } from "node:test";
import { LAUNCHD_LABEL } from "../status/launchd.ts";
import { checkForUpdate, detectSelfUpdate, type SelfUpdateRunner } from "./detect.ts";

const root = "/install";
const workspace = "/workspace";
const from = "a".repeat(40);
const to = "b".repeat(40);

const status =
  "git /install --no-optional-locks status --porcelain --untracked-files=all --ignore-submodules=none";
const fetch =
  "git /install fetch --no-tags --no-recurse-submodules --refmap= origin +refs/heads/trunk:refs/remotes/origin/trunk";

// Flag order does not affect the fake response. Tests still see the exact commands.
function commandKey(command: string): string {
  const words = command.split(" ");
  return [
    ...words.filter((word) => !word.startsWith("--")),
    ...words.filter((word) => word.startsWith("--")).sort(),
  ].join(" ");
}

function fake() {
  const installOrigin = "git@github.com:Owner/Repo.git";
  const workspaceOrigin = "https://github.com/owner/repo";
  const calls: string[] = [];
  const log: string[] = [];
  const paths = new Map<string, "directory" | "entry">([
    ["/workspace/packages/daemon", "directory"],
  ]);
  const answers = new Map<string, string | number>([
    ["git /install/packages/cli/dist rev-parse --show-toplevel", root],
    ["git /install remote get-url origin", installOrigin],
    ["git /workspace remote get-url origin", workspaceOrigin],
    [`launchctl print gui/501/${LAUNCHD_LABEL}`, "\tpid = 42\n"],
    [status, ""],
    ["git /install symbolic-ref --quiet HEAD", "refs/heads/trunk"],
    [fetch, ""],
    ["git /install rev-parse --verify HEAD^{commit}", from],
    ["git /install rev-parse --verify refs/remotes/origin/trunk^{commit}", to],
    [`git /install merge-base --is-ancestor ${from} ${to}`, ""],
  ]);
  for (const marker of ["MERGE_HEAD", "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD"]) {
    answers.set(
      `git /install rev-parse --path-format=absolute --git-path ${marker}`,
      `/git-dir/${marker}`,
    );
  }
  const runner: SelfUpdateRunner = {
    exec: async (cmd, args, options) => {
      const key = [cmd, options?.cwd, ...args].filter(Boolean).join(" ");
      calls.push(key);
      const response = [...answers].find(([command]) => commandKey(command) === commandKey(key));
      const answer = response?.[1];
      assert.notEqual(answer, undefined, key);
      return typeof answer === "number"
        ? { code: answer, stdout: "", stderr: "" }
        : { code: 0, stdout: answer ?? "", stderr: "" };
    },
    pathKind: async (path) => paths.get(path),
  };
  const detect = (selfUpdate = true) =>
    detectSelfUpdate(
      {
        cliUrl: "file:///install/packages/cli/dist/bin.js",
        workspace,
        selfUpdate,
        pid: 42,
        uid: 501,
        log: (line) => log.push(line),
      },
      runner,
    );
  return { answers, calls, log, paths, runner, detect };
}

test("disables self-update from config before it runs any command", async () => {
  const f = fake();
  const detection = await f.detect(false);
  assert.equal(detection.kind, "off");
  assert.deepEqual(await checkForUpdate(detection, "trunk", f.runner), { kind: "none" });
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.log, ["Self-update is off. daemon.self_update is false."]);
});

test("finds the source install when both GitHub origins match and launchd owns the PID", async () => {
  for (const url of [
    "git@github.com:Owner/Repo.git",
    "ssh://git@github.com/owner/repo.git",
    "https://github.com/owner/repo.git",
  ]) {
    const f = fake();
    f.answers.set("git /install remote get-url origin", url);
    assert.deepEqual(await f.detect(), { kind: "on", installRoot: root });
    assert.deepEqual(f.log, []);
  }
});

for (const [name, command, result, reason] of [
  [
    "a non-clone",
    "git /install/packages/cli/dist rev-parse --show-toplevel",
    128,
    /outside a git clone/,
  ],
  [
    "a different origin",
    "git /workspace remote get-url origin",
    "https://github.com/other/repo",
    /same GitHub origin/,
  ],
  [
    "a loaded service with a different PID",
    `launchctl print gui/501/${LAUNCHD_LABEL}`,
    "\tpid = 43\n",
    /outside the harnessd launchd service/,
  ],
  [
    "a missing launchd service",
    `launchctl print gui/501/${LAUNCHD_LABEL}`,
    113,
    /outside the harnessd launchd service/,
  ],
] as const) {
  test(`disables self-update for ${name}`, async () => {
    const f = fake();
    f.answers.set(command, result);
    assert.deepEqual(await f.detect(), { kind: "off" });
    assert.equal(f.log.length, 1);
    assert.match(f.log.join(), reason);
  });
}

test("disables self-update when the workspace has no daemon directory", async () => {
  const f = fake();
  f.paths.clear();
  assert.deepEqual(await f.detect(), { kind: "off" });
  assert.match(f.log.join(), /no packages\/daemon directory/);
});

test("names local changes and performs no git write", async () => {
  const f = fake();
  const detection = await f.detect();
  f.calls.length = 0;
  f.answers.set(status, ' M tracked.ts\n?? "new file.ts"\n');
  assert.deepEqual(await checkForUpdate(detection, "trunk", f.runner), {
    kind: "blocked",
    reason: 'Local changes in the install clone: tracked.ts, "new file.ts"',
  });
  assert.deepEqual(f.calls, [status]);
});

for (const marker of ["MERGE_HEAD", "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD"]) {
  test(`blocks when ${marker} is present in the resolved git directory`, async () => {
    const f = fake();
    f.paths.set(`/git-dir/${marker}`, "entry");
    const result = await checkForUpdate(await f.detect(), "trunk", f.runner);
    assert.equal(result.kind, "blocked");
    assert.match(result.reason, new RegExp(marker));
    assert.ok(!f.calls.includes(fetch));
  });
}

for (const [name, command, result, reason] of [
  ["HEAD is detached", "git /install symbolic-ref --quiet HEAD", 1, /default branch/],
  [
    "HEAD is on a different branch",
    "git /install symbolic-ref --quiet HEAD",
    "refs/heads/topic",
    /default branch/,
  ],
  ["fetch fails", fetch, 128, /git fetch failed/],
  [
    "HEAD cannot fast-forward",
    `git /install merge-base --is-ancestor ${from} ${to}`,
    1,
    /cannot fast-forward/,
  ],
] as const) {
  test(`blocks when ${name}`, async () => {
    const f = fake();
    f.answers.set(command, result);
    const check = await checkForUpdate(await f.detect(), "trunk", f.runner);
    assert.equal(check.kind, "blocked");
    assert.match(check.reason, reason);
  });
}

test("returns none when the fetched commit equals HEAD", async () => {
  const f = fake();
  f.answers.set("git /install rev-parse --verify refs/remotes/origin/trunk^{commit}", from);
  assert.deepEqual(await checkForUpdate(await f.detect(), "trunk", f.runner), { kind: "none" });
  assert.ok(f.calls.includes(fetch));
});

test("returns both commits when the fetched commit is ahead", async () => {
  const f = fake();
  assert.deepEqual(await checkForUpdate(await f.detect(), "trunk", f.runner), {
    kind: "pending",
    from,
    to,
  });
});
