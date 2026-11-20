import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SETTINGS, type WorkflowStateName } from "@harnessd/shared";
import type { PullRequestStatus } from "../github/client.ts";
import { advanceMerges, ciVerdict, globToRegExp, type MergeDeps, protectedFiles } from "./merge.ts";
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
      async notify(text) {
        pings.push(text);
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
  return { d, moves, pings, merged };
}

test("a PR closed without merging is left to a human: one ping, the approval dropped", async () => {
  const state = emptyLoopState();
  const { d, moves, pings, merged } = deps({ state: "CLOSED" }, state);
  await advanceMerges(state, d);
  assert.deepEqual(merged, []);
  assert.deepEqual(moves, [["parent", "Needs input"]]);
  assert.deepEqual(pings, [
    "MET-2 needs a human (closed without merging): PR #7 https://github.test/pull/7",
  ]);
  assert.deepEqual(state.merges, []);
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
