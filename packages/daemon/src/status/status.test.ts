import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createSecretStore } from "../secrets/store.ts";
import type { ExecOptions, ExecResult } from "./detect.ts";
import {
  type Check,
  CODEX_MIN_VERSION,
  isBlocking,
  locateHarness,
  runStatus,
  type StatusOptions,
} from "./status.ts";
import { codexSandboxMode, WORKTREE_WRITE_CACHE_MS, worktreeWriteCheck } from "./worktree-write.ts";

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
    ["/bin/codex --version", ok("codex-cli 0.171.0\n")],
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
      "harness.claude-code.worktree_write",
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
  assert.equal(
    byId(checks, "harness.claude-code.worktree_write").detail,
    `wrote and deleted a file in ${join(w.globalDir, "worktrees")}`,
  );
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

/** A launchd plist like the one `harnessd init` writes. */
function plist(harnessd: string, path: string): string {
  return [
    "<plist><dict>",
    "<key>Label</key><string>dev.harnessd.daemon</string>",
    "<key>ProgramArguments</key>",
    `<array><string>${harnessd}</string><string>run</string></array>`,
    "<key>EnvironmentVariables</key>",
    `<dict><key>PATH</key><string>${path}</string></dict>`,
    "</dict></plist>",
  ].join("\n");
}

/** A world on macOS whose service runs the harnessd command at `harnessd`. */
async function serviceWorld(harnessd: string, wrapper?: string, path = "/svc/bin:/usr/bin") {
  const w = await world();
  const servicePlist = join(w.root, "dev.harnessd.daemon.plist");
  await writeFile(servicePlist, plist(harnessd, path));
  if (wrapper !== undefined) await writeFile(harnessd, wrapper);
  return { ...w, options: { ...w.options, platform: "darwin" as const, servicePlist } };
}

test("the node check is unchanged when there is no service plist", async () => {
  const w = await world();
  const options = { ...w.options, platform: "darwin" as const, servicePlist: join(w.root, "none") };
  const node = byId(await runStatus(options), "node");
  assert.deepEqual(node, { id: "node", state: "ok", detail: "v24.11.0 (/bin/node)", fix: "" });
});

test("the node check is unchanged when the wrapper runs the same Node", async () => {
  const w0 = await world();
  const w = await serviceWorld(
    join(w0.root, "harnessd"),
    '#!/bin/sh\nexec "/bin/node" "/src/packages/cli/dist/bin.js" "$@"\n',
  );
  const node = byId(await runStatus(w.options), "node");
  assert.deepEqual(node, { id: "node", state: "ok", detail: "v24.11.0 (/bin/node)", fix: "" });
  assert.ok(!w.calls.some((c) => c.startsWith("/bin/node")));
});

test("a wrapper with another Node 24 is ok, and the detail names that Node", async () => {
  const w0 = await world();
  const w = await serviceWorld(
    join(w0.root, "harnessd"),
    '#!/bin/sh\nexec /opt/node24/bin/node /src/packages/cli/dist/bin.js "$@"\n',
  );
  w.bins.add("/opt/node24/bin/node");
  w.replies.set("/opt/node24/bin/node --version", ok("v24.2.0\n"));
  const node = byId(await runStatus(w.options), "node");
  assert.equal(node.state, "ok");
  assert.equal(
    node.detail,
    "v24.11.0 (/bin/node); the service uses v24.2.0 (/opt/node24/bin/node)",
  );
  assert.equal(node.fix, "");
});

test("a wrapper with a Node older than 24 fails, with the Install block fix", async () => {
  const w0 = await world();
  const w = await serviceWorld(
    join(w0.root, "harnessd"),
    "#!/bin/sh\nexec '/nvm/v22/bin/node' /src/packages/cli/dist/bin.js \"$@\"\n",
  );
  w.bins.add("/nvm/v22/bin/node");
  w.replies.set("/nvm/v22/bin/node --version", ok("v22.3.0\n"));
  const node = byId(await runStatus(w.options), "node");
  assert.equal(node.state, "fail");
  assert.equal(
    node.detail,
    "v24.11.0 (/bin/node); the service uses v22.3.0 (/nvm/v22/bin/node); harnessd needs 24 or newer",
  );
  assert.equal(node.fix, "Run the Install block with Node 24 active, then harnessd init.");
});

