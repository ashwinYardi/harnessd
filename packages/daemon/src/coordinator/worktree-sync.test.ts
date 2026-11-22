import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { excludeLine, syncWorktree, withheldSkills } from "./worktree-sync.ts";

const roots: string[] = [];
after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

function git(cwd: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

/**
 * A main repo with a `.harnessd/` layer, a worktree of it that tracks AGENTS.md, a
 * global folder with one skill, and an owner's global excludes file.
 */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "harnessd-wtsync-"));
  roots.push(root);
  const repo = join(root, "repo");
  const globalDir = join(root, "global");
  await mkdir(join(repo, ".harnessd"), { recursive: true });
  await writeFile(join(repo, ".harnessd", "AGENTS.md"), "Workspace rules.\n");
  await writeFile(join(repo, "AGENTS.md"), "Committed by hand.\n");
  await writeFile(join(repo, ".gitignore"), ".harnessd/\n");
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["add", "AGENTS.md", ".gitignore"]);
  git(repo, ["commit", "-q", "-m", "init"]);
  await mkdir(join(globalDir, "skills", "tdd"), { recursive: true });
  await writeFile(
    join(globalDir, "skills", "tdd", "SKILL.md"),
    "---\nname: tdd\n---\nRed first.\n",
  );
  const worktree = join(root, "wt");
  git(repo, ["worktree", "add", "-q", "-b", "met-1", worktree]);
  const ownerIgnore = join(root, "owner-ignore");
  await writeFile(ownerIgnore, "*.swp\n");
  git(worktree, ["config", "core.excludesFile", ownerIgnore]);
  return { root, repo, globalDir, worktree, ownerIgnore };
}

test("sync writes the pack into the worktree and git status stays clean", async () => {
  const f = await fixture();
  const { env, changed, excludesFile } = await syncWorktree({
    repoDir: f.repo,
    globalDir: f.globalDir,
    worktree: f.worktree,
    runId: "MET-1-1",
    // Use the fixture repo's excludes even when a builder run sets its own.
    env: { ...process.env, GIT_CONFIG_COUNT: "0" },
  });
  assert.ok(changed.includes(".claude/skills/tdd/SKILL.md"));
  assert.ok(changed.includes("AGENTS.md"));
  assert.match(await readFile(join(f.worktree, "AGENTS.md"), "utf8"), /Workspace rules/);
  // Outside the worktree, under the global state folder.
  assert.ok(excludesFile.startsWith(join(f.globalDir, "state")));
  assert.equal(git(f.worktree, ["status", "--porcelain", "--untracked-files=all"], env), "");
  // The owner's own excludes still apply.
  await writeFile(join(f.worktree, "x.swp"), "");
  assert.equal(git(f.worktree, ["status", "--porcelain", "--untracked-files=all"], env), "");
  // A real change still shows.
  await writeFile(join(f.worktree, "src.ts"), "x\n");
  assert.equal(git(f.worktree, ["status", "--porcelain"], env), "?? src.ts\n");
  // `git add -A` does not pick the generated files up.
  git(f.worktree, ["add", "-A"], env);
  assert.equal(git(f.worktree, ["diff", "--cached", "--name-only"], env), "src.ts\n");
});

test("nothing shared changes: not .git/info/exclude, not the repo config", async () => {
  const f = await fixture();
  const commonDir = git(f.repo, ["rev-parse", "--git-common-dir"]).trim();
  const exclude = join(f.repo, commonDir, "info", "exclude");
  const before = await readFile(exclude, "utf8").catch(() => "");
  const config = await readFile(join(f.repo, commonDir, "config"), "utf8");
  await syncWorktree({ repoDir: f.repo, globalDir: f.globalDir, worktree: f.worktree, runId: "r" });
  assert.equal(await readFile(exclude, "utf8").catch(() => ""), before);
  assert.equal(await readFile(join(f.repo, commonDir, "config"), "utf8"), config);
  // The main checkout still sees its own AGENTS.md as tracked and unflagged.
  assert.equal(git(f.repo, ["ls-files", "-v", "AGENTS.md"]), "H AGENTS.md\n");
  assert.equal(git(f.worktree, ["ls-files", "-v", "AGENTS.md"]), "S AGENTS.md\n");
});

test("a second sync of a resumed worktree still lists every generated path", async () => {
  const f = await fixture();
  const input = { repoDir: f.repo, globalDir: f.globalDir, worktree: f.worktree, runId: "a" };
  await syncWorktree(input);
  const again = await syncWorktree({ ...input, runId: "b" });
  assert.deepEqual(again.changed, []);
  assert.equal(git(f.worktree, ["status", "--porcelain", "--untracked-files=all"], again.env), "");
});

test("the env sets core.excludesFile after any git config the daemon already has", async () => {
  const f = await fixture();
  const { env, excludesFile } = await syncWorktree({
    repoDir: f.repo,
    globalDir: f.globalDir,
    worktree: f.worktree,
    runId: "r",
    env: {
      ...process.env,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "color.ui",
      GIT_CONFIG_VALUE_0: "never",
    },
  });
  assert.deepEqual(env, {
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_1: "core.excludesFile",
    GIT_CONFIG_VALUE_1: excludesFile,
  });
});

