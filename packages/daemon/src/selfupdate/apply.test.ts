import assert from "node:assert/strict";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import type { Exec, ExecResult } from "../status/detect.ts";
import { createUpdateApplier } from "./apply.ts";

const from = "a".repeat(40);
const to = "b".repeat(40);
const now = new Date("2026-11-21T00:00:00Z");

async function fixture(
  t: TestContext,
  options: {
    fail?: string;
    dirty?: "before" | "after staging";
    corepack?: boolean;
    operationDuringStage?: boolean;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "harnessd-apply-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const installRoot = join(root, "install");
  const nodeDir = dirname(process.execPath);
  const pnpm = join(nodeDir, "pnpm");
  const calls: string[] = [];
  let head = from;
  let failedOnce = false;
  let staged: string | undefined;
  const exec: Exec = async (cmd, args, opts) => {
    assert.equal(opts?.env?.PATH?.split(delimiter)[0], nodeDir);
    const cwd = opts?.cwd === installRoot ? "install" : "stage";
    const command = [cmd, ...args].join(" ");
    const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
    if (args.includes("status")) {
      const dirty = options.dirty === "before" || (options.dirty === "after staging" && staged);
      return ok(dirty ? " M README.md\n" : "");
    }
    if (args[0] === "merge-base") return ok();
    if (args[0] === "symbolic-ref") return ok("refs/heads/main\n");
    if (args[0] === "rev-parse") {
      if (args.includes("--git-path")) return ok(join(root, args.at(-1) ?? ""));
      return ok(args.at(-1)?.startsWith("HEAD") ? head : to);
    }
    if (args[0] === "worktree" && args[1] === "add") {
      staged = args[3];
      calls.push(`stage ${args[4]}`);
      if (options.operationDuringStage) await writeFile(join(root, "MERGE_HEAD"), to);
      return ok();
    }
    if (args[0] === "worktree" && args[1] === "remove") {
      assert.deepEqual(args, ["worktree", "remove", "--force", staged]);
      calls.push("remove stage");
      return ok();
    }
    const call = `${cwd}: ${command}`;
    calls.push(call);
    if (!failedOnce && call === options.fail) {
      failedOnce = true;
      return {
        code: 1,
        stdout: "build output",
        stderr: Array.from({ length: 21 }, (_, i) => `line ${i + 1}`).join("\n"),
      };
    }
    if (args[0] === "merge") head = to;
    if (args[0] === "reset") head = from;
    return ok();
  };
  const applyUpdate = createUpdateApplier({
    installRoot,
    defaultBranch: "main",
    uid: 501,
    tempDir: root,
    now: () => now,
    exec,
    isExecutable: async (path) => !options.corepack && path === pnpm,
    async writePending(record) {
      assert.deepEqual(record, { from, to, at: now.toISOString() });
      calls.push("write pending");
      if (options.fail === "write pending") throw new Error("Cannot save state.");
    },
  });
  const result = await applyUpdate({ from, to });
  if (staged !== undefined) await assert.rejects(access(dirname(staged)), { code: "ENOENT" });
  return { result, calls, head, pnpm };
}

test("a staged build must pass before the install changes and the service restarts", async (t) => {
  const { result, calls, head, pnpm } = await fixture(t);
  assert.deepEqual(result, { status: "restarted" });
  assert.equal(head, to);
  assert.deepEqual(calls, [
    `stage ${to}`,
    `stage: ${pnpm} install --frozen-lockfile`,
    `stage: ${pnpm} build`,
    "remove stage",
    `install: git merge --ff-only ${to}`,
    `install: ${pnpm} install --frozen-lockfile`,
    `install: ${pnpm} build`,
    "write pending",
    "install: launchctl kickstart -k gui/501/dev.harnessd.daemon",
  ]);
});

for (const [step, args] of [
  ["install", "install --frozen-lockfile"],
  ["build", "build"],
] as const) {
  test(`a failed staged ${step} leaves the install commit in place and removes the worktree`, async (t) => {
    const pnpm = join(dirname(process.execPath), "pnpm");
    const { result, calls, head } = await fixture(t, { fail: `stage: ${pnpm} ${args}` });
    assert.deepEqual(result, {
      status: "failed",
      step,
      error: `${step}: ${Array.from({ length: 20 }, (_, i) => `line ${i + 2}`).join("\n")}`,
    });
    assert.equal(head, from);
    assert.equal(calls.at(-1), "remove stage");
    assert.ok(calls.every((call) => !call.startsWith("install:") && call !== "write pending"));
  });
}

test("a failed in-place build restores and rebuilds the old commit without a restart", async (t) => {
  const pnpm = join(dirname(process.execPath), "pnpm");
  const { result, calls, head } = await fixture(t, { fail: `install: ${pnpm} build` });
  assert.equal(result.status, "failed");
  assert.equal(result.status === "failed" && result.step, "build");
  assert.equal(head, from);
  assert.deepEqual(calls.slice(-3), [
    `install: git reset --hard ${from}`,
    `install: ${pnpm} install --frozen-lockfile`,
    `install: ${pnpm} build`,
  ]);
  assert.ok(calls.every((call) => !call.includes("kickstart") && call !== "write pending"));
});

for (const dirty of ["before", "after staging"] as const) {
  test(`local changes found ${dirty} block any change to the install clone`, async (t) => {
    const { result, calls, head } = await fixture(t, { dirty });
    assert.deepEqual(result, {
      status: "failed",
      step: "pull",
      error: "pull: Local changes in the install clone:\nM README.md",
    });
    assert.equal(head, from);
    assert.ok(calls.every((call) => !call.startsWith("install:") && call !== "write pending"));
    if (dirty === "before") assert.deepEqual(calls, []);
    else assert.equal(calls.at(-1), "remove stage");
  });
}

test("Corepack runs pnpm when PATH has no pnpm executable", async (t) => {
  const { result, calls } = await fixture(t, { corepack: true });
  assert.deepEqual(result, { status: "restarted" });
  const corepack = join(dirname(process.execPath), "corepack");
  assert.ok(calls.includes(`stage: ${corepack} pnpm install --frozen-lockfile`));
  assert.ok(calls.includes(`install: ${corepack} pnpm build`));
});

test("a failed fast-forward does not build in place or restart the service", async (t) => {
  const { result, calls, head } = await fixture(t, { fail: `install: git merge --ff-only ${to}` });
  assert.equal(result.status, "failed");
  assert.equal(result.status === "failed" && result.step, "pull");
  assert.equal(head, from);
  assert.equal(calls.at(-1), `install: git merge --ff-only ${to}`);
});

test("a failed state write restores the old build and prevents a restart", async (t) => {
  const { result, calls, head } = await fixture(t, { fail: "write pending" });
  assert.deepEqual(result, {
    status: "failed",
    step: "restart",
    error: "restart: Cannot save state.",
  });
  assert.equal(head, from);
  assert.ok(calls.includes(`install: git reset --hard ${from}`));
  assert.ok(calls.every((call) => !call.includes("kickstart")));
});

test("a Git operation started during staging blocks the fast-forward", async (t) => {
  const { result, calls, head } = await fixture(t, { operationDuringStage: true });
  assert.deepEqual(result, {
    status: "failed",
    step: "pull",
    error: "pull: A Git operation is in progress in the install clone (MERGE_HEAD).",
  });
  assert.equal(head, from);
  assert.equal(calls.at(-1), "remove stage");
});

test("a failed kickstart reports failure and restores the old build", async (t) => {
  const { result, calls, head } = await fixture(t, {
    fail: "install: launchctl kickstart -k gui/501/dev.harnessd.daemon",
  });
  assert.equal(result.status, "failed");
  assert.equal(result.status === "failed" && result.step, "restart");
  assert.equal(head, from);
  assert.ok(calls.indexOf("write pending") < calls.findIndex((call) => call.includes("kickstart")));
  assert.ok(calls.includes(`install: git reset --hard ${from}`));
});
