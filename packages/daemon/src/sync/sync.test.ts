import assert from "node:assert/strict";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { after, test } from "node:test";
import { syncRepo } from "./sync.ts";

// Golden cases: test/fixtures/sync/<case>/{global,workspace,expected}. `global` and
// `workspace` are .harnessd folders (either may be missing); `expected` is the repo
// tree sync must produce, compared byte for byte. UPDATE_GOLDEN=1 rewrites `expected`.
const FIXTURES = join(import.meta.dirname, "../../test/fixtures/sync");
const CASES = ["empty", "full"];

const roots: string[] = [];
after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/** Copies a case into a temp repo and returns the sync options for it. */
async function setup(name: string) {
  const root = await mkdtemp(join(tmpdir(), `harnessd-sync-${name}-`));
  roots.push(root);
  const repoDir = join(root, "repo");
  const workspace = join(FIXTURES, name, "workspace");
  if (await exists(workspace)) await cp(workspace, join(repoDir, ".harnessd"), { recursive: true });
  else await mkdir(join(repoDir, ".harnessd"), { recursive: true });
  return { repoDir, globalDir: join(FIXTURES, name, "global"), home: root };
}

type Entry = { kind: "file"; content: string } | { kind: "link"; target: string };

/** Every file and symlink under `dir`, keyed by `/`-separated path, skipping `.harnessd/`. */
async function snapshot(dir: string): Promise<Map<string, Entry>> {
  const out = new Map<string, Entry>();
  async function walk(current: string) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const ent of entries) {
      const full = join(current, ent.name);
      const rel = relative(dir, full).split("\\").join("/");
      if (rel === ".harnessd") continue;
      if (ent.isSymbolicLink()) out.set(rel, { kind: "link", target: await readlink(full) });
      else if (ent.isDirectory()) await walk(full);
      else out.set(rel, { kind: "file", content: await readFile(full, "utf8") });
    }
  }
  await walk(dir);
  return new Map([...out].sort(([a], [b]) => (a < b ? -1 : 1)));
}

for (const name of CASES) {
  test(`golden: ${name}`, async () => {
    const options = await setup(name);
    const { changed } = await syncRepo(options);
    const expectedDir = join(FIXTURES, name, "expected");
    if (process.env.UPDATE_GOLDEN === "1") {
      await rm(expectedDir, { recursive: true, force: true });
      await cp(options.repoDir, expectedDir, {
        recursive: true,
        verbatimSymlinks: true,
        filter: (src) => relative(options.repoDir, src) !== ".harnessd",
      });
    }
    const actual = await snapshot(options.repoDir);
    const expected = await snapshot(expectedDir);
    assert.deepEqual([...actual.keys()], [...expected.keys()]);
    for (const [path, entry] of expected) assert.deepEqual(actual.get(path), entry, path);
    assert.deepEqual([...changed].sort(), [...expected.keys()]);

    const claude = await lstat(join(options.repoDir, "CLAUDE.md"));
    assert.ok(claude.isSymbolicLink(), "CLAUDE.md is a symlink");
    assert.equal(await readlink(join(options.repoDir, "CLAUDE.md")), "AGENTS.md");
  });

  test(`idempotent: ${name} second sync changes nothing`, async () => {
    const options = await setup(name);
    assert.notDeepEqual((await syncRepo(options)).changed, []);
    const before = await snapshot(options.repoDir);
    assert.deepEqual((await syncRepo(options)).changed, []);
    assert.deepEqual(await snapshot(options.repoDir), before);
  });
}

test("an edit to .harnessd/ rewrites only the files it affects", async () => {
  const options = await setup("full");
  await syncRepo(options);
  await writeFile(join(options.repoDir, ".harnessd", "AGENTS.md"), "Changed.\n");
  assert.deepEqual((await syncRepo(options)).changed, ["AGENTS.md"]);
});

test("a hand-edited native file is put back", async () => {
  const options = await setup("full");
  await syncRepo(options);
  await writeFile(join(options.repoDir, ".mcp.json"), "{}\n");
  await rm(join(options.repoDir, "CLAUDE.md"));
  await writeFile(join(options.repoDir, "CLAUDE.md"), "a copy, not a link\n");
  assert.deepEqual((await syncRepo(options)).changed, ["CLAUDE.md", ".mcp.json"]);
  assert.ok((await lstat(join(options.repoDir, "CLAUDE.md"))).isSymbolicLink());
});

test("sync refuses a repo without .harnessd/", async () => {
  const root = await mkdtemp(join(tmpdir(), "harnessd-sync-none-"));
  roots.push(root);
  await writeFile(join(root, "AGENTS.md"), "hand-written\n");
  await assert.rejects(
    syncRepo({ repoDir: root, globalDir: join(root, "global") }),
    /no \.harnessd\/ folder/,
  );
  assert.equal(await readFile(join(root, "AGENTS.md"), "utf8"), "hand-written\n");
});

test("a skill folder sync did not generate is kept untouched and reported", async () => {
  const options = await setup("full");
  const mine = join(options.repoDir, ".claude", "skills", "deploy");
  await mkdir(mine, { recursive: true });
  await writeFile(join(mine, "SKILL.md"), "---\nname: deploy\n---\nHand-vendored.\n");
  const { changed, skipped } = await syncRepo(options);
  assert.deepEqual(skipped, [".claude/skills/deploy"]);
  assert.ok(!changed.some((p) => p.startsWith(".claude/skills/deploy/")));
  assert.ok(changed.includes(".agents/skills/deploy/SKILL.md"));
  assert.equal(
    await readFile(join(mine, "SKILL.md"), "utf8"),
    "---\nname: deploy\n---\nHand-vendored.\n",
  );
  assert.ok(!(await exists(join(mine, "reference.md"))));
});