test("a harnessd that is not a wrapper uses the node on the service PATH", async () => {
  const w0 = await world();
  const w = await serviceWorld(
    join(w0.root, "bin.js"),
    "#!/usr/bin/env node\nimport './cli.js';\n",
    "/svc/bin:/usr/bin",
  );
  w.bins.add("/svc/bin/node");
  w.replies.set("/svc/bin/node --version", ok("v25.0.0\n"));
  const node = byId(await runStatus(w.options), "node");
  assert.equal(node.state, "ok");
  assert.equal(node.detail, "v24.11.0 (/bin/node); the service uses v25.0.0 (/svc/bin/node)");
});

test("a service Node that cannot be found fails, with the Install block fix", async () => {
  const w0 = await world();
  const w = await serviceWorld(join(w0.root, "bin.js"), "#!/usr/bin/env node\n", "/svc/bin");
  const node = byId(await runStatus(w.options), "node");
  assert.equal(node.state, "fail");
  assert.equal(node.detail, "v24.11.0 (/bin/node); the service Node is not on its PATH");
  assert.equal(node.fix, "Run the Install block with Node 24 active, then harnessd init.");
});

test("the service Node is not checked outside macOS", async () => {
  const w0 = await world();
  const w = await serviceWorld(join(w0.root, "bin.js"), "#!/usr/bin/env node\n", "/svc/bin");
  const node = byId(await runStatus({ ...w.options, platform: "linux" }), "node");
  assert.deepEqual(node, { id: "node", state: "ok", detail: "v24.11.0 (/bin/node)", fix: "" });
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
  assert.equal(byId(checks, "harness.codex.cli").detail, "codex-cli 0.171.0 (/bin/codex)");
  assert.equal(byId(checks, "harness.codex.auth").state, "ok");
  assert.doesNotMatch(JSON.stringify(checks), /sk-proj/);

  w.replies.set("/bin/codex login status", failed("Not logged in"));
  const auth = byId(await runStatus(w.options), "harness.codex.auth");
  assert.equal(auth.state, "fail");
  assert.match(auth.fix, /codex login/);
});

test("Codex below the minimum version is a warning that names both versions", async () => {
  assert.equal(CODEX_MIN_VERSION, "0.171.0");
  const w = await world('[linear]\nteam_id = "MET"\n\n[agents.backend]\nharness = "codex"\n');
  w.replies.set("/bin/codex --version", ok("codex-cli 0.170.9\n"));
  const checks = await runStatus(w.options);
  const v = byId(checks, "harness.codex.version");
  assert.equal(v.state, "warn");
  assert.equal(v.detail, "0.170.9 is below the minimum 0.171.0");
  assert.equal(v.fix, "Run npm install -g @openai/codex@latest.");
  assert.ok(!isBlocking(v), "a version warning never blocks");
});

test("Codex at or above the minimum version is ok", async () => {
  for (const found of ["0.171.0", "0.171.1", "0.200.0", "1.0.0"]) {
    const w = await world('[linear]\nteam_id = "MET"\n\n[agents.backend]\nharness = "codex"\n');
    w.replies.set("/bin/codex --version", ok(`codex-cli ${found}\n`));
    const v = byId(await runStatus(w.options), "harness.codex.version");
    assert.equal(v.state, "ok", found);
    assert.equal(v.fix, "", found);
  }
});

test("an unparseable Codex version is a warning that names the minimum", async () => {
  const w = await world('[linear]\nteam_id = "MET"\n\n[agents.backend]\nharness = "codex"\n');
  w.replies.set("/bin/codex --version", ok("codex-cli dev\n"));
  const checks = await runStatus(w.options);
  const v = byId(checks, "harness.codex.version");
  assert.equal(v.state, "warn");
  assert.equal(v.detail, "version unknown; the minimum is 0.171.0");
  assert.equal(v.fix, "Run npm install -g @openai/codex@latest.");
  assert.ok(!isBlocking(v));
});

const OPENCODE_AGENT =
  '[linear]\nteam_id = "MET"\n\n[agents.backend]\nharness = "opencode"\nmodel = "deepseek/deepseek-chat"\n';
