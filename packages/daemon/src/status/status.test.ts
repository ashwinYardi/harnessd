import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ExecOptions, ExecResult } from "./detect.ts";
import { type Check, isBlocking, runStatus, type StatusOptions } from "./status.ts";

const roots: string[] = [];
after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

const LINEAR_KEY = "lin_api_SECRETVALUE123456";
const WEBHOOK = "https://hooks.slack.com/services/T000/B000/SECRETHOOK";
const STATES = ["Backlog", "Ready", "In Progress", "In Review", "Done", "Needs input"];

type Reply = ExecResult | (() => Promise<ExecResult>);
const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
const failed = (stderr = "", code = 1): ExecResult => ({ code, stdout: "", stderr });

/** A machine where everything works; each test breaks one part. */
async function world(config = '[linear]\nteam_id = "MET"\n') {
  const root = await mkdtemp(join(tmpdir(), "harnessd-status-"));
  roots.push(root);
  const repoDir = join(root, "repo");
  const globalDir = join(root, "global");
  await mkdir(join(repoDir, ".harnessd"), { recursive: true });
  await mkdir(join(globalDir, "skills", "tdd"), { recursive: true });
  await writeFile(join(globalDir, "skills", "tdd", "SKILL.md"), "# tdd\n");
  await writeFile(join(repoDir, ".harnessd", "config.toml"), config);

  const bins = new Set(["/bin/claude", "/bin/codex", "/bin/gh", "/bin/git"]);
  const replies = new Map<string, Reply>([
    ["/bin/claude --version", ok("2.1.329 (Claude Code)\n")],
    [
      "/bin/claude auth status --json",
      ok(JSON.stringify({ loggedIn: true, authMethod: "oauth_token", email: "me@example.com" })),
    ],
    ["/bin/codex --version", ok("codex-cli 0.60.0\n")],
    ["/bin/codex login status", ok("Logged in using an API key - sk-proj-***SECRET\n")],
    ["/bin/gh --version", ok("gh version 2.89.0 (2026-03-26)\n")],
    ["/bin/gh auth status --active", ok("Logged in to github.com account me (keyring)\n")],
    [
      "/bin/gh repo view --json nameWithOwner,viewerPermission,defaultBranchRef",
      ok(
        JSON.stringify({
          nameWithOwner: "acme/app",
          viewerPermission: "WRITE",
          defaultBranchRef: { name: "main" },
        }),
      ),
    ],
    [
      "/bin/gh api repos/{owner}/{repo}/rules/branches/main",
      ok(
        JSON.stringify([
          { type: "pull_request" },
          {
            type: "required_status_checks",
            parameters: { required_status_checks: [{ context: "ci" }] },
          },
        ]),
      ),
    ],
    ["/bin/git worktree list --porcelain", ok(`worktree ${repoDir}\n`)],
  ]);
  const calls: string[] = [];
  let linear: () => Response | Promise<Response> = () =>
    Response.json({
      data: {
        viewer: { id: "u1" },
        teams: {
          nodes: [{ id: "t1", key: "MET", states: { nodes: STATES.map((name) => ({ name })) } }],
        },
      },
    });
  const linearBodies: unknown[] = [];
  const options: StatusOptions = {
    repoDir,
    globalDir,
    env: { PATH: "/bin", LINEAR_API_KEY: LINEAR_KEY, HARNESSD_SLACK_WEBHOOK_URL: WEBHOOK },
    nodeVersion: "v24.11.0",
    nodePath: "/bin/node",
    isExecutable: async (p) => bins.has(p),
    // Like the real exec: a command still running at timeoutMs is killed with code 124.
    exec: async (cmd: string, args: readonly string[], o?: ExecOptions) => {
      const key = [cmd, ...args].join(" ");
      calls.push(key);
      const reply = replies.get(key);
      if (reply === undefined) return failed(`unexpected call: ${key}`, 127);
      if (typeof reply !== "function") return reply;
      let timer: NodeJS.Timeout | undefined;
      const killed = new Promise<ExecResult>((r) => {
        timer = setTimeout(() => r(failed("killed", 124)), o?.timeoutMs ?? 60_000);
      });
      return Promise.race([reply(), killed]).finally(() => clearTimeout(timer));
    },
    fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
      linearBodies.push(JSON.parse(String(init?.body)));
      return linear();
    }) as typeof fetch,
    portFree: async () => true,
    packSkills: ["tdd"],
    timeoutMs: 2000,
  };
  return {
    root,
    repoDir,
    globalDir,
    bins,
    replies,
    calls,
    linearBodies,
    options,
    setLinear(fn: () => Response | Promise<Response>) {
      linear = fn;
    },
  };
}

