import assert from "node:assert/strict";
import { chmodSync, existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  agentForRole,
  type Check,
  createFilePauseStore,
  type GitHub,
  harnessForRun,
  type LinearClient,
  loadConfig,
  readDaemonInfo,
  resolveAgentConfig,
  startDaemon,
} from "@harnessd/daemon";
import { run } from "./index.ts";
import {
  createSelfUpdate,
  harnessAdapters,
  parseRunArgs,
  runLoop,
  selfUpdateCheck,
} from "./loop.ts";

const roots: string[] = [];
after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function setup(env: NodeJS.ProcessEnv, config?: string) {
  const root = await mkdtemp(join(tmpdir(), "harnessd-cli-run-"));
  roots.push(root);
  const repo = join(root, "repo");
  const home = join(root, "global");
  await mkdir(join(repo, ".harnessd"), { recursive: true });
  await mkdir(home, { recursive: true });
  if (config !== undefined) await writeFile(join(repo, ".harnessd", "config.toml"), config);
  const out: string[] = [];
  const err: string[] = [];
  const io = {
    out: (l: string) => out.push(l),
    err: (l: string) => err.push(l),
    cwd: repo,
    env: { HARNESSD_HOME: home, ...env },
    checks: async () => [] as Check[],
  };
  return { root, repo, home, out, err, io };
}

/** A GitHub client that only names the default branch; the loop in a test uses no other call. */
function stubGitHub(defaultBranch = "main"): GitHub {
  const unused = async (): Promise<never> => assert.fail("GitHub is not used in this test");
  return {
    defaultBranch: async () => defaultBranch,
    findPrByHead: unused,
    findPrForIssue: unused,
    createPr: unused,
    prFiles: unused,
    prDiff: unused,
    postReview: unused,
    prStatus: unused,
    mergePr: unused,
    addLabel: unused,
  };
}

/** A Linear client with nothing to dispatch, so a started tick finishes without a network call. */
function stubLinear(): LinearClient {
  const unused = async (): Promise<never> => assert.fail("Linear is not used in this test");
  return {
    listReady: async () => [],
    listReadyContaining: async () => [],
    listBoard: async () => [],
    listChildren: unused,
    getIssue: unused,
    comment: unused,
    moveTo: unused,
  } as unknown as LinearClient;
}

const INSTALL = "/install";
const UPDATE_FROM = "a".repeat(40);
const UPDATE_TO = "b".repeat(40);
const UPDATE_STATUS =
  "git /install --no-optional-locks status --porcelain --untracked-files=all --ignore-submodules=none";

/** A fake install clone for the self-update check, with a mutable status answer. */
function fakeUpdateRunner(status = "") {
  const calls: string[] = [];
  const answers = new Map<string, string>([
    [UPDATE_STATUS, status],
    ["git /install symbolic-ref --quiet HEAD", "refs/heads/main"],
    [
      "git /install fetch --no-tags --no-recurse-submodules --refmap= origin +refs/heads/main:refs/remotes/origin/main",
      "",
    ],
    ["git /install rev-parse --verify HEAD^{commit}", UPDATE_FROM],
    ["git /install rev-parse --verify refs/remotes/origin/main^{commit}", UPDATE_TO],
    [`git /install merge-base --is-ancestor ${UPDATE_FROM} ${UPDATE_TO}`, ""],
  ]);
  for (const marker of ["MERGE_HEAD", "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD"]) {
    answers.set(
      `git /install rev-parse --path-format=absolute --git-path ${marker}`,
      `/git-dir/${marker}`,
    );
  }
  return {
    calls,
    answers,
    runner: {
      async exec(command: string, args: readonly string[], options?: { cwd?: string }) {
        const key = [command, options?.cwd, ...args].filter(Boolean).join(" ");
        calls.push(key);
        const answer = answers.get(key);
        assert.notEqual(answer, undefined, key);
        return { code: 0, stdout: answer ?? "", stderr: "" };
      },
      async pathKind() {
        return undefined;
      },
    },
  };
}

test("run fails clearly without LINEAR_API_KEY and never prints a key", async () => {
  for (const key of [undefined, "  "]) {
    const s = await setup(
      key === undefined ? {} : { LINEAR_API_KEY: key },
      '[linear]\nteam_id = "MET"\n',
    );
    assert.equal(await run(["run", "--once"], s.io), 1);
    assert.match(s.err.join("\n"), /LINEAR_API_KEY is not set/);
    assert.deepEqual(s.out, []);
  }
});

test("run fails clearly without linear.team_id", async () => {
  const s = await setup({ LINEAR_API_KEY: "lin_api_secret_value" });
  assert.equal(await run(["run", "--once"], s.io), 1);
  assert.match(s.err.join("\n"), /linear\.team_id is not set/);
  assert.doesNotMatch(s.err.join("\n"), /lin_api_secret_value/);
});