const OPENCODE_AUTH = "/bin/opencode auth list --format json --standalone";
const signedIn = (...ids: string[]) =>
  ok(
    JSON.stringify(
      ids.map((id) => ({
        id,
        name: id,
        connections: [{ type: "credential", id: "c1", label: "SECRET-LABEL", method: "key" }],
      })),
    ),
  );

async function opencodeWorld(config = OPENCODE_AGENT) {
  const w = await world(config);
  w.bins.add("/bin/opencode");
  w.replies.set("/bin/opencode --version", ok("opencode v2.0.20\n"));
  w.replies.set(OPENCODE_AUTH, signedIn("deepseek", "opencode"));
  return w;
}

test("OpenCode is checked only when an agent uses it: CLI, version and the signed-in providers", async () => {
  const none = await opencodeWorld('[linear]\nteam_id = "MET"\n');
  assert.ok(!(await runStatus(none.options)).some((c) => c.id.startsWith("harness.opencode.")));

  const w = await opencodeWorld();
  const checks = await runStatus(w.options);
  assert.equal(byId(checks, "harness.opencode.cli").detail, "opencode v2.0.20 (/bin/opencode)");
  assert.deepEqual(byId(checks, "harness.opencode.version"), {
    id: "harness.opencode.version",
    state: "ok",
    detail: "2.0.20 has no known problems",
    fix: "",
  });
  assert.deepEqual(byId(checks, "harness.opencode.auth"), {
    id: "harness.opencode.auth",
    state: "ok",
    detail: "signed in: deepseek",
    fix: "",
  });
  assert.ok(w.calls.includes(OPENCODE_AUTH));
  assert.doesNotMatch(JSON.stringify(checks), /SECRET-LABEL|"key"/);
});

test("a missing OpenCode CLI names [harnesses.opencode] bin and ~/.opencode/bin", async () => {
  const w = await opencodeWorld();
  w.bins.delete("/bin/opencode");
  const checks = await runStatus(w.options);
  const cli = byId(checks, "harness.opencode.cli");
  assert.equal(cli.state, "missing");
  assert.equal(cli.detail, "opencode is not on PATH");
  assert.match(cli.fix, /curl -fsSL https:\/\/opencode\.ai\/install \| bash/);
  assert.match(cli.fix, /~\/\.opencode\/bin/);
  assert.match(cli.fix, /\[harnesses\.opencode\] bin/);
  assert.equal(byId(checks, "harness.opencode.auth").detail, "not checked");
});

test("OpenCode below 2.0.20, or with an unreadable version, warns with `opencode upgrade`", async () => {
  const w = await opencodeWorld();
  w.replies.set("/bin/opencode --version", ok("opencode v2.0.19\n"));
  const old = byId(await runStatus(w.options), "harness.opencode.version");
  assert.deepEqual(
    [old.state, old.detail, old.fix],
    ["warn", "2.0.19 is below the minimum 2.0.20", "Run: opencode upgrade"],
  );
  assert.ok(!isBlocking(old));
  w.replies.set("/bin/opencode --version", failed("crash"));
  const unknown = byId(await runStatus(w.options), "harness.opencode.version");
  assert.deepEqual(
    [unknown.state, unknown.detail],
    ["warn", "version unknown; the minimum is 2.0.20"],
  );
});

test("OpenCode auth fails and names each provider an agent uses that is not signed in", async () => {
  const w = await opencodeWorld(
    `${OPENCODE_AGENT}\n[agents.qa]\nrole = "qa"\nharness = "claude-code"\nfallback_harness = "opencode"\nfallback_model = "kimi/kimi-k2"\n`,
  );
  w.replies.set(OPENCODE_AUTH, signedIn("opencode"));
  const auth = byId(await runStatus(w.options), "harness.opencode.auth");
  assert.equal(auth.state, "fail");
  assert.equal(auth.detail, "not signed in: deepseek, kimi");
  assert.match(auth.fix, /opencode auth login deepseek/);
  assert.ok(isBlocking(auth));
});

