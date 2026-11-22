import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { ConfigError } from "@harnessd/shared";
import { parseFrontmatter } from "./frontmatter.ts";
import { defaultGlobalDir, loadConfig, loadLayer } from "./load.ts";
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
  assert.equal(merged.limits.max_concurrent, 1);
  assert.deepEqual(merged.rules, []);
  assert.deepEqual(merged.skills, []);
  assert.equal(resolveAgentConfig(merged, "coordinator").instructions, "");
});

test("an avatar loads from config.toml or agents/<name>.md, once per folder", async () => {
  const f = await fixture({
    "home/.harnessd/config.toml": '[agents.backend]\navatar = "https://example.test/b.png"\n',
    "repo/.harnessd/agents/qa.md": "---\navatar: avatars/qa.png\n---\nCheck everything.\n",
  });
  const merged = await loadConfig({
    globalDir: f.globalDir,
    workspaceDir: f.workspaceDir,
    home: f.home,
  });
  assert.equal(merged.agents.backend?.avatar, "https://example.test/b.png");
  assert.equal(resolveAgentConfig(merged, "qa").avatar, "avatars/qa.png");
  assert.equal("avatar" in resolveAgentConfig(merged, "frontend"), false);

  const clash = await fixture({
    "home/.harnessd/config.toml": '[agents.qa]\navatar = "a.png"\n',
    "home/.harnessd/agents/qa.md": "---\navatar: b.png\n---\n",
  });
  await assert.rejects(
    loadConfig({ globalDir: clash.globalDir, home: clash.home }),
    configError(
      "~/.harnessd/agents/qa.md: avatar: also set as agents.qa.avatar in ~/.harnessd/config.toml",
    ),
  );
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
    token_budget: { S: 3_000_000, M: 6_000_000 },
    cached_token_weight: 0.1,
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

test("a skill keeps its other frontmatter lines and lists its other files", async () => {
  const f = await fixture({
    "home/.harnessd/skills/ui/SKILL.md":
      "---\nname: ui\ndescription: Design\nuser-invocable: true\nargument-hint: >\n  [target]\n---\nBody\n",
    "home/.harnessd/skills/ui/LICENSE": "Apache",
    "home/.harnessd/skills/ui/reference/craft.md": "craft",
    "home/.harnessd/skills/ui/.harnessd-pack": "pbakaus/impeccable b49177d\n",
  });
  const layer = await loadLayer(f.globalDir, "global", f.home);
  const skill = layer.skills[0];
  assert.deepEqual(skill?.frontmatter, ["user-invocable: true", "argument-hint: >", "  [target]"]);
  assert.deepEqual(skill?.files, ["LICENSE", "reference/craft.md"]);
});

test("a skill's .harnessd-native/ folder gives its hooks and Claude Code agents", async () => {
  const hooks = {
    claude: { Stop: [{ hooks: [{ type: "command", command: "run hook", timeout: 30 }] }] },
    codex: { Stop: [{ hooks: [{ type: "command", command: "run codex hook" }] }] },
  };
  const f = await fixture({
    "home/.harnessd/skills/ui/SKILL.md": "Body\n",
    "home/.harnessd/skills/ui/LICENSE": "Apache",
    "home/.harnessd/skills/ui/.harnessd-native/hooks.json": JSON.stringify(hooks),
    "home/.harnessd/skills/ui/.harnessd-native/claude-agents/ui-reviewer.md":
      "---\nname: ui-reviewer\n---\nReview.\n",
  });
  const skill = (await loadLayer(f.globalDir, "global", f.home)).skills[0];
  assert.deepEqual(skill?.files, ["LICENSE"]);
  assert.deepEqual(skill?.native, {
    claudeHooks: hooks.claude,
    codexHooks: hooks.codex,
    claudeAgents: [{ name: "ui-reviewer", text: "---\nname: ui-reviewer\n---\nReview.\n" }],
  });
});

test("a bad .harnessd-native/hooks.json is a config error", async () => {
  const f = await fixture({
    "home/.harnessd/skills/ui/SKILL.md": "Body\n",
    "home/.harnessd/skills/ui/.harnessd-native/hooks.json": '{"claude":{"Stop":[{"hooks":[{}]}]}}',
  });
  await assert.rejects(
    loadLayer(f.globalDir, "global", f.home),
    configError(/hooks\.json: claude\.Stop\[0\]\.hooks\[0\]\.command: expected a string/),
  );
});

test("a [skills.<name>] table loads into the layer", async () => {
  const f = await fixture({ "repo/.harnessd/config.toml": "[skills.tdd]\nenabled = false\n" });
  const layer = await loadLayer(f.workspaceDir, "workspace", f.home);
  assert.deepEqual(layer.skillSettings, { tdd: { enabled: false } });
});

test("parseFrontmatter handles quotes, comments and missing frontmatter", () => {
  assert.deepEqual(
    parseFrontmatter("---\n# c\nname: 'a b'\ndescription: \"x: y\"\n---\nbody", "f"),
    {
      data: { name: "a b", description: "x: y" },
      lines: { name: ["name: 'a b'"], description: ['description: "x: y"'] },
      body: "body",
    },
  );
  assert.deepEqual(parseFrontmatter("no frontmatter", "f"), {
    data: {},
    lines: {},
    body: "no frontmatter",
  });
  assert.throws(
    () => parseFrontmatter("---\nname: a\n", "f"),
    configError("f: frontmatter has no closing ---"),
  );
  assert.throws(
    () => parseFrontmatter("---\njust text\n---\n", "f"),
    configError('f: frontmatter line 2: expected "key: value"'),
  );
});

test("defaultGlobalDir honours HARNESSD_HOME", () => {
  assert.equal(defaultGlobalDir({ HARNESSD_HOME: "/tmp/hd-home" }), "/tmp/hd-home");
  assert.equal(defaultGlobalDir({ HARNESSD_HOME: "" }), join(homedir(), ".harnessd"));
  assert.equal(defaultGlobalDir({}), join(homedir(), ".harnessd"));
});

test("secret references load from the global config.toml only (MET-33)", async () => {
  const f = await fixture({
    "home/.harnessd/config.toml": '[secrets.linear]\napi_key = "env:MY_LINEAR"\n',
    "repo/.harnessd/config.toml": '[secrets.slack]\nwebhook_url = "env:HOOK"\n',
  });
  await loadConfig({ globalDir: f.globalDir, home: f.home });
  await assert.rejects(
    loadConfig({ globalDir: f.globalDir, workspaceDir: f.workspaceDir, home: f.home }),
    configError(
      `${f.workspaceDir}/config.toml: secrets: secret references belong in ~/.harnessd/config.toml only`,
    ),
  );
});

test("OpenCode permissions merge across layers for one agent", async () => {
  const f = await fixture({
    "home/.harnessd/config.toml":
      '[agents.backend.opencode_permission]\nwebsearch = "allow"\nbash = { "*" = "deny", "git status*" = "allow" }\n',
    "repo/.harnessd/config.toml":
      '[agents.backend.opencode_permission]\nwebsearch = "deny"\nbash = { "git diff*" = "allow" }\n',
  });
  const merged = await loadConfig(f);
  assert.deepEqual(resolveAgentConfig(merged, "backend").opencode_permission, {
    websearch: "deny",
    bash: { "*": "deny", "git status*": "allow", "git diff*": "allow" },
  });
  assert.equal(resolveAgentConfig(merged, "qa").opencode_permission, undefined);
});

test("OpenCode permission actions must be allow or deny", async () => {
  for (const [value, path] of [
    ['"ask"', "bash"],
    ['{ "*" = "ask" }', "bash.*"],
    ["true", "bash"],
    ["[]", "bash"],
  ]) {
    const f = await fixture({
      "repo/.harnessd/config.toml": `[agents.backend.opencode_permission]\nbash = ${value}\n`,
    });
    await assert.rejects(loadConfig(f), (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.equal(error.key, `agents.backend.opencode_permission.${path}`);
      assert.match(error.message, /expected one of allow, deny/);
      return true;
    });
  }
});
