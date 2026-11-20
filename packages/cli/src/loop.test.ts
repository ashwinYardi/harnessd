import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { run } from "./index.ts";
import { parseRunArgs } from "./loop.ts";

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
  };
  return { repo, out, err, io };
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