test("OpenCode auth warns when no agent names a provider and none is signed in", async () => {
  const w = await opencodeWorld(
    '[linear]\nteam_id = "MET"\n\n[agents.backend]\nharness = "opencode"\n',
  );
  w.replies.set(OPENCODE_AUTH, ok("[]"));
  const auth = byId(await runStatus(w.options), "harness.opencode.auth");
  assert.equal(auth.state, "warn");
  assert.equal(auth.detail, "no provider is signed in, and no opencode agent names one");

  w.replies.set(OPENCODE_AUTH, signedIn("opencode"));
  assert.equal(byId(await runStatus(w.options), "harness.opencode.auth").state, "ok");

  w.replies.set(OPENCODE_AUTH, ok("not json"));
  const unread = byId(await runStatus(w.options), "harness.opencode.auth");
  assert.deepEqual(
    [unread.state, unread.detail],
    ["warn", "could not read the signed-in providers"],
  );
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
  assert.equal(byId(checks, "linear.key").detail, "no key is saved and LINEAR_API_KEY is not set");
  assert.equal(
    byId(checks, "linear.key").fix,
    "Paste a Linear personal API key in Settings, Connections, Linear.",
  );
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

test("skills.pack warns when a skill's hook is missing from .claude/settings.json", async () => {
  const w = await world();
  const native = join(w.options.globalDir, "skills", "tdd", ".harnessd-native");
  await mkdir(native, { recursive: true });
  const group = { matcher: "Edit|Write", hooks: [{ type: "command", command: "scan hook" }] };
  await writeFile(join(native, "hooks.json"), JSON.stringify({ claude: { PostToolUse: [group] } }));

  let check = byId(await runStatus(w.options), "skills.pack");
  assert.equal(check.state, "warn");
  assert.equal(check.detail, "1 of 1 skills in place; tdd hook missing from .claude/settings.json");
  assert.equal(check.fix, "Run: harnessd sync");

  await mkdir(join(w.repoDir, ".claude"), { recursive: true });
  await writeFile(
    join(w.repoDir, ".claude", "settings.json"),
    JSON.stringify({ hooks: { PostToolUse: [group] } }),
  );
  check = byId(await runStatus(w.options), "skills.pack");
  assert.equal(check.state, "ok", check.detail);

  // A workspace that turns the skill off expects no hook.
  await writeFile(join(w.repoDir, ".claude", "settings.json"), "{}");
  await writeFile(
    join(w.repoDir, ".harnessd", "config.toml"),
    '[linear]\nteam_id = "MET"\n\n[skills.tdd]\nenabled = false\n',
  );
  check = byId(await runStatus(w.options), "skills.pack");
  assert.equal(check.state, "ok", check.detail);
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
      "harness.claude-code.worktree_write",
      "harness.codex.cli",
      "harness.codex.auth",
      "harness.codex.version",
      "harness.codex.worktree_write",
    ],
  );
  assert.ok(!w.calls.some((c) => c.startsWith("/bin/gh")), "no GitHub call");
});

test("Linear and Slack read through the secret store and name the source, never the value", async () => {
  const w = await world();
  const saved = "lin_api_SAVEDVALUE123456";
  const hook = "https://hooks.slack.com/services/T1/B1/SAVEDHOOK99";
  const store = createSecretStore({ globalDir: w.globalDir, env: w.options.env });
  await store.save("linear.api_key", saved);
  await store.save("slack.webhook_url", hook);
  w.replies.set("/bin/git worktree list --porcelain", failed(`fatal: ${saved} ${hook}`));
  const checks = await runStatus(w.options);
  assert.deepEqual(byId(checks, "linear.key"), {
    id: "linear.key",
    state: "ok",
    detail: "accepted (saved)",
    fix: "",
  });
  assert.equal(byId(checks, "slack.webhook").detail, "set (saved)");
  const text = JSON.stringify(checks);
  assert.doesNotMatch(text, /SAVEDVALUE|SAVEDHOOK/);

  // The env source is named too.
  const w2 = await world();
  const env = await runStatus(w2.options);
  assert.equal(byId(env, "linear.key").detail, "accepted (env)");
  assert.equal(byId(env, "slack.webhook").detail, "set (env)");
});