function byId(checks: Check[], id: string): Check {
  const c = checks.find((x) => x.id === id);
  assert.ok(c, `no check ${id}; have ${checks.map((x) => x.id).join(", ")}`);
  return c;
}

test("a working machine reports every check ok, with a one-line detail each", async () => {
  const w = await world();
  const checks = await runStatus(w.options);
  assert.deepEqual(
    checks.map((c) => c.id),
    [
      "node",
      "config",
      "harness.claude-code.cli",
      "harness.claude-code.auth",
      "harness.claude-code.version",
      "github.cli",
      "github.auth",
      "github.push",
      "github.ci",
      "linear.key",
      "linear.team",
      "linear.states",
      "slack.webhook",
      "git.worktrees",
      "daemon.port",
      "skills.pack",
    ],
  );
  for (const c of checks) {
    assert.equal(c.state, "ok", `${c.id}: ${c.detail}`);
    assert.doesNotMatch(c.detail, /\n/);
    assert.doesNotMatch(c.fix, /\n/);
  }
  assert.equal(byId(checks, "node").detail, "v24.11.0 (/bin/node)");
  assert.equal(
    byId(checks, "harness.claude-code.cli").detail,
    "2.1.329 (Claude Code) (/bin/claude)",
  );
  assert.equal(byId(checks, "harness.claude-code.auth").detail, "signed in (oauth_token)");
  assert.equal(byId(checks, "github.push").detail, "WRITE on acme/app");
  assert.equal(byId(checks, "github.ci").detail, "main requires: ci");
  assert.equal(byId(checks, "linear.team").detail, "MET");
  assert.equal(byId(checks, "daemon.port").detail, "4747 is free");
  assert.equal(byId(checks, "skills.pack").detail, "1 of 1 skills in place");
});

test("Node older than 24 fails, with the nvm fix", async () => {
  const w = await world();
  const node = byId(await runStatus({ ...w.options, nodeVersion: "v22.3.0" }), "node");
  assert.equal(node.state, "fail");
  assert.match(node.detail, /v22\.3\.0.*needs 24/);
  assert.match(node.fix, /nvm install 24 && nvm alias default 24/);
});

test("a missing harness CLI is missing, and its later checks are not run", async () => {
  const w = await world();
  w.bins.delete("/bin/claude");
  const checks = await runStatus(w.options);
  const cli = byId(checks, "harness.claude-code.cli");
  assert.equal(cli.state, "missing");
  assert.match(cli.fix, /npm i -g @anthropic-ai\/claude-code/);
  assert.equal(byId(checks, "harness.claude-code.auth").state, "missing");
  assert.equal(w.calls.filter((c) => c.startsWith("/bin/claude")).length, 0);
  assert.ok(isBlocking(cli));
});

test("HARNESSD_CLAUDE_BIN picks the Claude Code binary", async () => {
  const w = await world();
  w.bins.add("/opt/claude");
  w.replies.set("/opt/claude --version", ok("2.1.0 (Claude Code)"));
  w.replies.set("/opt/claude auth status --json", ok('{"loggedIn":true,"authMethod":"api_key"}'));
  const checks = await runStatus({
    ...w.options,
    env: { ...w.options.env, HARNESSD_CLAUDE_BIN: "/opt/claude" },
  });
  assert.equal(byId(checks, "harness.claude-code.cli").detail, "2.1.0 (Claude Code) (/opt/claude)");
});

test("Claude Code signed out fails with the login command and no account details", async () => {
  const w = await world();
  w.replies.set("/bin/claude auth status --json", {
    code: 1,
    stdout: '{"loggedIn":false,"email":"me@example.com"}',
    stderr: "",
  });
  const checks = await runStatus(w.options);
  const auth = byId(checks, "harness.claude-code.auth");
  assert.equal(auth.state, "fail");
  assert.equal(auth.detail, "not signed in");
  assert.match(auth.fix, /claude auth login/);
  assert.doesNotMatch(JSON.stringify(checks), /me@example\.com/);
});

test("unreadable Claude Code sign-in status is a warning", async () => {
  const w = await world();
  w.replies.set("/bin/claude auth status --json", failed("error: unknown command 'auth'"));
  const auth = byId(await runStatus(w.options), "harness.claude-code.auth");
  assert.equal(auth.state, "warn");
  assert.match(auth.fix, /npm i -g @anthropic-ai\/claude-code/);
});

