import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { writeSyncFiles } from "./write.ts";

const roots: string[] = [];
after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "harnessd-write-"));
  roots.push(root);
  return root;
}

test("writes new files and links, then reports nothing on a second run", async () => {
  const root = await tempRoot();
  const files = [
    { path: "a/b/c.txt", content: "hello\n" },
    { path: "link.md", symlinkTarget: "a/b/c.txt" },
  ];
  assert.deepEqual(await writeSyncFiles(root, files), ["a/b/c.txt", "link.md"]);
  assert.equal(await readFile(join(root, "link.md"), "utf8"), "hello\n");
  assert.equal(await readlink(join(root, "link.md")), "a/b/c.txt");
  assert.deepEqual(await writeSyncFiles(root, files), []);
});

test("a stale link target is replaced", async () => {
  const root = await tempRoot();
  await symlink("OTHER.md", join(root, "CLAUDE.md"));
  assert.deepEqual(
    await writeSyncFiles(root, [{ path: "CLAUDE.md", symlinkTarget: "AGENTS.md" }]),
    ["CLAUDE.md"],
  );
  assert.equal(await readlink(join(root, "CLAUDE.md")), "AGENTS.md");
});

test("a symlink where a file belongs is replaced, not written through", async () => {
  const root = await tempRoot();
  await writeFile(join(root, "elsewhere.txt"), "keep me\n");
  await symlink("elsewhere.txt", join(root, "AGENTS.md"));
  await writeSyncFiles(root, [{ path: "AGENTS.md", content: "new\n" }]);
  assert.ok((await lstat(join(root, "AGENTS.md"))).isFile());
  assert.equal(await readFile(join(root, "elsewhere.txt"), "utf8"), "keep me\n");
});

test("paths outside the root and directories in the way are refused", async () => {
  const root = await tempRoot();
  await assert.rejects(writeSyncFiles(root, [{ path: "../x", content: "" }]), /outside/);
  await assert.rejects(writeSyncFiles(root, [{ path: "/etc/x", content: "" }]), /outside/);
  await mkdir(join(root, "AGENTS.md"));
  await assert.rejects(
    writeSyncFiles(root, [{ path: "AGENTS.md", content: "" }]),
    /is a directory/,
  );
});
