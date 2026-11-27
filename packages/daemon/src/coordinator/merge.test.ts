import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SETTINGS, type LinkedIssue, type WorkflowStateName } from "@harnessd/shared";
import type { PullRequestStatus } from "../github/client.ts";
import { advanceMerges, ciVerdict, globToRegExp, type MergeDeps, protectedFiles } from "./merge.ts";
import { formatNotice } from "./notifier.ts";
import { partMarker } from "./split.ts";
import { emptyLoopState, type LoopState } from "./state.ts";

test("globs: ** spans directories, * and ? stay in one, braces pick, case is ignored", () => {
  const yes = (glob: string, path: string) =>
    assert.ok(globToRegExp(glob).test(path), `${glob} ~ ${path}`);
  const no = (glob: string, path: string) =>
    assert.ok(!globToRegExp(glob).test(path), `${glob} !~ ${path}`);
  yes("**/auth/**", "auth/login.ts");
  yes("**/auth/**", "packages/daemon/src/Auth/x/y.ts");
  no("**/auth/**", "src/author/x.ts");
  no("**/auth/**", "src/oauth.ts");
  yes(".github/workflows/**", ".github/workflows/release.yml");
  no(".github/workflows/**", "docs/.github/workflows/x.yml");
  yes(".github/workflows/release*", ".github/workflows/release-npm.yml");
  no("src/*.ts", "src/a/b.ts");
  yes("src/?.ts", "src/a.ts");
  yes("src/*.{ts,js}", "src/a.js");
  no("src/*.{ts,js}", "src/a.md");
  yes("/docs/RELEASING.md", "docs/releasing.md");
  yes("./docs/RELEASING.md", "docs/RELEASING.md");
  // No slash: the file name, at any depth, as in .gitignore.
  yes("*.pem", "deploy/certs/server.pem");
  yes("CODEOWNERS", ".github/CODEOWNERS");
  no("a+b(c).md", "aab(c).md");
});

test("the default protected paths cover auth, payments, secrets, release config and the merge gate", () => {
  const globs = DEFAULT_SETTINGS.merge.protected_paths;
  const touched = [
    "packages/api/src/auth/session.ts",
    "src/auth.ts",
    "services/payments/charge.ts",
    "src/billing/invoice.ts",
    "config/secrets/prod.json",
    "scripts/rotate-secret.sh",
    ".env",
    "apps/web/.env.local",
    "certs/server.pem",
    "deploy/id.key",
    ".github/workflows/release.yml",
    ".github/workflows/ci.yml",
    "docs/RELEASING.md",
    ".releaserc.json",
    "release.config.js",
    ".harnessd/config.toml",
    ".github/CODEOWNERS",
    "CODEOWNERS",
    ".github/settings.yml",
    ".github/rulesets/main.json",
  ];
  assert.deepEqual(protectedFiles(touched, globs), touched);
  const fine = [
    "packages/daemon/src/coordinator/loop.ts",
    "src/author.ts",
    "docs/LOOP.md",
    ".harnessd/AGENTS.md",
    ".github/pull_request_template.md",
    "src/environment.ts",
  ];
  assert.deepEqual(protectedFiles(fine, globs), []);
  assert.deepEqual(protectedFiles(["src/auth/x.ts"], []), [], "an empty list protects nothing");
});

test("CI is green only when every check passed, and there is at least one", () => {
  const pass = { name: "a", state: "pass" as const, detail: "SUCCESS" };
  const pending = { name: "b", state: "pending" as const, detail: "QUEUED" };
  const fail = { name: "c", state: "fail" as const, detail: "FAILURE" };
  assert.equal(ciVerdict([pass]).state, "pass");
  assert.equal(ciVerdict([]).state, "pending");
  assert.equal(ciVerdict([pass, pending]).state, "pending");
  assert.deepEqual(ciVerdict([pass, pending, fail]), {
    state: "fail",
    failing: [fail],
    pending: [pending],
  });
});

