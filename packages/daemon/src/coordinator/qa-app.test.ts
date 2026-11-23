import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseConfigFile, type QaConfig } from "@harnessd/shared";
import { appEnvironment, freePort, lastOutputLines, startQaApp } from "./qa-app.ts";

const FILE = "config.toml";

/** The environment a test hands to the app: PATH so node and sh start, plus what it names. */
function baseEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: process.env.HOME ?? tmpdir(),
    ...extra,
  };
}

/** A server that answers /ok with 204 and /go with 302, and anything else with 503. */
const HEALTH_SERVER = `const http=require("node:http");http.createServer((req,res)=>{res.statusCode=req.url==="/ok"?204:req.url==="/go"?302:503;res.end()}).listen(Number(process.env.PORT),"127.0.0.1")`;

function qaApp(overrides: Partial<QaConfig> = {}): QaConfig {
  return {
    setup_command: "",
    test_command: "pnpm test",
    kind: "web",
    start: `node -e '${HEALTH_SERVER}'`,
    url: "http://127.0.0.1:{port}",
    health: "/ok",
    ...overrides,
  };
}

/** Waits for a pid to be gone; a killed process is reaped by init a moment later. */
async function gone(pid: number, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

test("the qa table parses, and a bad table is rejected with its key (MET-177)", () => {
  const qa = {
    setup_command: "",
    test_command: "pnpm test",
    kind: "web",
    start: "pnpm dev --port {port}",
    url: "http://127.0.0.1:{port}",
    health: "/health",
    build: "pnpm build",
    seed: "pnpm seed",
    env: ["DATABASE_URL"],
  };
  assert.deepEqual(parseConfigFile({ qa }, FILE), { qa });
  assert.throws(
    () => parseConfigFile({ qa: { ...qa, url: "http://127.0.0.1:3000" } }, FILE),
    /qa\.url: expected a URL with a \{port\} placeholder/,
  );
  assert.throws(
    () => parseConfigFile({ qa: { ...qa, kind: "desktop" } }, FILE),
    /qa\.kind: expected one of web, api, cli/,
  );
});

test("health by path: a 2xx or 3xx answer passes, and the app stops", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harnessd-qa-app-"));
  try {
    for (const path of ["/ok", "/go"]) {
      const started = await startQaApp({
        qa: qaApp({ health: path }),
        cwd: dir,
        area: "backend",
        env: baseEnv(),
        healthTimeoutMs: 5_000,
        pollMs: 50,
        probeTimeoutMs: 1_000,
        graceMs: 100,
      });
      assert.equal(started.ok, true, path);
      if (!started.ok) continue;
      assert.equal(
        started.app.url,
        `http://127.0.0.1:${started.app.port}`,
        "{port} is replaced with the picked port",
      );
      await started.app.stop();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("health by command: exit 0 passes, a nonzero exit never does", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harnessd-qa-app-"));
  try {
    const started = await startQaApp({
      qa: qaApp({ start: "sleep 30", health: "node -e 'process.exit(0)'" }),
      cwd: dir,
      area: "frontend",
      env: baseEnv(),
      healthTimeoutMs: 5_000,
      pollMs: 50,
      probeTimeoutMs: 1_000,
      graceMs: 100,
    });
    assert.equal(started.ok, true);
    if (started.ok) await started.app.stop();

    const failed = await startQaApp({
      qa: qaApp({ start: "sleep 30", health: "node -e 'process.exit(1)'" }),
      cwd: dir,
      area: "backend",
      env: baseEnv(),
      healthTimeoutMs: 300,
      pollMs: 50,
      probeTimeoutMs: 200,
      graceMs: 100,
    });
    assert.equal(failed.ok, false);
    if (!failed.ok) {
      assert.equal(failed.step, "health");
      assert.match(failed.error ?? "", /did not pass within/);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a health timeout at the shortened limit stops the app and names health", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harnessd-qa-app-"));
  const pidFile = join(dir, "pid");
  try {
    const before = Date.now();
    const result = await startQaApp({
      qa: qaApp({
        start: `echo $$ > ${pidFile}; sleep 30`,
        health: "/ok",
      }),
      cwd: dir,
      area: "backend",
      env: baseEnv(),
      healthTimeoutMs: 250,
      pollMs: 50,
      probeTimeoutMs: 150,
      graceMs: 100,
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.step, "health");
      assert.match(result.error ?? "", /did not pass within \ds/);
    }
    assert.ok(Date.now() - before < 10_000, "the shortened limit is used");
    const pid = Number(await readFile(pidFile, "utf8"));
    assert.equal(await gone(pid), true, "the timed-out app is killed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a start that exits early is a start failure with its output", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harnessd-qa-app-"));
  try {
    const result = await startQaApp({
      qa: qaApp({ start: "echo starting; echo it broke >&2; exit 3" }),
      cwd: dir,
      area: "backend",
      env: baseEnv(),
      healthTimeoutMs: 5_000,
      pollMs: 50,
      probeTimeoutMs: 200,
      graceMs: 100,
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.step, "start");
      assert.equal(result.detail, "starting | it broke");
      assert.match(result.error ?? "", /exited with code 3/);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a missing worktree is a start failure, not a throw", async () => {
  const result = await startQaApp({
    qa: qaApp(),
    cwd: join(tmpdir(), "harnessd-qa-app-does-not-exist"),
    area: "backend",
    env: baseEnv(),
    healthTimeoutMs: 500,
    pollMs: 50,
    probeTimeoutMs: 200,
    graceMs: 100,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.step, "start");
});

test("a non-zero build or seed fails before start runs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harnessd-qa-app-"));
  try {
    for (const step of ["build", "seed"] as const) {
      const marker = join(dir, `${step}-started`);
      const result = await startQaApp({
        qa: qaApp({
          [step]: `echo ${step} broke; exit 2`,
          start: `touch ${marker}; sleep 30`,
        }),
        cwd: dir,
        area: "backend",
        env: baseEnv(),
        healthTimeoutMs: 1_000,
        pollMs: 50,
        probeTimeoutMs: 200,
        graceMs: 100,
      });
      assert.equal(result.ok, false, step);
      if (!result.ok) {
        assert.equal(result.step, step);
        assert.equal(result.detail, `${step} broke`);
        assert.match(result.error ?? "", /exited with code 2/);
      }
      await assert.rejects(readFile(marker, "utf8"), `${step}: start never ran`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("build, seed, start and health get only the base env, the area and qa.env names", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harnessd-qa-app-"));
  try {
    const logs: string[] = [];
    const started = await startQaApp({
      qa: qaApp({
        build: `node -e 'require("node:fs").writeFileSync("build-env.json", JSON.stringify(process.env))'`,
        start: `node -e 'require("node:fs").writeFileSync("start-env.json", JSON.stringify(process.env));setInterval(()=>{},1000)'`,
        health: "node -e 'process.exit(0)'",
        env: ["DATABASE_URL", "NOT_SET_ANYWHERE"],
      }),
      cwd: dir,
      area: "frontend",
      env: baseEnv({ LINEAR_API_KEY: "lin_secret", DATABASE_URL: "postgres://db" }),
      healthTimeoutMs: 5_000,
      pollMs: 50,
      probeTimeoutMs: 1_000,
      graceMs: 100,
      log: (line) => logs.push(line),
    });
    assert.equal(started.ok, true);
    if (!started.ok) return;
    await started.app.stop();

    const buildEnv = JSON.parse(await readFile(join(dir, "build-env.json"), "utf8"));
    // sh adds PWD, SHLVL, _ and __CF_USER_TEXT_ENCODING itself; harnessd adds nothing else.
    const shellAdded = new Set(["PWD", "SHLVL", "_", "__CF_USER_TEXT_ENCODING"]);
    assert.deepEqual(
      Object.keys(buildEnv)
        .filter((name) => !shellAdded.has(name))
        .sort(),
      ["DATABASE_URL", "HARNESSD_QA_AREA", "HOME", "PATH"],
    );
    assert.equal(buildEnv.HARNESSD_QA_AREA, "frontend");
    assert.equal(buildEnv.DATABASE_URL, "postgres://db");

    const startEnv = JSON.parse(await readFile(join(dir, "start-env.json"), "utf8"));
    assert.equal(startEnv.PORT, String(started.app.port), "start gets PORT");
    assert.equal(startEnv.LINEAR_API_KEY, undefined, "the daemon's secrets stay out");
    assert.deepEqual(logs, ["qa.env NOT_SET_ANYWHERE is not set, skipped"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("app output is masked with the daemon's secrets", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harnessd-qa-app-"));
  try {
    const result = await startQaApp({
      qa: qaApp({ start: 'echo "$LINEAR_API_KEY"; exit 1', env: ["LINEAR_API_KEY"] }),
      cwd: dir,
      area: "backend",
      env: baseEnv({ LINEAR_API_KEY: "lin_secret_value" }),
      healthTimeoutMs: 1_000,
      pollMs: 50,
      probeTimeoutMs: 200,
      graceMs: 100,
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.step, "start");
      assert.equal(result.detail, "***");
      assert.doesNotMatch(result.detail, /lin_secret_value/);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("stop kills the whole tree, including a child of a child (D-048)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harnessd-qa-app-"));
  const childPidFile = join(dir, "grandchild.pid");
  try {
    const started = await startQaApp({
      qa: qaApp({
        start: `sh -c 'sleep 30 & echo $! > ${childPidFile}; wait' & wait`,
        health: "true",
      }),
      cwd: dir,
      area: "backend",
      env: baseEnv(),
      healthTimeoutMs: 5_000,
      pollMs: 50,
      probeTimeoutMs: 1_000,
      graceMs: 100,
    });
    assert.equal(started.ok, true);
    if (!started.ok) return;
    // The app's inner sh writes the grandchild pid a moment after health passes.
    let grandchild = 0;
    for (let i = 0; i < 80 && grandchild === 0; i++) {
      try {
        grandchild = Number(await readFile(childPidFile, "utf8"));
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    assert.ok(grandchild > 0);
    process.kill(grandchild, 0);
    await started.app.stop();
    assert.equal(await gone(grandchild), true, "the grandchild is gone after stop");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a cli runs build and seed but no server, and one health command if set", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harnessd-qa-app-"));
  try {
    const result = await startQaApp({
      qa: {
        setup_command: "",
        test_command: "pnpm test",
        kind: "cli",
        start: "echo never run",
        build: "true",
        health: "true",
      },
      cwd: dir,
      area: "backend",
      env: baseEnv(),
      healthTimeoutMs: 1_000,
      pollMs: 50,
      probeTimeoutMs: 200,
      graceMs: 100,
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.app.url, undefined);
      assert.equal(result.app.port, undefined);
      await result.app.stop();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("helpers: the base env keeps only its names, a free port is free, the tail is five lines", async () => {
  const base = baseEnv({ A_VAR: "1", OTHER: "2" });
  const env = appEnvironment({ env: ["A_VAR"] }, "backend", base);
  assert.deepEqual(env, {
    PATH: base.PATH,
    HOME: base.HOME,
    HARNESSD_QA_AREA: "backend",
    A_VAR: "1",
  });
  const port = await freePort();
  assert.ok(port > 0);
  assert.equal(
    lastOutputLines("one\ntwo\nthree\nfour\nfive\nsix\n", baseEnv()),
    "two | three | four | five | six",
  );
});