test("a workspace can turn off a global skill", async () => {
  const options = await setup("full");
  await writeFile(
    join(options.repoDir, ".harnessd", "config.toml"),
    "[skills.deploy]\nenabled = false\n",
  );
  const { changed } = await syncRepo(options);
  assert.ok(!changed.some((p) => p.includes("skills/deploy/")));
});

/** The Impeccable-style native folder in a temp global skill. */
const HOOK_GROUP = {
  matcher: "Edit|Write",
  hooks: [{ type: "command", command: "scan", timeout: 5 }],
};

async function withNativeSkill(options: Awaited<ReturnType<typeof setup>>) {
  const globalDir = join(options.home, "global");
  await cp(options.globalDir, globalDir, { recursive: true });
  const native = join(globalDir, "skills", "ui", ".harnessd-native");
  await mkdir(join(native, "claude-agents"), { recursive: true });
  await writeFile(join(globalDir, "skills", "ui", "SKILL.md"), "Design.\n");
  await writeFile(
    join(native, "hooks.json"),
    JSON.stringify({ claude: { PostToolUse: [HOOK_GROUP] }, codex: { PostToolUse: [HOOK_GROUP] } }),
  );
  await writeFile(
    join(native, "claude-agents", "ui-reviewer.md"),
    "---\nname: ui-reviewer\n---\nReview.\n",
  );
  return { ...options, globalDir };
}

test("sync merges skill hooks into user settings and keeps them over two runs", async () => {
  const options = await withNativeSkill(await setup("full"));
  const mine = { matcher: "Bash", hooks: [{ type: "command", command: "audit" }] };
  await mkdir(join(options.repoDir, ".claude"), { recursive: true });
  await writeFile(
    join(options.repoDir, ".claude", "settings.json"),
    JSON.stringify({ permissions: { allow: ["Bash(ls)"] }, hooks: { PreToolUse: [mine] } }),
  );
  const { changed } = await syncRepo(options);
  assert.ok(changed.includes(".codex/hooks.json"));
  assert.ok(changed.includes(".claude/agents/ui-reviewer.md"));
  const read = async (p: string) => JSON.parse(await readFile(join(options.repoDir, p), "utf8"));
  const settings = await read(".claude/settings.json");
  assert.deepEqual(settings.permissions, { allow: ["Bash(ls)"] });
  assert.deepEqual(settings.hooks, { PreToolUse: [mine], PostToolUse: [HOOK_GROUP] });
  assert.deepEqual((await read(".codex/hooks.json")).hooks, { PostToolUse: [HOOK_GROUP] });
  const before = await snapshot(options.repoDir);
  assert.deepEqual((await syncRepo(options)).changed, []);
  assert.deepEqual(await snapshot(options.repoDir), before);
});

test("a workspace that turns the skill off gets no hook and no agent", async () => {
  const options = await withNativeSkill(await setup("full"));
  await writeFile(
    join(options.repoDir, ".harnessd", "config.toml"),
    "[skills.ui]\nenabled = false\n",
  );
  await syncRepo(options);
  const settings = JSON.parse(
    await readFile(join(options.repoDir, ".claude", "settings.json"), "utf8"),
  );
  assert.equal(settings.hooks, undefined);
  assert.ok(!(await exists(join(options.repoDir, ".codex", "hooks.json"))));
  assert.ok(!(await exists(join(options.repoDir, ".claude", "agents", "ui-reviewer.md"))));
});

test("an agent file sync did not generate is kept and reported", async () => {
  const options = await withNativeSkill(await setup("full"));
  const agents = join(options.repoDir, ".claude", "agents");
  await mkdir(agents, { recursive: true });
  await writeFile(join(agents, "ui-reviewer.md"), "Hand-installed.\n");
  await writeFile(join(agents, "mine.md"), "Mine.\n");
  const { changed, skipped } = await syncRepo(options);
  assert.deepEqual(skipped, [".claude/agents/ui-reviewer.md"]);
  assert.ok(!changed.includes(".claude/agents/ui-reviewer.md"));
  assert.equal(await readFile(join(agents, "ui-reviewer.md"), "utf8"), "Hand-installed.\n");
  assert.equal(await readFile(join(agents, "mine.md"), "utf8"), "Mine.\n");
});

test("a .claude/settings.json that is not JSON stops sync and is left alone", async () => {
  const options = await setup("full");
  await mkdir(join(options.repoDir, ".claude"), { recursive: true });
  await writeFile(join(options.repoDir, ".claude", "settings.json"), "{ not json");
  await assert.rejects(syncRepo(options), /\.claude\/settings\.json/);
  assert.equal(
    await readFile(join(options.repoDir, ".claude", "settings.json"), "utf8"),
    "{ not json",
  );
});

test("an agent file with the note only below a body rule is not sync's own", async () => {
  const options = await withNativeSkill(await setup("full"));
  const agents = join(options.repoDir, ".claude", "agents");
  await mkdir(agents, { recursive: true });
  const text = `Mine.\n\n---\n<!-- Generated by \`harnessd sync\`. Do not edit: change .harnessd/ and run \`harnessd sync\`. -->\n`;
  await writeFile(join(agents, "ui-reviewer.md"), text);
  const { skipped } = await syncRepo(options);
  assert.deepEqual(skipped, [".claude/agents/ui-reviewer.md"]);
  assert.equal(await readFile(join(agents, "ui-reviewer.md"), "utf8"), text);
});