test("a reference that cannot be read fails linear.key with the reason, and warns for Slack", async () => {
  const w = await world();
  await writeFile(
    join(w.globalDir, "config.toml"),
    '[secrets.linear]\napi_key = "op://Private/Linear/credential"\n[secrets.slack]\nwebhook_url = "env:NOT_SET_HOOK"\n',
  );
  const checks = await runStatus(w.options);
  const key = byId(checks, "linear.key");
  assert.equal(key.state, "fail");
  assert.equal(key.detail, "1Password: the op CLI is not installed");
  assert.equal(
    key.fix,
    "Fix the 1Password reference, or replace it in Settings, Connections, Linear.",
  );
  assert.equal(byId(checks, "linear.team").state, "missing");
  assert.equal(w.linearBodies.length, 0);
  const slack = byId(checks, "slack.webhook");
  assert.equal(slack.state, "warn");
  assert.equal(slack.detail, "env:NOT_SET_HOOK is not set; no Slack lines are sent");
});

test("connectionsOnly runs just those connection groups (MET-33)", async () => {
  const w = await world();
  const checks = await runStatus({ ...w.options, connectionsOnly: ["linear"] });
  assert.deepEqual(
    checks.map((c) => c.id),
    ["linear.key", "linear.team", "linear.states"],
  );
  assert.deepEqual(
    (await runStatus({ ...w.options, connectionsOnly: ["slack"] })).map((c) => c.id),
    ["slack.webhook"],
  );
  assert.ok(!w.calls.some((c) => c.includes("gh")));
});

test("locateHarness finds opencode by config bin, then HARNESSD_OPENCODE_BIN, then PATH", async () => {
  const isExecutable = async (p: string) => p.endsWith("/opencode");
  const env = { PATH: "/usr/bin:/opt/oc", HARNESSD_OPENCODE_BIN: "/env/opencode" };
  const config = { harnesses: { opencode: { bin: "/cfg/opencode" } } } as never;
  assert.deepEqual(await locateHarness("opencode", { config, env, isExecutable }), {
    path: "/cfg/opencode",
  });
  assert.deepEqual(await locateHarness("opencode", { config: undefined, env, isExecutable }), {
    path: "/env/opencode",
  });
  assert.deepEqual(
    await locateHarness("opencode", {
      config: undefined,
      env: { PATH: "/usr/bin:/opt/oc" },
      isExecutable: async (p) => p === "/opt/oc/opencode",
    }),
    { path: "/opt/oc/opencode" },
  );
});

// --- worktree write (MET-115) ---------------------------------------------

/** A root that exists but cannot be written. Restored so cleanup can delete it. */
async function unwritable(path: string): Promise<void> {
  await chmod(path, 0o555);
}

async function writable(path: string): Promise<void> {
  await chmod(path, 0o755).catch(() => undefined);
}

test("the worktree-write check is ok for Codex and OpenCode, and removes its scratch folder", async () => {
  const w = await world(
    '[linear]\nteam_id = "MET"\n\n[agents.backend]\nharness = "codex"\n\n[agents.qa]\nharness = "opencode"\n',
  );
  w.bins.add("/bin/opencode");
  w.replies.set("/bin/opencode --version", ok("opencode v2.0.20\n"));
  w.replies.set(
    "/bin/opencode auth list --format json --standalone",
    ok(JSON.stringify([{ id: "opencode", connections: [] }])),
  );
  const checks = await runStatus(w.options);
  for (const id of ["harness.codex.worktree_write", "harness.opencode.worktree_write"]) {
    const check = byId(checks, id);
    assert.equal(check.state, "ok", `${id}: ${check.detail}`);
    assert.equal(check.fix, "");
  }
  // Every scratch folder is gone. The repo folder the builder uses stays, empty.
  const root = join(w.globalDir, "worktrees");
  assert.deepEqual(await readdir(root), ["repo"]);
  assert.deepEqual(await readdir(join(root, "repo")), []);
});

test("the check keeps a repo worktrees folder that holds a real worktree", async () => {
  const w = await world();
  const repoRoot = join(w.globalDir, "worktrees", "repo");
  await mkdir(join(repoRoot, "met-1-real"), { recursive: true });
  const check = byId(await runStatus(w.options), "harness.claude-code.worktree_write");
  assert.equal(check.state, "ok", check.detail);
  assert.deepEqual(await readdir(repoRoot), ["met-1-real"]);
});