function deps(status: Partial<PullRequestStatus>, state: LoopState) {
  const moves: Array<[string, WorkflowStateName]> = [];
  const pings: string[] = [];
  const merged: number[] = [];
  const d: MergeDeps = {
    github: {
      async prStatus(number) {
        return {
          number,
          url: `https://github.test/pull/${number}`,
          state: "OPEN",
          headRefOid: "sha7",
          mergeable: "MERGEABLE",
          checks: [{ name: "t", state: "pass", detail: "SUCCESS" }],
          files: [{ path: "src/a.ts", additions: 1, deletions: 0 }],
          changedFiles: 1,
          ...status,
        };
      },
      async mergePr(number) {
        merged.push(number);
      },
      async addLabel() {},
    },
    linear: {
      async comment() {
        return "c";
      },
      async moveTo(id, to) {
        moves.push([id, to]);
      },
      async listChildren() {
        return [];
      },
    },
    notifier: {
      async notify(notice) {
        pings.push(formatNotice(notice));
      },
    },
    config: DEFAULT_SETTINGS.merge,
    maxFailures: 2,
    paused: () => false,
    save: async () => {},
  };
  state.merges.push({
    qaId: "qa",
    qaKey: "MET-3",
    parentId: "parent",
    parentKey: "MET-1",
    parentUrl: "https://linear.test/MET-1",
    approvedAt: "2026-11-19T10:00:00.000Z",
    prs: [
      {
        partId: "part",
        partKey: "MET-2",
        number: 7,
        url: "https://github.test/pull/7",
        sha: "sha7",
      },
    ],
  });
  // D-013 needs the reviewer's approval at the same head as QA's (MET-226).
  state.reviewerHeads = {
    part: {
      sha: "sha7",
      verdict: "approved",
      findings: [],
      at: "2026-11-19T10:00:00.000Z",
    },
  };
  return { d, moves, pings, merged };
}

test("the gate refuses a merge without both approvals on the same head (MET-226)", async () => {
  const logs: string[] = [];
  const noReviewer = emptyLoopState();
  const first = deps({}, noReviewer);
  delete noReviewer.reviewerHeads;
  first.d.log = (line) => logs.push(line);
  const firstReport = await advanceMerges(noReviewer, first.d);
  assert.deepEqual(first.merged, [], "no merge without the reviewer");
  assert.deepEqual(firstReport.merged, []);
  assert.equal(noReviewer.merges.length, 1, "the approval waits for the review");
  assert.ok(logs.includes("MET-2: PR #7 waits (reviewer approval pending)"), logs.join("\n"));

  const staleReview = emptyLoopState();
  const second = deps({}, staleReview);
  staleReview.reviewerHeads = {
    part: {
      sha: "sha6",
      verdict: "approved",
      findings: [],
      at: "2026-11-19T10:00:00.000Z",
    },
  };
  await advanceMerges(staleReview, second.d);
  assert.deepEqual(second.merged, [], "the reviewer approved another head");
  assert.equal(staleReview.merges.length, 1);

  const changesRequested = emptyLoopState();
  const blocked = deps({}, changesRequested);
  changesRequested.reviewerHeads = {
    part: {
      sha: "sha7",
      verdict: "changes_requested",
      findings: [],
      at: "2026-11-19T10:00:00.000Z",
    },
  };
  await advanceMerges(changesRequested, blocked.d);
  assert.deepEqual(blocked.merged, [], "a verdict on sha7 still has to be an approval");

  const noQa = emptyLoopState();
  const untested = deps({}, noQa);
  noQa.merges = [];
  await advanceMerges(noQa, untested.d);
  assert.deepEqual(untested.merged, [], "reviewer approval alone cannot merge");

  const both = emptyLoopState();
  const third = deps({}, both);
  const report = await advanceMerges(both, third.d);
  assert.deepEqual(third.merged, [7], "both approvals name sha7, so it merges");
  assert.deepEqual(report.merged, ["MET-2"]);
  assert.deepEqual(both.merges, []);
});