test("a known-bad harness version is a warning with the reason", async () => {
  const w = await world();
  const checks = await runStatus({
    ...w.options,
    knownBadVersions: [
      { harness: "claude-code", below: "2.2.0", reason: "drops stream-json events" },
    ],
  });
  const v = byId(checks, "harness.claude-code.version");
  assert.equal(v.state, "warn");
  assert.match(v.detail, /2\.1\.329 is known bad: drops stream-json events/);
  assert.match(v.fix, /npm i -g @anthropic-ai\/claude-code@latest/);
});

test("Codex is checked only when an agent uses it, through `codex login status`", async () => {
  const w = await world('[linear]\nteam_id = "MET"\n\n[agents.qa]\nharness = "codex"\n');
  const checks = await runStatus(w.options);
  assert.equal(byId(checks, "harness.codex.cli").detail, "codex-cli 0.60.0 (/bin/codex)");
  assert.equal(byId(checks, "harness.codex.auth").state, "ok");
  assert.doesNotMatch(JSON.stringify(checks), /sk-proj/);

  w.replies.set("/bin/codex login status", failed("Not logged in"));
  const auth = byId(await runStatus(w.options), "harness.codex.auth");
  assert.equal(auth.state, "fail");
  assert.match(auth.fix, /codex login/);
});

test("GitHub: signed out, read-only access and no required checks", async () => {
  const w = await world();
  w.replies.set(
    "/bin/gh auth status --active",
    failed("You are not logged into any GitHub hosts."),
  );
  let checks = await runStatus(w.options);
  assert.equal(byId(checks, "github.auth").state, "fail");
  assert.match(byId(checks, "github.auth").fix, /gh auth login/);
  assert.equal(byId(checks, "github.push").state, "missing");

  const w2 = await world();
  w2.replies.set(
    "/bin/gh repo view --json nameWithOwner,viewerPermission,defaultBranchRef",
    ok('{"nameWithOwner":"acme/app","viewerPermission":"READ","defaultBranchRef":{"name":"main"}}'),
  );
  w2.replies.set("/bin/gh api repos/{owner}/{repo}/rules/branches/main", ok("[]"));
  checks = await runStatus(w2.options);
  assert.equal(byId(checks, "github.push").state, "fail");
  assert.match(byId(checks, "github.push").detail, /READ on acme\/app/);
  assert.equal(byId(checks, "github.ci").state, "warn");
  assert.match(byId(checks, "github.ci").detail, /no required checks on main/);
});

test("GitHub: no gh and no GitHub remote", async () => {
  const w = await world();
  w.bins.delete("/bin/gh");
  let checks = await runStatus(w.options);
  assert.equal(byId(checks, "github.cli").state, "missing");
  assert.match(byId(checks, "github.cli").fix, /brew install gh/);

  const w2 = await world();
  w2.replies.set(
    "/bin/gh repo view --json nameWithOwner,viewerPermission,defaultBranchRef",
    failed("no git remotes found"),
  );
  checks = await runStatus(w2.options);
  assert.equal(byId(checks, "github.push").state, "fail");
  assert.match(byId(checks, "github.push").detail, /no git remotes found/);
});

test("Linear: no key is missing, and the team and states are not checked", async () => {
  const w = await world();
  const checks = await runStatus({ ...w.options, env: { PATH: "/bin" } });
  assert.equal(byId(checks, "linear.key").state, "missing");
  assert.match(byId(checks, "linear.key").fix, /export LINEAR_API_KEY=lin_api_/);
  assert.equal(byId(checks, "linear.team").state, "missing");
  assert.equal(w.linearBodies.length, 0);
});

test("Linear: a rejected key fails without echoing it", async () => {
  const w = await world();
  w.setLinear(() =>
    Response.json(
      {
        errors: [
          { message: `bad key ${LINEAR_KEY}`, extensions: { code: "AUTHENTICATION_ERROR" } },
        ],
      },
      { status: 401 },
    ),
  );
  const checks = await runStatus(w.options);
  assert.equal(byId(checks, "linear.key").state, "fail");
  assert.match(byId(checks, "linear.key").detail, /rejected/);
  assert.doesNotMatch(JSON.stringify(checks), /SECRETVALUE/);
});