test("a worktrees root the daemon cannot write fails with the reason and the fix", async () => {
  const w = await world();
  const root = join(w.globalDir, "worktrees");
  await runStatus(w.options); // Creates the root and the repo folder.
  await rm(join(root, "repo"), { recursive: true, force: true });
  await unwritable(root);
  try {
    const check = byId(
      await runStatus({ ...w.options, freshWorktreeWrite: true }),
      "harness.claude-code.worktree_write",
    );
    assert.equal(check.state, "fail");
    assert.match(check.detail, /EACCES|permission denied/i);
    assert.equal(
      check.fix,
      `Make ${root} writable by the daemon user, and make ${join(root, "repo")} a folder, not a file.`,
    );
    assert.ok(isBlocking(check));
  } finally {
    await writable(root);
  }
});

test("a file where the builder's repo folder goes fails, with EEXIST and the fix", async () => {
  const w = await world();
  const root = join(w.globalDir, "worktrees");
  const repoRoot = join(root, "repo");
  await mkdir(root, { recursive: true });
  await writeFile(repoRoot, "not a folder\n");
  try {
    const check = byId(
      await runStatus({ ...w.options, freshWorktreeWrite: true }),
      "harness.claude-code.worktree_write",
    );
    assert.equal(check.state, "fail");
    assert.match(check.detail, /EEXIST|file already exists/i);
    assert.match(check.detail, /worktrees\/repo/);
    assert.match(check.fix, /make .*worktrees\/repo a folder, not a file/);
    assert.ok(isBlocking(check));
    // The check does not delete what it did not make.
    assert.equal(await readFile(repoRoot, "utf8"), "not a folder\n");
  } finally {
    await rm(repoRoot, { force: true });
  }
});

test("the worktree-write check is missing, not checked, when the harness is not installed", async () => {
  const w = await world();
  w.bins.delete("/bin/claude");
  const check = byId(await runStatus(w.options), "harness.claude-code.worktree_write");
  assert.deepEqual(check, {
    id: "harness.claude-code.worktree_write",
    state: "missing",
    detail: "not checked",
    fix: "Fix harness.claude-code.cli first.",
  });
});

test("no worktree-write check runs for a harness no agent uses", async () => {
  const w = await world('[linear]\nteam_id = "MET"\n\n[agents.backend]\nharness = "claude-code"\n');
  const checks = await runStatus(w.options);
  assert.ok(checks.some((c) => c.id === "harness.claude-code.worktree_write"));
  assert.ok(!checks.some((c) => c.id === "harness.codex.worktree_write"));
  assert.ok(!checks.some((c) => c.id === "harness.opencode.worktree_write"));
});

test("a harness an agent names only as fallback gets the worktree-write check", async () => {
  const w = await world(
    '[linear]\nteam_id = "MET"\n\n[agents.backend]\nharness = "claude-code"\nfallback_harness = "codex"\n',
  );
  const check = byId(await runStatus(w.options), "harness.codex.worktree_write");
  assert.equal(check.state, "ok", check.detail);
});

test("GET /api/status reuses the worktree-write result for ten minutes; doctor and start run fresh", async () => {
  const w = await world();
  const root = join(w.globalDir, "worktrees");
  assert.equal(byId(await runStatus(w.options), "harness.claude-code.worktree_write").state, "ok");
  await rm(join(root, "repo"), { recursive: true, force: true });
  await unwritable(root);
  try {
    // The cached result stands: a poll makes no worktree.
    assert.equal(
      byId(
        await runStatus({ ...w.options, freshWorktreeWrite: false }),
        "harness.claude-code.worktree_write",
      ).state,
      "ok",
    );
    // Doctor and Start ask for a fresh check, so the broken root shows at once.
    const fresh = byId(
      await runStatus({ ...w.options, freshWorktreeWrite: true }),
      "harness.claude-code.worktree_write",
    );
    assert.equal(fresh.state, "fail");
    // After the cache ends, the poll checks again too.
    const late = byId(
      await runStatus({
        ...w.options,
        freshWorktreeWrite: false,
        now: () => Date.now() + WORKTREE_WRITE_CACHE_MS + 1,
      }),
      "harness.claude-code.worktree_write",
    );
    assert.equal(late.state, "fail");
  } finally {
    await writable(root);
  }
});