test("run surfaces config errors", async () => {
  const s = await setup({ LINEAR_API_KEY: "k" }, '[limits]\nmax_concurrent = "three"\n');
  assert.equal(await run(["run", "--once"], s.io), 1);
  assert.match(s.err[0] ?? "", /^harnessd run: .*max_concurrent/);
});

test("run rejects bad arguments with the usage line", async () => {
  const s = await setup({ LINEAR_API_KEY: "k" });
  assert.equal(await run(["run", "--interval", "0"], s.io), 2);
  assert.match(s.err.join("\n"), /--interval: expected seconds >= 1\nUsage: harnessd run/);
});

test("parseRunArgs reads the dir, --once, --interval and --permission-mode", () => {
  assert.deepEqual(parseRunArgs([]), {
    once: false,
    intervalMs: 30_000,
    permissionMode: "auto",
  });
  assert.deepEqual(
    parseRunArgs(["repo", "--once", "--interval", "5", "--permission-mode", "acceptEdits"]),
    {
      dir: "repo",
      once: true,
      intervalMs: 5_000,
      permissionMode: "acceptEdits",
    },
  );
  assert.equal(parseRunArgs(["a", "b"]), 'unexpected argument "b"');
  assert.equal(parseRunArgs(["--nope"]), 'unexpected argument "--nope"');
  assert.equal(parseRunArgs(["--permission-mode"]), "--permission-mode: expected a mode");
});

const PAUSED_CONFIG = '[linear]\nteam_id = "MET"\n\n[daemon]\nport = 0\n';

