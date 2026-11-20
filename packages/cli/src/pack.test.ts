import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { buildPack, PACK } from "./pack.ts";

const VENDORED = join(import.meta.dirname, "../../../.claude/skills");

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