test("Codex in a sandboxed mode writes through `codex sandbox`, with a fixed argv and no shell", async () => {
  const w = await world();
  const root = join(w.globalDir, "worktrees");
  const calls: { cmd: string; args: readonly string[] }[] = [];
  const result = await worktreeWriteCheck({
    id: "harness.codex.worktree_write",
    harness: "codex",
    bin: "/bin/codex",
    version: "0.171.0",
    root,
    name: "repo",
    sandboxMode: "workspace-write",
    timeoutMs: 2000,
    exec: async (cmd, args) => {
      calls.push({ cmd, args });
      // A sandboxed command writes the file the argv names.
      await writeFile(args[args.length - 1] ?? "", "harnessd\n");
      return ok();
    },
  });
  assert.equal(result.state, "ok", result.detail);
  assert.equal(calls.length, 1);
  const { cmd, args } = calls[0] ?? { cmd: "", args: [] };
  assert.equal(cmd, "/bin/codex");
  assert.deepEqual(args.slice(0, 3), ["sandbox", "--permission-profile", ":workspace"]);
  assert.equal(args[args.indexOf("-C") + 1], args[args.indexOf("--") - 1]);
  assert.equal(args[args.indexOf("--") + 1], "/usr/bin/touch", "no shell runs the write");
  assert.ok(!args.includes("-c"), "the built-in profile needs no config overrides");
  assert.deepEqual(await readdir(join(root, "repo")), [], "the scratch folder is removed");
});

test("Codex read-only mode runs through the read-only sandbox profile", async () => {
  const w = await world();
  const calls: { cmd: string; args: readonly string[] }[] = [];
  const result = await worktreeWriteCheck({
    id: "harness.codex.worktree_write",
    harness: "codex",
    bin: "/bin/codex",
    version: "0.171.0",
    root: join(w.globalDir, "worktrees"),
    name: "repo",
    sandboxMode: "read-only",
    timeoutMs: 2000,
    exec: async (cmd, args) => {
      calls.push({ cmd, args });
      return failed("Operation not permitted");
    },
  });
  assert.equal(result.state, "fail");
  assert.equal(result.detail, "Operation not permitted");
  assert.equal(calls[0]?.args[2], ":read-only");
});

test("Codex in a sandboxed mode fails with the sandbox reason and names the setting", async () => {
  const w = await world();
  const root = join(w.globalDir, "worktrees");
  const result = await worktreeWriteCheck({
    id: "harness.codex.worktree_write",
    harness: "codex",
    bin: "/bin/codex",
    version: "0.171.0",
    root,
    name: "repo",
    sandboxMode: "workspace-write",
    timeoutMs: 2000,
    exec: async () => failed("Operation not permitted"),
  });
  assert.equal(result.state, "fail");
  assert.equal(result.detail, "Operation not permitted");
  assert.match(result.fix, /--sandbox danger-full-access/);
  assert.match(result.fix, /workspace-write/);
});

test("Codex with danger-full-access writes as the daemon user, with no sandbox command", async () => {
  const w = await world();
  const result = await worktreeWriteCheck({
    id: "harness.codex.worktree_write",
    harness: "codex",
    bin: "/bin/codex",
    version: "0.171.0",
    root: join(w.globalDir, "worktrees"),
    name: "repo",
    sandboxMode: "danger-full-access",
    timeoutMs: 2000,
    exec: async () => {
      throw new Error("the check must not run a sandbox command");
    },
  });
  assert.equal(result.state, "ok", result.detail);
});

test("codexSandboxMode reads the mode from the adapter's argv", () => {
  assert.equal(codexSandboxMode(), "danger-full-access");
});

test("Codex in a sandboxed mode fails when the command exits ok but writes nothing", async () => {
  const w = await world();
  const result = await worktreeWriteCheck({
    id: "harness.codex.worktree_write",
    harness: "codex",
    bin: "/bin/codex",
    version: "0.171.0",
    root: join(w.globalDir, "worktrees"),
    name: "repo",
    sandboxMode: "workspace-write",
    timeoutMs: 2000,
    exec: async () => ok(),
  });
  assert.equal(result.state, "fail");
  assert.match(result.detail, /ENOENT|no such file/);
  assert.match(result.fix, /danger-full-access/);
});
