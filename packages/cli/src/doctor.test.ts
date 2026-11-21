import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { type Check, runStatus, type StatusOptions } from "@harnessd/daemon";
import { formatChecks, refusalLines, runDoctor } from "./doctor.ts";
import { run } from "./index.ts";

const roots: string[] = [];
after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

const KEY = "lin_api_DOCTORSECRET0001";

/** A fake CLI: prints `stdout` for the argv it knows, exits `code`. */
function script(cases: Record<string, { out?: string; code?: number }>): string {
  const lines = ["#!/bin/sh", 'case "$*" in'];
  for (const [argv, r] of Object.entries(cases)) {
    lines.push(`  "${argv}") printf '%s\\n' '${r.out ?? ""}'; exit ${r.code ?? 0} ;;`);
  }
  lines.push('  *) echo "fake: unknown $*" >&2; exit 64 ;;', "esac", "");
  return lines.join("\n");
}

async function machine(opts: { claudeSignedIn?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "harnessd-doctor-"));
  roots.push(root);
  const bin = join(root, "bin");
  const repo = join(root, "repo");
  const home = join(root, "global");
  await mkdir(bin);
  await mkdir(join(repo, ".harnessd"), { recursive: true });
  await mkdir(home);
  await writeFile(join(repo, ".harnessd", "config.toml"), '[linear]\nteam_id = "MET"\n');
  const signedIn = opts.claudeSignedIn ?? true;
  const fakes: Record<string, string> = {
    claude: script({
      "--version": { out: "2.1.329 (Claude Code)" },
      "auth status --json": {
        out: `{"loggedIn":${signedIn},"authMethod":"oauth_token"}`,
        code: signedIn ? 0 : 1,
      },
    }),
    gh: script({
      "--version": { out: "gh version 2.89.0" },
      "auth status --active": { out: "Logged in to github.com" },
      "repo view --json nameWithOwner,viewerPermission,defaultBranchRef": {
        out: '{"nameWithOwner":"acme/app","viewerPermission":"ADMIN","defaultBranchRef":{"name":"main"}}',
      },
      "api repos/{owner}/{repo}/rules/branches/main": {
        out: '[{"type":"required_status_checks","parameters":{"required_status_checks":[{"context":"ci"}]}}]',
      },
    }),
    git: script({ "worktree list --porcelain": { out: `worktree ${repo}` } }),
  };
  for (const [name, text] of Object.entries(fakes)) {
    await writeFile(join(bin, name), text);
    await chmod(join(bin, name), 0o755);
  }
  const fakeFetch = (async () =>
    Response.json({
      data: {
        viewer: { id: "u1" },
        teams: {
          nodes: [
            {
              id: "t1",
              key: "MET",
              states: {
                nodes: ["Ready", "In Progress", "In Review", "Done", "Needs input"].map((name) => ({
                  name,
                })),
              },
            },
          ],
        },
      },
    })) as unknown as typeof fetch;
  const out: string[] = [];
  const err: string[] = [];
  const io = {
    out: (l: string) => out.push(l),
    err: (l: string) => err.push(l),
    cwd: repo,
    env: { PATH: bin, HARNESSD_HOME: home, LINEAR_API_KEY: KEY },
    checks: (o: StatusOptions) =>
      runStatus({
        ...o,
        fetch: fakeFetch,
        nodeVersion: "v24.11.0",
        nodePath: "/usr/local/bin/node",
        portFree: async () => true,
      }),
  };
  return { out, err, io, repo };
}

test("doctor runs fake CLIs and prints one dense row per check", async () => {
  const m = await machine();
  const code = await run(["doctor"], m.io);
  const text = m.out.join("\n");
  assert.match(m.out[0] ?? "", /^STATE {3}CHECK +DETAIL +FIX$/);
  assert.match(text, /^ok {6}harness\.claude-code\.auth +signed in \(oauth_token\)$/m);
  assert.match(text, /^ok {6}github\.push +ADMIN on acme\/app$/m);
  assert.match(text, /^ok {6}linear\.states +Ready, In Progress, In Review, Done, Needs input$/m);
  // No Slack webhook and no skill pack here: warnings only, so doctor still passes.
  assert.match(
    text,
    /^warn {4}slack\.webhook +no webhook is saved and HARNESSD_SLACK_WEBHOOK_URL is not set.* {2}Create a Slack/m,
  );
  assert.match(text, /^\d+ checks: \d+ ok, 2 warn, 0 fail, 0 missing$/m);
  assert.equal(code, 0, text);
  assert.doesNotMatch(text, /DOCTORSECRET/);
});

test("doctor exits 1 on a fail and names the fix", async () => {
  const m = await machine({ claudeSignedIn: false });
  assert.equal(await run(["doctor"], m.io), 1);
  const text = m.out.join("\n");
  assert.match(
    text,
    /^fail {4}harness\.claude-code\.auth +not signed in +Run: claude auth login$/m,
  );
  assert.match(text, /harnessd run will not start/);
});

test("doctor --json prints the checks; bad arguments are a usage error", async () => {
  const m = await machine();
  assert.equal(await run(["doctor", "--json"], m.io), 0);
  const parsed = JSON.parse(m.out.join("\n")) as { checks: Check[] };
  assert.ok(parsed.checks.some((c) => c.id === "linear.key" && c.state === "ok"));
  assert.equal(await runDoctor(["--bogus"], m.io), 2);
  assert.match(m.err.join("\n"), /Usage: harnessd doctor/);
});

test("formatChecks pads columns and counts each state", () => {
  const lines = formatChecks([
    { id: "node", state: "ok", detail: "v24.11.0", fix: "" },
    { id: "linear.key", state: "missing", detail: "LINEAR_API_KEY is not set", fix: "export it" },
  ]);
  assert.deepEqual(lines, [
    "STATE   CHECK       DETAIL                     FIX",
    "ok      node        v24.11.0",
    "missing linear.key  LINEAR_API_KEY is not set  export it",
    "",
    "2 checks: 1 ok, 0 warn, 0 fail, 1 missing",
  ]);
  assert.deepEqual(
    refusalLines([
      { id: "node", state: "ok", detail: "v24", fix: "" },
      { id: "github.auth", state: "fail", detail: "not signed in", fix: "Run: gh auth login" },
    ]),
    [
      'harnessd run: 1 check failed; not starting. Run "harnessd doctor" for the full list.',
      "  github.auth (fail): not signed in. Fix: Run: gh auth login",
    ],
  );
});

test("doctor checks the worktree write afresh, so a root that became unwritable fails", async () => {
  const m = await machine();
  const home = String(m.io.env.HARNESSD_HOME);
  const root = join(home, "worktrees");
  assert.equal(await run(["doctor"], m.io), 0, m.out.join("\n"));
  assert.match(m.out.join("\n"), /^ok {6}harness\.claude-code\.worktree_write /m);

  await chmod(root, 0o555);
  try {
    assert.equal(await run(["doctor"], m.io), 1);
    assert.match(
      m.out.join("\n"),
      /^fail {4}harness\.claude-code\.worktree_write .*permission denied/m,
    );
    assert.match(m.out.join("\n"), new RegExp(`Make ${root} writable`));
  } finally {
    await chmod(root, 0o755);
  }
});