test("run detects its install once at daemon startup", async () => {
  const s = await setup({ LINEAR_API_KEY: "k" }, PAUSED_CONFIG);
  const cliUrl = new URL("install/packages/cli/dist/bin.js", `file://${s.root}/`).href;
  const cliDir = dirname(fileURLToPath(cliUrl));
  const sha = "a".repeat(40);
  let rootChecks = 0;
  let updateChecks = 0;
  const io = {
    ...s.io,
    cliUrl,
    github: stubGitHub("trunk"),
    linear: stubLinear(),
    selfUpdateRunner: {
      async exec(command: string, args: readonly string[], options?: { cwd?: string }) {
        const cwd = options?.cwd;
        if (command === "launchctl") return { code: 0, stdout: `pid = ${process.pid}`, stderr: "" };
        if (args[0] === "rev-parse" && cwd === cliDir) {
          rootChecks++;
          return { code: 0, stdout: s.root, stderr: "" };
        }
        if (args[0] === "remote") {
          return { code: 0, stdout: "https://github.com/acme/harnessd.git", stderr: "" };
        }
        if (args.includes("status")) {
          updateChecks++;
          return { code: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "symbolic-ref") {
          return { code: 0, stdout: "refs/heads/trunk", stderr: "" };
        }
        if (args[0] === "rev-parse") return { code: 0, stdout: sha, stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
      async pathKind(path: string) {
        return path === join(s.repo, "packages", "daemon") ? ("directory" as const) : undefined;
      },
    },
  };
  const code = await run(["run", "--once"], io);
  assert.equal(code, 0);
  assert.equal(rootChecks, 1);
  assert.equal(updateChecks, 1, "the wired updater checked the install clone");
  assert.equal(
    s.out.filter((line) => line.endsWith("Self-update detected the install clone.")).length,
    1,
  );
});

test("run while paused starts the API, says it is paused and dispatches nothing", async () => {
  const s = await setup({ LINEAR_API_KEY: "k" }, PAUSED_CONFIG);
  await createFilePauseStore(s.home).pause("deploy");
  assert.equal(await run(["run", "--once"], s.io), 0);
  assert.match(s.out[0] ?? "", /^harnessd run: (UI and )?API at http:\/\/127\.0\.0\.1:\d+/);
  assert.match(
    s.out[1] ?? "",
    /^harnessd run: paused since \S+ \(deploy\)\. Run "harnessd resume"/,
  );
  assert.equal(s.out.at(-1), "paused: nothing dispatched");
  assert.equal(await readDaemonInfo(s.home), undefined, "daemon.json removed on stop");
});

test("run writes daemon.json and serves the pause API until it stops", async () => {
  const s = await setup({ LINEAR_API_KEY: "k" }, PAUSED_CONFIG);
  await createFilePauseStore(s.home).pause();
  let seen: unknown;
  let url = "";
  const code = await runLoop([], {
    ...s.io,
    stopSignal: async () => {
      const info = await readDaemonInfo(s.home);
      url = info?.url ?? "";
      assert.equal(info?.pid, process.pid);
      seen = await (await fetch(`${url}/api/pause`)).json();
      return "SIGTERM";
    },
  });
  assert.equal(code, 0);
  assert.equal((seen as { paused: boolean }).paused, true);
  assert.equal(existsSync(join(s.home, "state", "daemon.json")), false);
  await assert.rejects(fetch(`${url}/health`), "the server is closed");
});

test("run fails clearly when the API port is taken", async () => {
  const s = await setup({ LINEAR_API_KEY: "k" });
  const busy = await startDaemon();
  try {
    const port = new URL(busy.url).port;
    await writeFile(
      join(s.repo, ".harnessd", "config.toml"),
      `[linear]\nteam_id = "MET"\n\n[daemon]\nport = ${port}\n`,
    );
    assert.equal(await run(["run", "--once"], s.io), 1);
    assert.match(s.err.join("\n"), new RegExp(`port ${port} is in use`));
  } finally {
    await busy.close();
  }
});

test("run serves the UI and its read routes next to the pause API", async () => {
  const s = await setup({ LINEAR_API_KEY: "k" }, `${PAUSED_CONFIG}self_update = false\n`);
  await createFilePauseStore(s.home).pause();
  const uiDir = join(s.root, "ui");
  await mkdir(uiDir);
  await writeFile(join(uiDir, "index.html"), "<!doctype html><title>harnessd</title>");
  let page = "";
  let agents: unknown;
  let logs: unknown;
  const code = await runLoop([], {
    ...s.io,
    uiDir,
    selfUpdateRunner: {
      async exec() {
        assert.fail("disabled self-update must not run commands");
      },
      async pathKind() {
        assert.fail("disabled self-update must not inspect paths");
      },
    },
    stopSignal: async () => {
      const url = (await readDaemonInfo(s.home))?.url ?? "";
      page = await (await fetch(`${url}/`)).text();
      agents = await (await fetch(`${url}/api/agents`)).json();
      logs = await (await fetch(`${url}/api/logs`)).json();
      return "SIGTERM";
    },
  });
  assert.equal(code, 0);
  assert.match(s.out[0] ?? "", /^harnessd run: UI and API at http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(page, "<!doctype html><title>harnessd</title>");
  assert.deepEqual(
    (agents as { agents: { name: string }[] }).agents.map((a) => a.name),
    ["coordinator", "backend", "frontend", "qa", "reviewer"],
  );
  assert.deepEqual(
    (logs as { lines: { text: string }[] }).lines.map(({ text }) => text),
    ["Self-update is off. daemon.self_update is false."],
  );
});

test("run without a built UI still serves the API and says so", async () => {
  const s = await setup({ LINEAR_API_KEY: "k" }, PAUSED_CONFIG);
  await createFilePauseStore(s.home).pause();
  assert.equal(await runLoop(["--once"], { ...s.io, uiDir: join(s.root, "none") }), 0);
  assert.match(s.out[0] ?? "", /^harnessd run: API at http:\/\/\S+ \(UI not built\)$/);
});

test("run without a Slack webhook logs one warning and works as before", async () => {
  const s = await setup({ LINEAR_API_KEY: "k" }, PAUSED_CONFIG);
  await createFilePauseStore(s.home).pause();
  assert.equal(await run(["run", "--once"], s.io), 0);
  const warnings = s.out.filter((l) => /HARNESSD_SLACK_WEBHOOK_URL is not set/.test(l));
  assert.equal(warnings.length, 1);
  assert.equal(s.out.at(-1), "paused: nothing dispatched");
});

test("run sends a missed daily summary once at start, through the webhook", async () => {
  const webhook = "https://hooks.slack.test/services/T000/B000/fake-token";
  const s = await setup(
    { LINEAR_API_KEY: "k", HARNESSD_SLACK_WEBHOOK_URL: webhook },
    PAUSED_CONFIG,
  );
  await createFilePauseStore(s.home).pause();
  await mkdir(join(s.repo, ".harnessd", "state"), { recursive: true });
  const since = "2026-01-01T01:00:00.000Z";
  const until = "2026-01-01T02:00:00.000Z";
  await writeFile(
    join(s.repo, ".harnessd", "state", "loop.json"),
    JSON.stringify({ version: 1, inFlight: [], limits: { "claude-code": { since, until } } }),
  );
  await writeFile(
    join(s.repo, ".harnessd", "state", "summary.json"),
    JSON.stringify({
      version: 1,
      lastSentAt: "2026-01-01T00:00:00.000Z",
      notices: [],
      holdEvents: [{ harness: "claude-code", kind: "start", at: since }],
    }),
  );
  const posts: { url: string; text: string }[] = [];
  const io = {
    ...s.io,
    fetch: async (url: string, init: { body: string }) => {
      posts.push({ url, text: (JSON.parse(init.body) as { text: string }).text });
      return { ok: true, status: 200 };
    },
  };
  assert.equal(await run(["run", "--once"], io), 0);
  assert.equal(await runLoop(["--once"], io), 0, "a second start sends nothing more");
  assert.equal(posts.length, 1);
  assert.equal(posts[0]?.url, webhook);
  assert.match(
    posts[0]?.text ?? "",
    /^\*harnessd daily summary\* since 1 Jan 05:30 \(Asia\/Kolkata\)/,
  );
  assert.doesNotMatch([...s.out, ...s.err].join("\n"), /fake-token/);
  assert.match(posts[0]?.text ?? "", /\nClaude Code limited 1h\n/);
});

test("run refuses to start on a failing check and prints its fix", async () => {
  const s = await setup({ LINEAR_API_KEY: "lin_api_secret_value" }, PAUSED_CONFIG);
  const code = await runLoop(["--once"], {
    ...s.io,
    checks: async () => [
      { id: "node", state: "ok", detail: "v24.11.0", fix: "" },
      { id: "slack.webhook", state: "warn", detail: "not set", fix: "set it" },
      { id: "github.auth", state: "fail", detail: "not signed in", fix: "Run: gh auth login" },
    ],
  });
  assert.equal(code, 1);
  assert.match(s.err[0] ?? "", /1 check failed; not starting/);
  assert.equal(s.err[1], "  github.auth (fail): not signed in. Fix: Run: gh auth login");
  assert.deepEqual(s.out, [], "no API and no loop");
  assert.equal(await readDaemonInfo(s.home), undefined);
});

test("run starts on warnings only and serves the checks at GET /api/status", async () => {
  const s = await setup({ LINEAR_API_KEY: "k" }, PAUSED_CONFIG);
  await createFilePauseStore(s.home).pause();
  const seen: boolean[] = [];
  let body: unknown;
  const code = await runLoop([], {
    ...s.io,
    checks: async (o) => {
      seen.push(o.servingPort === true);
      return [{ id: "slack.webhook", state: "warn", detail: "not set", fix: "set it" }];
    },
    stopSignal: async () => {
      const info = await readDaemonInfo(s.home);
      body = await (await fetch(`${info?.url}/api/status`)).json();
      return "SIGTERM";
    },
  });
  assert.equal(code, 0);
  assert.match(s.err.join("\n"), /warn slack\.webhook: not set/);
  assert.deepEqual(body, {
    checks: [{ id: "slack.webhook", state: "warn", detail: "not set", fix: "set it" }],
  });
  assert.deepEqual(seen, [false, true], "the API run knows this daemon holds the port");
});

const FAILING: Check[] = [
  {
    id: "harness.claude-code.cli",
    state: "missing",
    detail: "claude is not on PATH",
    fix: "Install it",
  },
];

test("run on a blocking check serves the app in setup and dispatches nothing", async () => {
  const s = await setup({ LINEAR_API_KEY: "k" }, PAUSED_CONFIG);
  let loop: unknown;
  const code = await runLoop([], {
    ...s.io,
    checks: async () => FAILING,
    stopSignal: async () => {
      const info = await readDaemonInfo(s.home);
      loop = await (await fetch(`${info?.url}/api/loop`)).json();
      return "SIGTERM";
    },
  });
  assert.equal(code, 0);
  assert.deepEqual(loop, { state: "setup", blocking: ["harness.claude-code.cli"] });
  assert.match(s.err.join("\n"), /1 check failed; the loop waits/);
  assert.match(s.out.join("\n"), /Finish setup at http:\/\/127\.0\.0\.1:\d+\/#\/settings/);
});

test("a startup check that times out once and then passes leaves the loop running with no Start", async () => {
  const s = await setup({ LINEAR_API_KEY: "k" }, PAUSED_CONFIG);
  await createFilePauseStore(s.home).pause();
  const calls: Array<{ timeoutMs?: number | undefined; freshWorktreeWrite?: boolean | undefined }> =
    [];
  let loop: unknown;
  const code = await runLoop([], {
    ...s.io,
    checks: async (o) => {
      calls.push({ timeoutMs: o.timeoutMs, freshWorktreeWrite: o.freshWorktreeWrite });
      if (calls.length === 1) {
        return [
          {
            id: "harness.opencode.auth",
            state: "fail",
            detail: "sign-in check timed out after 5 s",
            fix: "Sign in again",
          },
        ];
      }
      return [];
    },
    stopSignal: async () => {
      const info = await readDaemonInfo(s.home);
      loop = await (await fetch(`${info?.url}/api/loop`)).json();
      return "SIGTERM";
    },
  });
  assert.equal(code, 0);
  assert.deepEqual(calls, [
    { timeoutMs: undefined, freshWorktreeWrite: true },
    { timeoutMs: 15_000, freshWorktreeWrite: false },
  ]);
  assert.match(s.out.join("\n"), /harness\.opencode\.auth timed out, retry 2\/3 with 15 s/);
  assert.deepEqual(loop, { state: "running", blocking: [], limits: [] });
});

test("a startup check that keeps timing out runs 3 times and waits in setup", async () => {
  const s = await setup({ LINEAR_API_KEY: "k" }, PAUSED_CONFIG);
  let runs = 0;
  const code = await runLoop([], {
    ...s.io,
    checks: async () => {
      runs++;
      return [
        {
          id: "harness.opencode.auth",
          state: "fail",
          detail: "sign-in check timed out after 5 s",
          fix: "Sign in again",
        },
      ];
    },
    stopSignal: async () => "SIGTERM",
  });
  assert.equal(code, 0);
  assert.equal(runs, 3);
  assert.match(s.out.join("\n"), /retry 2\/3 with 15 s/);
  assert.match(s.out.join("\n"), /retry 3\/3 with 15 s/);
  assert.match(s.out.join("\n"), /Finish setup/);
});

test("--once retries a timed-out check and still exits 1 when it keeps timing out", async () => {
  const s = await setup({ LINEAR_API_KEY: "k" }, PAUSED_CONFIG);
  let runs = 0;
  const code = await runLoop(["--once"], {
    ...s.io,
    checks: async () => {
      runs++;
      return [
        {
          id: "harness.opencode.auth",
          state: "fail",
          detail: "sign-in check timed out after 5 s",
          fix: "Sign in again",
        },
      ];
    },
  });
  assert.equal(code, 1);
  assert.equal(runs, 3);
  assert.match(s.err.join("\n"), /harness\.opencode\.auth/);
});

test("POST /api/start refuses while a check blocks, then starts the loop once all pass", async () => {
  const s = await setup({ LINEAR_API_KEY: "k" }, PAUSED_CONFIG);
  await createFilePauseStore(s.home).pause();
  let checks = FAILING;
  const answers: unknown[] = [];
  const code = await runLoop([], {
    ...s.io,
    checks: async () => checks,
    stopSignal: async () => {
      const url = (await readDaemonInfo(s.home))?.url ?? "";
      const start = () =>
        fetch(`${url}/api/start`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
      const refused = await start();
      answers.push(refused.status, await refused.json());
      checks = [];
      const ok = await start();
      answers.push(ok.status, await ok.json());
      answers.push(await (await fetch(`${url}/api/loop`)).json());
      return "SIGTERM";
    },
  });
  assert.equal(code, 0);
  assert.equal(answers[0], 409);
  assert.equal((answers[1] as { error: string }).error, "setup_incomplete");
  assert.match((answers[1] as { message: string }).message, /harness\.claude-code\.cli/);
  assert.equal(answers[2], 200);
  assert.deepEqual(answers[3], { state: "running", blocking: [], limits: [] });
  assert.deepEqual(answers[4], { state: "running", blocking: [], limits: [] });
});

test("GET /api/loop lists the harness holds in force and leaves an expired one out (MET-82)", async () => {
  const s = await setup({ LINEAR_API_KEY: "k" }, PAUSED_CONFIG);
  await createFilePauseStore(s.home).pause();
  await mkdir(join(s.repo, ".harnessd", "state"), { recursive: true });
  const held = { until: "2099-01-01T00:00:00.000Z", since: "2026-11-20T17:37:00.000Z" };
  const expired = {
    until: "2026-01-01T00:15:00.000Z",
    since: "2026-01-01T00:00:00.000Z",
    backoffMs: 900_000,
  };
  await writeFile(
    join(s.repo, ".harnessd", "state", "loop.json"),
    JSON.stringify({ version: 1, inFlight: [], limits: { "claude-code": held, codex: expired } }),
  );
  let loop: unknown;
  const code = await runLoop([], {
    ...s.io,
    checks: async () => [],
    stopSignal: async () => {
      const url = (await readDaemonInfo(s.home))?.url ?? "";
      // The first tick reads loop.json; until then the loop knows no hold.
      for (let i = 0; i < 100; i++) {
        loop = await (await fetch(`${url}/api/loop`)).json();
        if ((loop as { limits?: unknown[] }).limits?.length) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      return "SIGTERM";
    },
  });
  assert.equal(code, 0);
  assert.deepEqual(loop, {
    state: "running",
    blocking: [],
    limits: [{ harness: "claude-code", until: held.until, backoff: false }],
  });
});

test("run without LINEAR_API_KEY serves setup and names the variable, never a value", async () => {
  const s = await setup({}, PAUSED_CONFIG);
  let loop: unknown;
  const code = await runLoop([], {
    ...s.io,
    stopSignal: async () => {
      const info = await readDaemonInfo(s.home);
      loop = await (await fetch(`${info?.url}/api/loop`)).json();
      return "SIGTERM";
    },
  });
  assert.equal(code, 0);
  assert.deepEqual(loop, { state: "setup", blocking: ["linear.key"] });
  assert.match(s.err.join("\n"), /LINEAR_API_KEY is not set/);
});

test("first launch: a key saved in Settings starts the loop with no restart, and no value leaks", async () => {
  const key = "lin_api_FIRSTLAUNCH0123456789";
  const hook = "https://hooks.slack.com/services/T1/B1/FIRSTHOOK77";
  const s = await setup({}, PAUSED_CONFIG);
  await createFilePauseStore(s.home).pause();
  const seen: string[] = [];
  const answers: Record<string, unknown> = {};
  const code = await runLoop([], {
    ...s.io,
    stopSignal: async () => {
      const url = (await readDaemonInfo(s.home))?.url ?? "";
      const read = async (path: string, init?: RequestInit) => {
        const res = await fetch(url + path, init);
        const text = await res.text();
        seen.push(text);
        return { status: res.status, body: JSON.parse(text) as unknown };
      };
      const post = (path: string, body: unknown) =>
        read(path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      // The event stream is open while the secrets are saved.
      const events = await fetch(`${url}/api/events`);
      const reader = events.body?.getReader();
      answers.before = (await read("/api/loop")).body;
      answers.refused = (await post("/api/start", {})).status;
      answers.saved = (await post("/api/secrets/linear.api_key", { value: key })).body;
      answers.hook = (await post("/api/secrets/slack.webhook_url", { value: hook })).body;
      answers.bad = (await post("/api/secrets/slack.webhook_url", { value: `${hook} x` })).body;
      answers.list = (await read("/api/secrets")).body;
      answers.start = (await post("/api/start", {})).body;
      await read("/api/logs");
      await read("/api/status");
      if (reader) {
        const deadline = Date.now() + 1500;
        const decoder = new TextDecoder();
        while (Date.now() < deadline) {
          const chunk = await Promise.race([
            reader.read(),
            new Promise<{ done: true }>((r) => setTimeout(() => r({ done: true }), 300)),
          ]);
          if (chunk.done) break;
          seen.push(decoder.decode((chunk as { value: Uint8Array }).value));
        }
        await reader.cancel();
      }
      return "SIGTERM";
    },
  });
  assert.equal(code, 0);
  assert.deepEqual(answers.before, { state: "setup", blocking: ["linear.key"] });
  assert.equal(answers.refused, 409);
  assert.deepEqual((answers.saved as { secret: unknown }).secret, {
    id: "linear.api_key",
    set: true,
    source: "saved",
    stored: true,
  });
  assert.equal((answers.bad as { error: string }).error, "invalid_body");
  assert.deepEqual(answers.list, {
    secrets: [
      { id: "linear.api_key", set: true, source: "saved", stored: true },
      { id: "slack.webhook_url", set: true, source: "saved", stored: true },
    ],
  });
  assert.deepEqual(answers.start, { state: "running", blocking: [], limits: [] });
  assert.match(s.out.join("\n"), /settings: saved linear\.api_key \(saved\)/);
  const everything = [...seen, ...s.out, ...s.err].join("\n");
  assert.doesNotMatch(everything, /FIRSTLAUNCH|FIRSTHOOK/);
  assert.match(seen.join("\n"), /event: log/);
});

test("GET /api/loop reads the current checks, so a saved key clears linear.key with no restart", async () => {
  const s = await setup({}, PAUSED_CONFIG);
  // Paused, so the started loop makes no Linear call.
  await createFilePauseStore(s.home).pause();
  const answers: Record<string, unknown> = {};
  const code = await runLoop([], {
    ...s.io,
    stopSignal: async () => {
      const url = (await readDaemonInfo(s.home))?.url ?? "";
      const post = async (path: string, body: unknown) =>
        (
          await fetch(url + path, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          })
        ).json();
      answers.before = await (await fetch(`${url}/api/loop`)).json();
      await post("/api/secrets/linear.api_key", { value: "lin_api_CURRENTCHECKS0123" });
      answers.after = await (await fetch(`${url}/api/loop`)).json();
      answers.start = await post("/api/start", {});
      answers.running = await (await fetch(`${url}/api/loop`)).json();
      return "SIGTERM";
    },
  });
  assert.equal(code, 0);
  assert.deepEqual(answers.before, { state: "setup", blocking: ["linear.key"] });
  assert.deepEqual(answers.after, { state: "setup", blocking: [] });
  assert.deepEqual(answers.start, { state: "running", blocking: [], limits: [] });
  assert.deepEqual(answers.running, { state: "running", blocking: [], limits: [] });
});

test('[agents.backend] harness = "codex" dispatches to the codex adapter with the set bin', async () => {
  const s = await setup({});
  const fake = join(s.root, "fake-codex");
  await writeFile(fake, '#!/bin/sh\necho \'{"type":"turn.completed","usage":{}}\'\n');
  chmodSync(fake, 0o755);
  await writeFile(
    join(s.repo, ".harnessd", "config.toml"),
    `[agents.backend]\nrole = "backend"\nharness = "codex"\n\n[harnesses.codex]\nbin = "${fake}"\n`,
  );
  const config = await loadConfig({ globalDir: s.home, workspaceDir: join(s.repo, ".harnessd") });
  const adapters = harnessAdapters(config, "auto");
  const name = agentForRole(config, "backend");
  assert.equal(name, "backend");
  const adapter = adapters[resolveAgentConfig(config, name ?? "").harness];
  assert.equal(adapter?.id, "codex");
  assert.equal(adapters["claude-code"]?.id, "claude-code");

  const started = adapter?.start(
    { id: "MET-75", title: "t", prompt: "p", budgetMs: 10_000 },
    s.repo,
  );
  const events = [];
  for await (const event of started?.events ?? []) events.push(event);
  const first = events[0];
  assert.ok(first?.type === "start");
  assert.equal(first.argv[0], fake);
  assert.ok(!first.argv.includes("--permission-mode"), "--permission-mode is Claude-only");
  assert.equal((await started?.result)?.status, "ok");
});

test("the self-update updater is wired when detection finds the install clone", async () => {
  const f = fakeUpdateRunner("");
  const updater = await createSelfUpdate({
    detection: { kind: "on", installRoot: INSTALL },
    github: stubGitHub("main"),
    repoDir: "/repo",
    log: () => assert.fail("a clean check logs nothing"),
    runner: f.runner,
  });
  assert.ok(updater);
  assert.equal(updater.runningCommit, UPDATE_FROM);
  assert.deepEqual(await updater.checkForUpdate(), { from: UPDATE_FROM, to: UPDATE_TO });
  assert.ok(f.calls.includes(UPDATE_STATUS));
});

test("no updater is built when detection is off", async () => {
  const updater = await createSelfUpdate({
    detection: { kind: "off" },
    github: stubGitHub("main"),
    repoDir: "/repo",
    log: () => assert.fail("an off detection logs nothing here"),
  });
  assert.equal(updater, undefined);
});

test("a blocked self-update check logs its reason once and returns no target", async () => {
  const log: string[] = [];
  const f = fakeUpdateRunner(" M src/x.ts\n");
  const check = selfUpdateCheck(
    { kind: "on", installRoot: INSTALL },
    "main",
    (line) => log.push(line),
    f.runner,
  );
  assert.equal(await check(), undefined);
  assert.equal(await check(), undefined);
  assert.deepEqual(log, [
    "self-update: not updating: Local changes in the install clone: src/x.ts",
  ]);

  // A changed reason is news again.
  f.answers.set(UPDATE_STATUS, " M src/y.ts\n");
  assert.equal(await check(), undefined);
  assert.deepEqual(
    log.at(-1),
    "self-update: not updating: Local changes in the install clone: src/y.ts",
  );
  assert.equal(log.length, 2);

  // A target appears; a later block with the first reason logs again.
  f.answers.set(UPDATE_STATUS, "");
  assert.deepEqual(await check(), { from: UPDATE_FROM, to: UPDATE_TO });
  f.answers.set(UPDATE_STATUS, " M src/x.ts\n");
  assert.equal(await check(), undefined);
  assert.equal(log.length, 3);
});

for (const updated of [true, false]) {
  test(`GET /api/loop reports the self-update after restart with the ${updated ? "target" : "old"} build`, async () => {
    const s = await setup({ LINEAR_API_KEY: "k" }, PAUSED_CONFIG);
    await createFilePauseStore(s.home).pause();
    const record = {
      from: "aaaaaaa1111",
      to: "bbbbbbb2222",
      at: "2026-11-21T08:00:00.000Z",
      state: "applying",
    };
    await mkdir(join(s.repo, ".harnessd", "state"), { recursive: true });
    await writeFile(
      join(s.repo, ".harnessd", "state", "loop.json"),
      JSON.stringify({ version: 1, lastPollAt: null, inFlight: [], selfUpdate: record }),
    );
    let loop: { selfUpdate?: { state: string } } = {};
    const expected = updated ? "done" : "pending";
    const code = await runLoop([], {
      ...s.io,
      selfUpdater: {
        runningCommit: updated ? record.to : record.from,
        async checkForUpdate() {
          assert.fail("the loop is paused");
        },
        async applyUpdate() {
          assert.fail("the loop is paused");
        },
      },
      stopSignal: async () => {
        const url = (await readDaemonInfo(s.home))?.url ?? "";
        await fetch(`${url}/api/start`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
        for (let i = 0; i < 100 && loop.selfUpdate?.state !== expected; i++) {
          loop = (await (await fetch(`${url}/api/loop`)).json()) as typeof loop;
          if (loop.selfUpdate?.state !== expected) await new Promise((r) => setTimeout(r, 20));
        }
        return "SIGTERM";
      },
    });
    assert.equal(code, 0);
    assert.equal(
      s.out.some((line) => line.includes("self-update: aaaaaaa -> bbbbbbb")),
      updated,
    );
    assert.equal(loop.selfUpdate?.state, expected);
    assert.deepEqual(
      { ...loop.selfUpdate, at: undefined },
      { from: record.from, to: record.to, state: expected, at: undefined },
    );
    assert.deepEqual((loop as { state?: string }).state, "running");
  });
}

test("while Claude Code is held, a codex fallback dispatches through harnessAdapters with its model", async () => {
  const s = await setup({});
  const fake = join(s.root, "fake-codex");
  await writeFile(fake, '#!/bin/sh\necho \'{"type":"turn.completed","usage":{}}\'\n');
  chmodSync(fake, 0o755);
  await writeFile(
    join(s.repo, ".harnessd", "config.toml"),
    [
      "[agents.backend]",
      'role = "backend"',
      'harness = "claude-code"',
      'model = "opus"',
      'fallback_harness = "codex"',
      'fallback_model = "gpt-5"',
      "",
      "[harnesses.codex]",
      `bin = "${fake}"`,
      "",
    ].join("\n"),
  );
  const config = await loadConfig({ globalDir: s.home, workspaceDir: join(s.repo, ".harnessd") });
  const adapters = harnessAdapters(config, "auto");
  const main = resolveAgentConfig(config, "backend");
  const hasAdapter = (h: keyof typeof adapters) => adapters[h] !== undefined;

  const available = {
    held: () => false,
    hasAdapter,
    installed: () => true,
    signedIn: () => true,
  };
  assert.equal(
    harnessForRun(main, available)[0]?.harness,
    "claude-code",
    "a free main harness runs first",
  );
  const order = harnessForRun(main, { ...available, held: (h) => h === "claude-code" });
  const agent = order[0];
  assert.equal(agent?.harness, "codex");
  assert.equal(agent?.model, "gpt-5");
  assert.deepEqual(
    harnessForRun(main, { ...available, held: () => true }),
    [],
    "a held fallback is not used",
  );

  const adapter = adapters[agent?.harness ?? "claude-code"];
  assert.equal(adapter?.id, "codex");
  const started = adapter?.start(
    { id: "MET-81", title: "t", prompt: "p", budgetMs: 10_000, model: agent?.model ?? "" },
    s.repo,
  );
  const events = [];
  for await (const event of started?.events ?? []) events.push(event);
  const first = events[0];
  assert.ok(first?.type === "start");
  assert.equal(first.argv[0], fake);
  assert.deepEqual(
    first.argv.slice(first.argv.indexOf("--model"), first.argv.indexOf("--model") + 2),
    ["--model", "gpt-5"],
  );
  assert.equal((await started?.result)?.status, "ok");
});

test("GET /api/status may cache the worktree-write check; POST /api/start checks it afresh", async () => {
  const s = await setup({ LINEAR_API_KEY: "k" }, PAUSED_CONFIG);
  await createFilePauseStore(s.home).pause();
  const fresh: (boolean | undefined)[] = [];
  let blocking = true;
  const code = await runLoop([], {
    ...s.io,
    checks: async (o) => {
      fresh.push(o.freshWorktreeWrite);
      if (blocking) return FAILING;
      return [{ id: "slack.webhook", state: "warn", detail: "not set", fix: "set it" }];
    },
    stopSignal: async () => {
      const url = (await readDaemonInfo(s.home))?.url ?? "";
      await fetch(`${url}/api/status`);
      blocking = false;
      await fetch(`${url}/api/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      return "SIGTERM";
    },
  });
  assert.equal(code, 0);
  assert.deepEqual(
    fresh,
    [true, false, true],
    "run and Start check afresh; GET /api/status may use the cache",
  );
});