test("a sync error throws before anything is written", async () => {
  const f = await fixture();
  await rm(join(f.repo, ".harnessd"), { recursive: true });
  await assert.rejects(
    syncWorktree({ repoDir: f.repo, globalDir: f.globalDir, worktree: f.worktree, runId: "r" }),
    /no \.harnessd\/ folder/,
  );
  assert.equal(await readFile(join(f.worktree, "AGENTS.md"), "utf8"), "Committed by hand.\n");
});

test("excludeLine anchors a path and escapes gitignore syntax", () => {
  assert.equal(excludeLine(".mcp.json"), "/.mcp.json");
  assert.equal(excludeLine(".claude/skills/a*b/#x!.md"), "/.claude/skills/a\\*b/\\#x\\!.md");
  assert.equal(excludeLine("a/b "), "/a/b\\ ");
});

test("an OpenCode run in a repo with no harness files gets AGENTS.md, the skills and the memory server", async () => {
  const root = await mkdtemp(join(tmpdir(), "harnessd-wtsync-bare-"));
  roots.push(root);
  const repo = join(root, "repo");
  const globalDir = join(root, "global");
  await mkdir(join(repo, ".harnessd"), { recursive: true });
  await writeFile(join(repo, ".harnessd", "AGENTS.md"), "Workspace rules.\n");
  await writeFile(join(repo, "README.md"), "# app\n");
  await writeFile(join(repo, ".gitignore"), ".harnessd/\n");
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["add", "README.md", ".gitignore"]);
  git(repo, ["commit", "-q", "-m", "init"]);
  await mkdir(join(globalDir, "skills", "tdd"), { recursive: true });
  await writeFile(
    join(globalDir, "skills", "tdd", "SKILL.md"),
    "---\nname: tdd\n---\nRed first.\n",
  );
  const worktree = join(root, "wt");
  git(repo, ["worktree", "add", "-q", "-b", "met-2", worktree]);

  const { env } = await syncWorktree({ repoDir: repo, globalDir, worktree, runId: "MET-2-1" });
  assert.match(await readFile(join(worktree, "AGENTS.md"), "utf8"), /Workspace rules/);
  // OpenCode 2.x reads skills from .claude/skills/ and .agents/skills/.
  for (const dir of [".claude/skills", ".agents/skills"]) {
    assert.match(await readFile(join(worktree, dir, "tdd", "SKILL.md"), "utf8"), /Red first/);
  }
  const opencode = JSON.parse(await readFile(join(worktree, "opencode.json"), "utf8"));
  assert.equal(opencode.$schema, "https://opencode.ai/config.json");
  assert.deepEqual(opencode.mcp["harnessd-memory"], {
    type: "local",
    command: ["harnessd", "mcp", "memory", "--workspace", repo],
    enabled: true,
  });
  assert.equal(git(worktree, ["status", "--porcelain", "--untracked-files=all"], env), "");
});

test("a worktree run gets its role's skill set and only the memory MCP server", async () => {
  const f = await fixture();
  await mkdir(join(f.globalDir, "skills", "impeccable"), { recursive: true });
  await writeFile(
    join(f.globalDir, "skills", "impeccable", "SKILL.md"),
    "---\nname: impeccable\n---\nDesign well.\n",
  );
  await writeFile(
    join(f.repo, ".harnessd", "config.toml"),
    '[mcp.docs]\ncommand = "npx"\nargs = ["-y", "docs-mcp"]\n',
  );

  await syncWorktree({
    repoDir: f.repo,
    globalDir: f.globalDir,
    worktree: f.worktree,
    runId: "backend-run",
    agent: { role: "backend" },
  });
  const skill = (name: string) => join(f.worktree, ".claude", "skills", name, "SKILL.md");
  const exists = (path: string) =>
    readFile(path, "utf8").then(
      () => true,
      () => false,
    );
  assert.equal(await exists(skill("tdd")), true);
  assert.equal(await exists(skill("impeccable")), false, "a backend run has no impeccable");
  const mcp = JSON.parse(await readFile(join(f.worktree, ".mcp.json"), "utf8"));
  assert.deepEqual(Object.keys(mcp.mcpServers), ["harnessd-memory"]);

  await syncWorktree({
    repoDir: f.repo,
    globalDir: f.globalDir,
    worktree: f.worktree,
    runId: "frontend-run",
    agent: { role: "frontend" },
  });
  assert.equal(await exists(skill("impeccable")), true, "the UI run gets the full pack");
});