test("Linear: the team is looked up by key, and missing states are named", async () => {
  const w = await world();
  w.setLinear(() =>
    Response.json({
      data: {
        viewer: { id: "u1" },
        teams: {
          nodes: [
            { id: "t1", key: "MET", states: { nodes: [{ name: "ready" }, { name: "Done" }] } },
          ],
        },
      },
    }),
  );
  const checks = await runStatus(w.options);
  const body = w.linearBodies[0] as { variables: unknown };
  assert.deepEqual(body.variables, { filter: { key: { eqIgnoreCase: "MET" } } });
  const states = byId(checks, "linear.states");
  assert.equal(states.state, "fail");
  assert.equal(states.detail, "missing: In Progress, In Review, Needs input");
});

test("Linear: an unknown team fails, and an unset team_id is missing", async () => {
  const w = await world();
  w.setLinear(() => Response.json({ data: { viewer: { id: "u1" }, teams: { nodes: [] } } }));
  let checks = await runStatus(w.options);
  assert.equal(byId(checks, "linear.key").state, "ok");
  assert.equal(byId(checks, "linear.team").state, "fail");
  assert.match(byId(checks, "linear.team").detail, /no team MET/);

  const w2 = await world("");
  w2.setLinear(() => Response.json({ data: { viewer: { id: "u1" } } }));
  checks = await runStatus(w2.options);
  assert.equal(byId(checks, "linear.key").state, "ok");
  assert.equal(byId(checks, "linear.team").state, "missing");
  assert.match(byId(checks, "linear.team").fix, /team_id = "MET"/);
});

test("Slack: an unset webhook is only a warning; a set one never shows its value", async () => {
  const w = await world();
  let checks = await runStatus(w.options);
  assert.equal(byId(checks, "slack.webhook").state, "ok");
  assert.doesNotMatch(JSON.stringify(checks), /SECRETHOOK/);
  checks = await runStatus({ ...w.options, env: { PATH: "/bin", LINEAR_API_KEY: LINEAR_KEY } });
  assert.equal(byId(checks, "slack.webhook").state, "warn");
  assert.ok(!isBlocking(byId(checks, "slack.webhook")));
});

test("git worktrees, the port and the skill pack", async () => {
  const w = await world();
  w.replies.set("/bin/git worktree list --porcelain", failed("fatal: not a git repository"));
  await rm(join(w.globalDir, "skills"), { recursive: true });
  let checks = await runStatus({ ...w.options, portFree: async () => false });
  assert.equal(byId(checks, "git.worktrees").state, "fail");
  assert.match(byId(checks, "git.worktrees").detail, /not a git repository/);
  assert.equal(byId(checks, "daemon.port").state, "fail");
  assert.match(byId(checks, "daemon.port").fix, /daemon\.port/);
  assert.equal(byId(checks, "skills.pack").state, "warn");
  assert.match(byId(checks, "skills.pack").fix, /harnessd init/);

  checks = await runStatus({ ...w.options, portFree: async () => false, servingPort: true });
  assert.equal(byId(checks, "daemon.port").state, "ok");
  assert.equal(byId(checks, "daemon.port").detail, "4747 is served by this daemon");
});

test("the default port check sees a port in use", async () => {
  const w = await world();
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  try {
    await writeFile(
      join(w.repoDir, ".harnessd", "config.toml"),
      `[linear]\nteam_id = "MET"\n\n[daemon]\nport = ${port}\n`,
    );
    const { portFree: _drop, ...rest } = w.options;
    const check = byId(await runStatus(rest), "daemon.port");
    assert.equal(check.state, "fail");
    assert.equal(check.detail, `${port} is in use`);
  } finally {
    server.close();
  }
});

test("a config error fails the config check; the rest still run on defaults", async () => {
  const w = await world('[limits]\nmax_concurrent = "three"\n');
  const checks = await runStatus(w.options);
  assert.equal(byId(checks, "config").state, "fail");
  assert.match(byId(checks, "config").detail, /max_concurrent/);
  assert.equal(byId(checks, "harness.claude-code.cli").state, "ok");
});

test("checks run in parallel, and a hung one fails at its timeout", async () => {
  const w = await world();
  const hang = () => new Promise<ExecResult>(() => undefined);
  w.replies.set("/bin/claude auth status --json", hang);
  w.replies.set("/bin/gh auth status --active", hang);
  w.setLinear(() => new Promise<Response>(() => undefined));
  const started = Date.now();
  const checks = await runStatus({ ...w.options, timeoutMs: 200 });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 600, `took ${elapsed} ms`);
  assert.equal(byId(checks, "harness.claude-code.auth").state, "fail");
  assert.match(byId(checks, "harness.claude-code.auth").detail, /timed out after 0\.2 s/);
  assert.equal(byId(checks, "github.auth").state, "fail");
  assert.equal(byId(checks, "linear.key").state, "fail");
  assert.equal(byId(checks, "node").state, "ok");
});