test("a PR closed without merging is left to a human: one ping, the approval dropped", async () => {
  const state = emptyLoopState();
  const { d, moves, pings, merged } = deps({ state: "CLOSED" }, state);
  await advanceMerges(state, d);
  assert.deepEqual(merged, []);
  assert.deepEqual(moves, [["parent", "Needs input"]]);
  assert.deepEqual(pings, [
    "MET-2 needs a human (closed without merging): PR #7 https://github.test/pull/7 (MET-1 https://linear.test/MET-1)",
  ]);
  assert.deepEqual(state.merges, []);
});

test("a merge-gate send-back writes no cases; an escalation clears the saved cases (D-056)", async () => {
  const state = emptyLoopState();
  const saved = [
    {
      id: "C1",
      item: "Has tests",
      repro: "pnpm test",
      expected: "it passes",
      actual: "not ok 4",
    },
  ];
  state.reviewedHeads = {
    part: { sha: "sha7", verdict: "changes_requested", cases: saved },
  };
  state.qaFeedback.part = { failing: ["Has tests: no test"], cases: saved };
  const failed = {
    checks: [{ name: "t", state: "fail" as const, detail: "FAILURE" }],
  };

  const first = deps(failed, state);
  const report = await advanceMerges(state, first.d);
  assert.deepEqual(report.sentBack, ["MET-2"]);
  assert.deepEqual(state.qaFeedback.part, {
    prUrl: "https://github.test/pull/7",
    failing: ["CI: `t` failure"],
  });
  assert.equal(state.reviewedHeads.part?.cases, undefined, "the next QA is a full round");

  const second = deps(failed, state);
  assert.deepEqual((await advanceMerges(state, second.d)).sentBack, []);
  assert.equal(second.moves.find(([id]) => id === "parent")?.[1], "Needs input");
  assert.equal(state.qaFeedback.part, undefined);
  assert.equal(state.reviewedHeads.part?.cases, undefined, "the saved cases are cleared");
});

test("a file list shorter than the PR's changed files is never trusted", async () => {
  const state = emptyLoopState();
  const { d, merged, pings } = deps({ changedFiles: 3001 }, state);
  const report = await advanceMerges(state, d);
  assert.deepEqual(merged, []);
  assert.deepEqual(report.needsHuman, ["MET-2"]);
  assert.match(pings[0] ?? "", /GitHub listed 1 of 3001 changed files/);
});

test("an unreadable pause flag never lets a merge through", async () => {
  const state = emptyLoopState();
  const { d, merged } = deps({}, state);
  d.paused = () => {
    throw new Error("EACCES");
  };
  const report = await advanceMerges(state, d);
  assert.equal(report.paused, true);
  assert.deepEqual(merged, []);
  assert.equal(state.merges.length, 1);
});

test("a canceled part does not block Done: QA and the parent move to Done", async () => {
  const state = emptyLoopState();
  const { d, moves } = deps({}, state);
  const part = (id: string, key: string, marker: string, partState: string): LinkedIssue =>
    ({
      id,
      key,
      title: key,
      description: partMarker(marker),
      priority: 3,
      state: partState,
      labels: [],
      size: "S",
      doneWhen: [],
      url: `https://linear.test/${key}`,
      blockedBy: [],
      blockers: [],
    }) as LinkedIssue;
  d.linear.listChildren = async () => [
    part("part", "MET-2", "backend", "Done"),
    part("gone", "MET-9", "backend-2", "Canceled"),
  ];

  const report = await advanceMerges(state, d);

  assert.deepEqual(report.done, ["MET-1"]);
  assert.deepEqual(moves, [
    ["part", "Done"],
    ["qa", "Done"],
    ["parent", "Done"],
  ]);
  assert.deepEqual(state.merges, []);
});
