import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { buildPack, PACK, PACK_FORMAT } from "./pack.ts";

const REPO = join(import.meta.dirname, "../../..");
const VENDORED = join(REPO, ".claude/skills");

const roots: string[] = [];
after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

/** The skills and commits VENDORED.md lists: the human-kept source of truth. */
async function vendoredTable(): Promise<Map<string, string>> {
  const text = await readFile(join(VENDORED, "VENDORED.md"), "utf8");
  const out = new Map<string, string>();
  for (const line of text.split("\n")) {
    const cells = line.split("|").map((c) => c.trim());
    const commit = /`([0-9a-f]{40})`/.exec(cells[3] ?? "")?.[1];
    if (commit === undefined) continue;
    for (const name of (cells[1] ?? "").split(","))
      out.set(name.trim().split(" ")[0] ?? "", commit);
  }
  return out;
}

test("the pack lists exactly the skills and commits in VENDORED.md", async () => {
  const table = await vendoredTable();
  assert.equal(table.size, 14);
  assert.deepEqual(new Map(PACK.map((s) => [s.name, s.commit])), table);
});

test("buildPack copies each whole skill folder with its licence, marker and a manifest", async () => {
  const out = await mkdtemp(join(tmpdir(), "harnessd-pack-"));
  roots.push(out);
  await buildPack(VENDORED, out);
  const manifest = JSON.parse(await readFile(join(out, "pack.json"), "utf8"));
  assert.equal(manifest.length, 14);
  assert.deepEqual(manifest[0], {
    name: "code-review",
    upstream: "mattpocock/skills",
    commit: "abeeaf95660ba9e8b7c753eb38f441ca707a8823",
  });
  for (const skill of PACK) {
    const files = await readdir(join(out, skill.name));
    assert.ok(files.includes("SKILL.md"), skill.name);
    assert.ok(files.includes("LICENSE"), `${skill.name} has its licence`);
    const marker = JSON.parse(await readFile(join(out, skill.name, ".harnessd-pack"), "utf8"));
    assert.equal(marker.commit, skill.commit);
  }
  assert.match(await readFile(join(out, "tdd", "LICENSE"), "utf8"), /MIT License/);
  assert.match(await readFile(join(out, "impeccable", "LICENSE"), "utf8"), /Apache License/);
  assert.ok((await readdir(join(out, "impeccable"))).includes("NOTICE.md"));
  // Extra files and the executable bit come along.
  assert.ok((await readdir(join(out, "tdd"))).includes("tests.md"));
  assert.equal((await stat(join(out, "impeccable", "scripts", "impeccable"))).mode & 0o100, 0o100);
});

test("impeccable ships its design hook and its Claude Code agents, as the repo installs them", async () => {
  const out = await mkdtemp(join(tmpdir(), "harnessd-pack-"));
  roots.push(out);
  await buildPack(VENDORED, out);
  const native = join(out, "impeccable", ".harnessd-native");
  const hooks = JSON.parse(await readFile(join(native, "hooks.json"), "utf8"));
  // The repo's .claude/settings.json is what `npx impeccable install` wrote (VENDORED.md).
  const settings = JSON.parse(await readFile(join(REPO, ".claude/settings.json"), "utf8"));
  assert.deepEqual(hooks.claude, settings.hooks);
  assert.deepEqual(Object.keys(hooks.claude), ["SessionStart", "PostToolUse", "Stop"]);
  assert.deepEqual(Object.keys(hooks.codex), ["PostToolUse", "Stop"]);
  assert.match(
    hooks.codex.Stop[0].hooks[0].command,
    /\.agents\/skills\/impeccable\/scripts\/impeccable/,
  );
  const agents = (await readdir(join(REPO, ".claude/agents"))).filter((n) =>
    n.startsWith("impeccable-"),
  );
  assert.equal(agents.length, 5);
  assert.deepEqual((await readdir(join(native, "claude-agents"))).sort(), agents.sort());
  for (const name of agents) {
    assert.equal(
      await readFile(join(native, "claude-agents", name), "utf8"),
      await readFile(join(REPO, ".claude/agents", name), "utf8"),
    );
  }
  // Only impeccable has harness files; every marker names the pack format.
  await assert.rejects(stat(join(out, "tdd", ".harnessd-native")));
  const marker = JSON.parse(await readFile(join(out, "tdd", ".harnessd-pack"), "utf8"));
  assert.equal(marker.format, PACK_FORMAT);
});
