import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { ConfigError } from "@harnessd/shared";
import { parseFrontmatter } from "./frontmatter.ts";
import { loadConfig, loadLayer } from "./load.ts";
import { resolveAgentConfig } from "./merge.ts";

const roots: string[] = [];
after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

/** Creates a fake home with `.harnessd/` and a repo with `.harnessd/`, from a map of files. */
async function fixture(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "harnessd-config-"));
  roots.push(root);
  for (const [rel, text] of Object.entries(files)) {
    const path = join(root, rel);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
  }
  const home = join(root, "home");
  return {
    root,
    home,
    globalDir: join(home, ".harnessd"),
    workspaceDir: join(root, "repo", ".harnessd"),
  };
}

function configError(message: string | RegExp) {
  return (e: unknown) =>
    e instanceof ConfigError &&
    (typeof message === "string" ? e.message === message : message.test(e.message));
}

test("missing folders load as defaults", async () => {
  const f = await fixture({});
  const merged = await loadConfig({
    globalDir: f.globalDir,
    workspaceDir: f.workspaceDir,
    home: f.home,
  });
  assert.equal(merged.limits.max_concurrent, 3);
  assert.deepEqual(merged.rules, []);
  assert.deepEqual(merged.skills, []);
  assert.equal(resolveAgentConfig(merged, "coordinator").instructions, "");
});

test("global and workspace folders load and merge", async () => {
  const f = await fixture({
    "home/.harnessd/config.toml": [
      "[limits]",
      "max_concurrent = 4",
      "budget_minutes = { S = 20, M = 90 }",
      "[linear]",
      'team_id = "MET"',
      "[agents.backend]",
      'model = "opus"',
      'instructions = "Global backend notes."',
    ].join("\n"),
    "home/.harnessd/AGENTS.md": "# Global\nBe terse.\n",
    "home/.harnessd/rules/style.md": "global style",
    "home/.harnessd/rules/tests.md": "global tests",
    "home/.harnessd/rules/notes.txt": "ignored",
    "home/.harnessd/skills/deploy/SKILL.md":
      "---\nname: deploy\ndescription: Ship it\n---\nGlobal deploy.",
    "home/.harnessd/agents/qa.md": "---\nmodel: sonnet\n---\nGlobal QA notes.\n",
    "repo/.harnessd/config.toml": [
      "[limits.budget_minutes]",
      "M = 60",
      "[agents.backend]",
      'harness = "codex"',
    ].join("\n"),
    "repo/.harnessd/AGENTS.md": "Workspace rules.",
    "repo/.harnessd/rules/style.md": "workspace style",
    "repo/.harnessd/skills/ship/SKILL.md":
      "---\nname: deploy\ndescription: >\n  Ship it\n  the repo way\n---\nRepo deploy.",
    "repo/.harnessd/skills/bench/SKILL.md": "Run the benchmarks.",
    "repo/.harnessd/agents/backend.md": "Workspace backend notes.",
    "repo/.harnessd/agents/docs.md": "---\nrole: frontend\nharness: opencode\n---\nWrite docs.",
  });
  const merged = await loadConfig({
    globalDir: f.globalDir,
    workspaceDir: f.workspaceDir,
    home: f.home,
  });

  assert.deepEqual(merged.limits, {
    max_concurrent: 4,
    budget_minutes: { S: 20, M: 60 },
    qa_max_failures: 2,
  });
  assert.deepEqual(merged.linear, { team_id: "MET" });
  assert.deepEqual(
    merged.rules.map((r) => [r.name, r.text]),
    [
      ["style", "workspace style"],
      ["tests", "global tests"],
    ],
  );
  assert.deepEqual(
    merged.skills.map((s) => [s.name, s.description, s.body]),
    [
      ["bench", undefined, "Run the benchmarks."],
      ["deploy", "Ship it the repo way", "Repo deploy."],
    ],
  );
  assert.equal(merged.skills[1]?.dir, join(f.workspaceDir, "skills", "ship"));

  const backend = resolveAgentConfig(merged, "backend");
  assert.equal(backend.harness, "codex");
  assert.equal(backend.model, "opus");
  assert.equal(
    backend.instructions,
    "# Global\nBe terse.\n\nWorkspace rules.\n\nGlobal backend notes.\n\nWorkspace backend notes.",
  );

  const qa = resolveAgentConfig(merged, "qa");
  assert.equal(qa.model, "sonnet");
  assert.equal(qa.instructions, "# Global\nBe terse.\n\nWorkspace rules.\n\nGlobal QA notes.");

  const docs = resolveAgentConfig(merged, "docs");
  assert.equal(docs.role, "frontend");
  assert.equal(docs.harness, "opencode");
});

