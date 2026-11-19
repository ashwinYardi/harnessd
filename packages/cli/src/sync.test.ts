import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { run } from "./index.ts";

const roots: string[] = [];
after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

/** A repo with .harnessd/ and a fake global folder passed through HARNESSD_HOME. */
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "harnessd-cli-sync-"));
  roots.push(root);
  const repo = join(root, "repo");
  const home = join(root, "global");
  await mkdir(join(repo, ".harnessd"), { recursive: true });
  await mkdir(home, { recursive: true });
  await writeFile(join(home, "AGENTS.md"), "Global note.\n");
  await writeFile(join(repo, ".harnessd", "AGENTS.md"), "Repo note.\n");
  const out: string[] = [];
  const err: string[] = [];
  const io = {
    out: (l: string) => out.push(l),
    err: (l: string) => err.push(l),
    cwd: repo,
    env: { HARNESSD_HOME: home },
  };
  return { repo, home, out, err, io };
}

test("sync writes the cwd repo from HARNESSD_HOME and the repo, then reports no changes", async () => {
  const s = await setup();
  assert.equal(await run(["sync"], s.io), 0, s.err.join("\n"));
  assert.ok(s.out.includes("wrote AGENTS.md"));
  assert.equal(s.out.at(-1), `${s.out.length - 1} changed`);
  const agents = await readFile(join(s.repo, "AGENTS.md"), "utf8");
  assert.ok(agents.indexOf("Global note.") < agents.indexOf("Repo note."));
  assert.ok((await lstat(join(s.repo, "CLAUDE.md"))).isSymbolicLink());

  s.out.length = 0;
  assert.equal(await run(["sync"], s.io), 0);
  assert.deepEqual(s.out, ["no changes"]);
});

test("sync takes a repo dir argument", async () => {
  const s = await setup();
  assert.equal(await run(["sync", s.repo], { ...s.io, cwd: "/" }), 0, s.err.join("\n"));
  assert.ok((await lstat(join(s.repo, ".codex", "config.toml"))).isFile());
});

test("sync fails with the file and key on a bad config", async () => {
  const s = await setup();
  await writeFile(join(s.home, "config.toml"), '[mcp.x]\nargs = ["a"]\n');
  assert.equal(await run(["sync"], s.io), 1);
  assert.match(s.err[0] ?? "", /config\.toml: mcp\.x\.command: required/);
});

test("sync outside a .harnessd repo exits 1 and writes nothing", async () => {
  const s = await setup();
  await rm(join(s.repo, ".harnessd"), { recursive: true });
  assert.equal(await run(["sync"], s.io), 1);
  assert.match(s.err[0] ?? "", /no \.harnessd\/ folder/);
  await assert.rejects(lstat(join(s.repo, "AGENTS.md")));
});