test("a committed skill folder is withheld from a non-UI run and git stays clean", async () => {
  // A worktree cut from main already holds the skills the repo commits, so omitting the
  // skill from the generated pack is not enough (D-040).
  const root = await mkdtemp(join(tmpdir(), "harnessd-wtsync-committed-"));
  roots.push(root);
  const repo = join(root, "repo");
  const globalDir = join(root, "global");
  await mkdir(join(repo, ".harnessd"), { recursive: true });
  await writeFile(join(repo, ".harnessd", "AGENTS.md"), "Workspace rules.\n");
  await mkdir(join(repo, ".claude", "skills", "impeccable"), { recursive: true });
  await mkdir(join(repo, ".agents", "skills", "impeccable"), { recursive: true });
  await mkdir(join(repo, ".claude", "skills", "tdd"), { recursive: true });
  const skill = "---\nname: x\n---\nBody.\n";
  await writeFile(join(repo, ".claude", "skills", "impeccable", "SKILL.md"), skill);
  await writeFile(join(repo, ".agents", "skills", "impeccable", "SKILL.md"), skill);
  await writeFile(join(repo, ".claude", "skills", "tdd", "SKILL.md"), skill);
  await writeFile(join(repo, ".gitignore"), ".harnessd/\n");
  // Ignore the run's own excludes env: it can hide `.agents/` from `git add`.
  const cleanEnv = { ...process.env, GIT_CONFIG_COUNT: "0" };
  git(repo, ["init", "-q", "-b", "main"], cleanEnv);
  git(repo, ["add", "-A"], cleanEnv);
  git(repo, ["commit", "-q", "-m", "init"], cleanEnv);
  await mkdir(join(globalDir, "skills", "tdd"), { recursive: true });
  await writeFile(join(globalDir, "skills", "tdd", "SKILL.md"), skill);

  const backend = join(root, "wt-backend");
  git(repo, ["worktree", "add", "-q", "-b", "met-3", backend], cleanEnv);
  const { env, removed } = await syncWorktree({
    repoDir: repo,
    globalDir,
    worktree: backend,
    runId: "backend-run",
    agent: { role: "backend" },
  });
  assert.deepEqual(removed, [".claude/skills/impeccable", ".agents/skills/impeccable"]);
  const exists = (path: string) =>
    readFile(path, "utf8").then(
      () => true,
      () => false,
    );
  for (const dir of [".claude/skills", ".agents/skills"]) {
    assert.equal(await exists(join(backend, dir, "impeccable", "SKILL.md")), false, dir);
  }
  assert.equal(await exists(join(backend, ".claude/skills/tdd/SKILL.md")), true);
  assert.equal(git(backend, ["status", "--porcelain", "--untracked-files=all"], env), "");
  git(backend, ["add", "-A"], env);
  assert.equal(git(backend, ["diff", "--cached", "--name-only"], env), "");
  // The main checkout keeps the committed folder.
  assert.equal(await exists(join(repo, ".claude/skills/impeccable/SKILL.md")), true);

  // A later frontend run in the same worktree gets the committed folder back.
  await syncWorktree({
    repoDir: repo,
    globalDir,
    worktree: backend,
    runId: "frontend-again",
    agent: { role: "frontend" },
  });
  assert.equal(await exists(join(backend, ".claude/skills/impeccable/SKILL.md")), true);
  assert.equal(git(backend, ["status", "--porcelain", "--untracked-files=all"], env), "");
});

test("each role gets only the skills its work needs (D-040, D-043, D-044)", () => {
  // The frontend run keeps impeccable and drops the coordinator's four skills, the
  // grill and the review (QA reviews).
  assert.deepEqual(withheldSkills("frontend"), [
    "grilling",
    "domain-modeling",
    "research",
    "prototype",
    "grill-with-docs",
    "code-review",
  ]);
  // The coordinator keeps those four and grill-with-docs, and drops the UI skill and review.
  assert.deepEqual(withheldSkills("coordinator"), ["impeccable", "code-review"]);
  // A builder drops everything but keeps its own build skills.
  assert.deepEqual(withheldSkills("backend"), [
    "impeccable",
    "grilling",
    "domain-modeling",
    "research",
    "prototype",
    "grill-with-docs",
    "code-review",
  ]);
  // QA keeps code-review and drops the grill.
  assert.deepEqual(withheldSkills("qa"), [
    "impeccable",
    "grilling",
    "domain-modeling",
    "research",
    "prototype",
    "grill-with-docs",
  ]);
  assert.equal(withheldSkills("qa").includes("code-review"), false);
  assert.equal(withheldSkills("coordinator").includes("grill-with-docs"), false);
});

test("worktree sync applies the run agent's OpenCode permissions", async () => {
  const f = await fixture();
  await syncWorktree({
    repoDir: f.repo,
    globalDir: f.globalDir,
    worktree: f.worktree,
    runId: "MET-1-1",
    agent: {
      role: "backend",
      opencode_permission: { websearch: "deny", bash: { "npm publish *": "deny" } },
    },
  });
  const config = JSON.parse(await readFile(join(f.worktree, "opencode.json"), "utf8"));
  assert.equal(config.permission.websearch, "deny");
  assert.equal(config.permission.edit, "allow");
  assert.deepEqual(config.permission.bash, {
    "*": "allow",
    "git push *": "deny",
    "npm publish *": "deny",
  });
});