test("no secret from the environment appears in any check", async () => {
  const w = await world();
  const token = "ghp_TOKENVALUE987654321";
  w.replies.set("/bin/gh auth status --active", failed(`token ${token} is invalid`));
  w.replies.set("/bin/git worktree list --porcelain", failed(`fatal: ${LINEAR_KEY}`));
  const checks = await runStatus({ ...w.options, env: { ...w.options.env, GH_TOKEN: token } });
  const text = JSON.stringify(checks);
  assert.doesNotMatch(text, /TOKENVALUE|SECRETVALUE|SECRETHOOK/);
  assert.match(byId(checks, "git.worktrees").detail, /\*\*\*/);
});

test("a bad HARNESSD_GH_BIN is named in the detail", async () => {
  const w = await world();
  const checks = await runStatus({
    ...w.options,
    env: { ...w.options.env, HARNESSD_GH_BIN: "/opt/gh" },
  });
  assert.equal(byId(checks, "github.cli").detail, "/opt/gh (HARNESSD_GH_BIN) is not executable");
});

test("classic branch protection adds its required checks", async () => {
  const w = await world();
  w.replies.set("/bin/gh api repos/{owner}/{repo}/rules/branches/main", ok("[]"));
  w.replies.set(
    "/bin/gh api repos/{owner}/{repo}/branches/main/protection/required_status_checks",
    ok('{"strict":true,"contexts":["lint","test"]}'),
  );
  assert.equal(byId(await runStatus(w.options), "github.ci").detail, "main requires: lint, test");
});

test("a slow call times out only its own check; finished checks stay ok", async () => {
  const w = await world();
  w.replies.set(
    "/bin/gh auth status --active",
    () => new Promise((r) => setTimeout(() => r(ok()), 400)),
  );
  const checks = await runStatus({ ...w.options, timeoutMs: 200 });
  assert.equal(byId(checks, "github.cli").state, "ok");
  assert.equal(byId(checks, "github.auth").detail, "timed out after 0.2 s");
  assert.equal(byId(checks, "github.push").state, "missing");
});

test("a port held by a running harnessd is a warning, not a fail", async () => {
  const w = await world();
  const fetchHealth = (async (url: string | URL | Request) =>
    String(url).endsWith("/health")
      ? Response.json({ ok: true, version: "0.0.0" })
      : (w.options.fetch as typeof fetch)(url)) as typeof fetch;
  const check = byId(
    await runStatus({ ...w.options, portFree: async () => false, fetch: fetchHealth }),
    "daemon.port",
  );
  assert.equal(check.state, "warn");
  assert.equal(check.detail, "4747 is in use by a running harnessd");
});

test("[harnesses.<id>] bin in the config picks the binary, before the env override", async () => {
  const w = await world('[linear]\nteam_id = "MET"\n');
  await writeFile(
    join(w.globalDir, "config.toml"),
    '[harnesses.claude-code]\nbin = "/opt/claude"\n',
  );
  w.bins.add("/opt/claude");
  w.replies.set("/opt/claude --version", ok("2.1.0 (Claude Code)"));
  w.replies.set("/opt/claude auth status --json", ok('{"loggedIn":true}'));
  const checks = await runStatus({
    ...w.options,
    env: { ...w.options.env, HARNESSD_CLAUDE_BIN: "/bin/claude" },
  });
  assert.equal(byId(checks, "harness.claude-code.cli").detail, "2.1.0 (Claude Code) (/opt/claude)");

  await writeFile(join(w.globalDir, "config.toml"), '[harnesses.claude-code]\nbin = "/opt/none"\n');
  const missing = byId(await runStatus(w.options), "harness.claude-code.cli");
  assert.equal(missing.state, "missing");
  assert.equal(missing.detail, "/opt/none (harnesses.claude-code.bin) is not executable");
});

test("harnessesOnly runs just those harness checks, used by an agent or not", async () => {
  const w = await world();
  const checks = await runStatus({ ...w.options, harnessesOnly: ["claude-code", "codex"] });
  assert.deepEqual(
    checks.map((c) => c.id),
    [
      "harness.claude-code.cli",
      "harness.claude-code.auth",
      "harness.claude-code.version",
      "harness.codex.cli",
      "harness.codex.auth",
      "harness.codex.version",
    ],
  );
  assert.ok(!w.calls.some((c) => c.startsWith("/bin/gh")), "no GitHub call");
});