test("an invalid harness names the file with ~ and the key", async () => {
  const f = await fixture({ "home/.harnessd/config.toml": '[agents.backend]\nharness = "vim"\n' });
  await assert.rejects(
    loadConfig({ globalDir: f.globalDir, home: f.home }),
    configError(
      '~/.harnessd/config.toml: agents.backend.harness: expected one of claude-code, codex, antigravity, opencode, cursor, grok, got "vim"',
    ),
  );
});

test("an invalid harness in an agent file names that file", async () => {
  const f = await fixture({ "repo/.harnessd/agents/qa.md": "---\nharness: vim\n---\nhi" });
  await assert.rejects(
    loadConfig({ globalDir: f.globalDir, workspaceDir: f.workspaceDir, home: f.home }),
    configError(
      `${join(f.workspaceDir, "agents", "qa.md")}: harness: expected one of claude-code, codex, antigravity, opencode, cursor, grok, got "vim"`,
    ),
  );
});

test("broken TOML reports file, line and column", async () => {
  const f = await fixture({ "home/.harnessd/config.toml": "[limits]\nmax_concurrent = \n" });
  await assert.rejects(
    loadLayer(f.globalDir, "global", f.home),
    configError(/^~\/\.harnessd\/config\.toml: invalid TOML at line 2, column \d+: /),
  );
});

test("a custom agent without a role is rejected", async () => {
  const f = await fixture({ "home/.harnessd/config.toml": '[agents.docs]\nharness = "codex"\n' });
  await assert.rejects(
    loadConfig({ globalDir: f.globalDir, home: f.home }),
    configError(/^~\/\.harnessd\/config\.toml: agents\.docs\.role: required/),
  );
});

test("an agent defined twice in one layer is rejected", async () => {
  const f = await fixture({
    "home/.harnessd/config.toml": '[agents.qa]\nmodel = "a"\n',
    "home/.harnessd/agents/qa.md": "---\nmodel: b\n---\n",
  });
  await assert.rejects(
    loadLayer(f.globalDir, "global", f.home),
    configError(
      "~/.harnessd/agents/qa.md: model: also set as agents.qa.model in ~/.harnessd/config.toml",
    ),
  );
});

test("agents/ only takes <name>.md files", async () => {
  const f = await fixture({ "home/.harnessd/agents/qa.toml": 'harness = "codex"' });
  await assert.rejects(
    loadLayer(f.globalDir, "global", f.home),
    configError("~/.harnessd/agents/qa.toml: expected agents/<name>.md files only"),
  );
});

test("a skill folder without SKILL.md is rejected", async () => {
  const f = await fixture({ "home/.harnessd/skills/deploy/README.md": "x" });
  await assert.rejects(
    loadLayer(f.globalDir, "global", f.home),
    configError("~/.harnessd/skills/deploy/SKILL.md: missing SKILL.md"),
  );
});

test("parseFrontmatter handles quotes, comments and missing frontmatter", () => {
  assert.deepEqual(
    parseFrontmatter("---\n# c\nname: 'a b'\ndescription: \"x: y\"\n---\nbody", "f"),
    {
      data: { name: "a b", description: "x: y" },
      body: "body",
    },
  );
  assert.deepEqual(parseFrontmatter("no frontmatter", "f"), { data: {}, body: "no frontmatter" });
  assert.throws(
    () => parseFrontmatter("---\nname: a\n", "f"),
    configError("f: frontmatter has no closing ---"),
  );
  assert.throws(
    () => parseFrontmatter("---\njust text\n---\n", "f"),
    configError('f: frontmatter line 2: expected "key: value"'),
  );
});
