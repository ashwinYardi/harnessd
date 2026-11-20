import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { type Check, createFilePauseStore, readDaemonInfo, startDaemon } from "@harnessd/daemon";
import { run } from "./index.ts";
import { parseRunArgs, runLoop } from "./loop.ts";

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
  const s = await setup({ LINEAR_API_KEY: "k" }, PAUSED_CONFIG);
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
    ["coordinator", "backend", "frontend", "qa"],
  );
  assert.deepEqual(logs, { lines: [] });
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
  await writeFile(
    join(s.repo, ".harnessd", "state", "summary.json"),
    JSON.stringify({ version: 1, lastSentAt: "2026-01-01T00:00:00.000Z", notices: [] }),
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
