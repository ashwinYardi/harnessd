import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  findRepoRoot,
  formatFrontmatter,
  listNotes,
  normalizeNotePath,
  readNote,
  searchNotes,
  VaultError,
  vaultDirs,
  writeNote,
} from "./vault.ts";

const roots: string[] = [];
after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "harnessd-vault-"));
  roots.push(root);
  return root;
}

test("vaultDirs puts vaults under the global folder and the repo's .harnessd/", () => {
  assert.deepEqual(vaultDirs("/g"), { global: "/g/vault" });
  assert.deepEqual(vaultDirs("/g", "/r"), { global: "/g/vault", workspace: "/r/.harnessd/vault" });
});

test("findRepoRoot walks up to a .harnessd/ folder but skips the global one", async () => {
  const root = await tempDir();
  await mkdir(join(root, "home", ".harnessd"), { recursive: true });
  await mkdir(join(root, "home", "repo", ".harnessd"), { recursive: true });
  await mkdir(join(root, "home", "repo", "src", "deep"), { recursive: true });
  await mkdir(join(root, "home", "other"), { recursive: true });
  const globalDir = join(root, "home", ".harnessd");
  assert.equal(
    await findRepoRoot(join(root, "home", "repo", "src", "deep"), globalDir),
    join(root, "home", "repo"),
  );
  assert.equal(await findRepoRoot(join(root, "home", "other"), globalDir), undefined);
});

test("write, read and list notes; .md is optional and folders are created", async () => {
  const vault = join(await tempDir(), "vault");
  assert.equal(
    await writeNote(vault, "projects/harnessd", "Daemon notes."),
    "projects/harnessd.md",
  );
  assert.equal(await writeNote(vault, "inbox.md", "One\n"), "inbox.md");
  assert.deepEqual(await readNote(vault, "projects/harnessd.md"), {
    path: "projects/harnessd.md",
    content: "Daemon notes.\n",
  });
  await writeNote(vault, "projects/harnessd", "Overwritten.");
  assert.equal((await readNote(vault, "projects/harnessd")).content, "Overwritten.\n");
  await mkdir(join(vault, ".obsidian"), { recursive: true });
  await writeFile(join(vault, ".obsidian", "app.md"), "hidden");
  await writeFile(join(vault, "image.png"), "");
  assert.deepEqual(await listNotes(vault), ["inbox.md", "projects/harnessd.md"]);
  assert.deepEqual(await listNotes(join(vault, "missing")), []);
  await assert.rejects(
    readNote(vault, "nope"),
    (e) => e instanceof VaultError && /no note at nope\.md/.test(e.message),
  );
});

test("write_note frontmatter is YAML that Obsidian reads", async () => {
  const vault = join(await tempDir(), "vault");
  await writeNote(vault, "n", "Body", {
    title: "Build: notes",
    tags: ["ci", "build"],
    count: 2,
    draft: false,
  });
  assert.equal(
    await readFile(join(vault, "n.md"), "utf8"),
    '---\ntitle: "Build: notes"\ntags:\n  - ci\n  - build\ncount: 2\ndraft: false\n---\n\nBody\n',
  );
  await assert.rejects(
    writeNote(vault, "n", "---\nx: 1\n---\n", { a: "b" }),
    /already starts with frontmatter/,
  );
  assert.throws(() => formatFrontmatter({ "bad key": "x" }), VaultError);
  assert.throws(() => formatFrontmatter({ n: Number.NaN }), VaultError);
});

test("paths that could leave the vault are rejected", async () => {
  const root = await tempDir();
  const vault = join(root, "vault");
  await writeFile(join(root, "secret.md"), "outside");
  for (const bad of [
    "../secret",
    "a/../../secret",
    "/etc/passwd",
    "..",
    "a/./b",
    ".obsidian/app",
    "a\\..\\secret",
    "a\u0000b",
    "",
    "   ",
  ]) {
    assert.throws(() => normalizeNotePath(bad), VaultError, JSON.stringify(bad));
    await assert.rejects(readNote(vault, bad), VaultError, JSON.stringify(bad));
    await assert.rejects(writeNote(vault, bad, "x"), VaultError, JSON.stringify(bad));
  }
  assert.equal(await readFile(join(root, "secret.md"), "utf8"), "outside");
});

test("a symlink inside the vault cannot be used to escape it", async () => {
  const root = await tempDir();
  const vault = join(root, "vault");
  await mkdir(join(root, "outside"), { recursive: true });
  await writeFile(join(root, "outside", "x.md"), "outside");
  await mkdir(vault, { recursive: true });
  await symlink(join(root, "outside"), join(vault, "link"));
  await assert.rejects(readNote(vault, "link/x"), /escapes the vault/);
  await assert.rejects(writeNote(vault, "link/y", "x"), /escapes the vault/);
});

test("search is case-insensitive, ranks title and phrase hits first, and returns snippets", async () => {
  const vault = join(await tempDir(), "vault");
  await writeNote(vault, "deploy/Staging Deploy", "How we deploy to staging.");
  await writeNote(
    vault,
    "notes/misc",
    `${"filler ".repeat(40)}the staging DEPLOY once broke. ${"tail ".repeat(40)}`,
  );
  await writeNote(vault, "notes/only-staging", "Staging has its own database.");
  await writeNote(vault, "notes/unrelated", "Nothing to see.");
  const hits = await searchNotes(vault, "Staging deploy");
  assert.deepEqual(
    hits.map((h) => h.path),
    ["deploy/Staging Deploy.md", "notes/misc.md", "notes/only-staging.md"],
  );
  assert.equal(hits[0]?.title, "Staging Deploy");
  const misc = hits[1]?.snippet ?? "";
  assert.match(misc, /^….*the staging DEPLOY once broke.*…$/);
  assert.ok(misc.length <= 162);
  assert.equal((await searchNotes(vault, "staging", 1)).length, 1);
  assert.deepEqual(await searchNotes(vault, "kubernetes"), []);
  await assert.rejects(searchNotes(vault, "  "), VaultError);
});

test("search snippets skip frontmatter", async () => {
  const vault = join(await tempDir(), "vault");
  await writeNote(vault, "a", "Body mentions redis.", { tags: ["redis"] });
  const [hit] = await searchNotes(vault, "redis");
  assert.equal(hit?.snippet, "Body mentions redis.");
});
