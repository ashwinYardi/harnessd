import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigError } from "@harnessd/shared";
import { mergeLayers } from "../config/merge.ts";
import { tomlKey, tomlString, yamlString } from "./format.ts";
import {
  agentMd,
  codexConfig,
  GENERATED_NOTE,
  generateSyncFiles,
  syncedMcpServers,
} from "./generate.ts";

test("generateSyncFiles lists every native file in a stable order", () => {
  const paths = generateSyncFiles(mergeLayers([])).map((f) => f.path);
  assert.deepEqual(paths, [
    "AGENTS.md",
    "CLAUDE.md",
    ".claude/settings.json",
    ".mcp.json",
    ".codex/config.toml",
    "opencode.json",
  ]);
});

test("a skill name that would escape .claude/skills is a config error", () => {
  const merged = mergeLayers([]);
  merged.skills = [{ name: "../evil", dir: "/s", source: "/s/SKILL.md", body: "" }];
  assert.throws(
    () => generateSyncFiles(merged),
    (e: unknown) => e instanceof ConfigError && /skills? names may only use/.test(e.message),
  );
});

test("a skill goes to Claude Code and Codex with its frontmatter and every file", () => {
  const merged = mergeLayers([]);
  merged.skills = [
    {
      name: "ui",
      description: "Design",
      dir: "/g/skills/ui",
      source: "/g/skills/ui/SKILL.md",
      body: "Body",
      frontmatter: ["user-invocable: true", "argument-hint: >", "  [target]"],
      files: ["LICENSE", "scripts/run"],
    },
  ];
  const files = generateSyncFiles(merged).filter((f) => f.path.includes("skills/"));
  const md = `---\nname: ui\ndescription: Design\nuser-invocable: true\nargument-hint: >\n  [target]\n---\n<!-- ${GENERATED_NOTE} -->\n\nBody\n`;
  assert.deepEqual(files, [
    { path: ".claude/skills/ui/SKILL.md", content: md },
    { path: ".claude/skills/ui/LICENSE", copyFrom: "/g/skills/ui/LICENSE" },
    { path: ".claude/skills/ui/scripts/run", copyFrom: "/g/skills/ui/scripts/run" },
    { path: ".agents/skills/ui/SKILL.md", content: md },
    { path: ".agents/skills/ui/LICENSE", copyFrom: "/g/skills/ui/LICENSE" },
    { path: ".agents/skills/ui/scripts/run", copyFrom: "/g/skills/ui/scripts/run" },
  ]);
});

const HOOK = { hooks: [{ type: "command", command: "scan" }] };

test("a skill's hooks and agents go to Claude Code settings, the Codex hook file and .claude/agents", () => {
  const merged = mergeLayers([]);
  merged.skills = [
    {
      name: "ui",
      dir: "/g/skills/ui",
      source: "/g/skills/ui/SKILL.md",
      body: "",
      native: {
        claudeHooks: { Stop: [HOOK] },
        codexHooks: { Stop: [HOOK] },
        claudeAgents: [{ name: "ui-reviewer", text: "---\nname: ui-reviewer\n---\nReview.\n" }],
      },
    },
  ];
  const files = generateSyncFiles(merged);
  const settings = files.find((f) => f.path === ".claude/settings.json");
  assert.ok(settings && "settings" in settings);
  assert.deepEqual(settings.settings.hooks, { Stop: [HOOK] });
  assert.deepEqual(Object.keys(settings.settings.keys), ["$schema", "enabledMcpjsonServers"]);
  const codex = files.find((f) => f.path === ".codex/hooks.json");
  assert.deepEqual(codex, {
    path: ".codex/hooks.json",
    settings: { keys: {}, hooks: { Stop: [HOOK] } },
  });
  assert.deepEqual(
    files.find((f) => f.path === ".claude/agents/ui-reviewer.md"),
    {
      path: ".claude/agents/ui-reviewer.md",
      content: `---\nname: ui-reviewer\n---\n<!-- ${GENERATED_NOTE} -->\nReview.\n`,
    },
  );
});

test("without a skill that has hooks, sync writes no hooks and no Codex hook file", () => {
  const files = generateSyncFiles(mergeLayers([]));
  const settings = files.find((f) => f.path === ".claude/settings.json");
  assert.ok(settings && "settings" in settings);
  assert.deepEqual(settings.settings.hooks, {});
  assert.ok(!files.some((f) => f.path === ".codex/hooks.json"));
});

test("an agent file without frontmatter gets the note first", () => {
  assert.equal(agentMd("Review.\n"), `<!-- ${GENERATED_NOTE} -->\nReview.\n`);
});

test("codex config writes empty env tables", () => {
  const merged = mergeLayers([]);
  merged.mcp = { x: { command: "x", env: {} } };
  assert.match(codexConfig(merged), /\[mcp_servers\.x\]\ncommand = "x"\nenv = \{\}\n$/);
});

test("the memory server is added by default and a config table replaces it", () => {
  const merged = mergeLayers([]);
  assert.deepEqual(syncedMcpServers(merged), {
    "harnessd-memory": { command: "harnessd", args: ["mcp", "memory"] },
  });
  merged.mcp = {
    "harnessd-memory": { command: "npx", args: ["-y", "@harnessd/cli", "mcp", "memory"] },
    alpha: { command: "a" },
  };
  const servers = syncedMcpServers(merged);
  assert.deepEqual(Object.keys(servers), ["alpha", "harnessd-memory"]);
  assert.equal(servers["harnessd-memory"]?.command, "npx");
});

test("toml and yaml scalars quote only when needed", () => {
  assert.equal(tomlKey("A_B-1"), "A_B-1");
  assert.equal(tomlKey("a.b"), '"a.b"');
  assert.equal(tomlString('a"\\\n\u007f'), '"a\\"\\\\\\n\\u007F"');
  assert.equal(yamlString("Ship it to staging"), "Ship it to staging");
  assert.equal(yamlString("Where is it? Here!"), "Where is it? Here!");
  assert.equal(yamlString("a: b"), '"a: b"');
  assert.equal(yamlString("yes"), '"yes"');
  assert.equal(yamlString("#tag"), '"#tag"');
  assert.equal(yamlString("12"), '"12"');
});

test("OpenCode sync generates fixed builder permissions and a Web Search provider", () => {
  const file = generateSyncFiles(mergeLayers([])).find(({ path }) => path === "opencode.json");
  assert.ok(file && "settings" in file);
  assert.deepEqual(file.settings.keys.permission, {
    read: "allow",
    edit: "allow",
    glob: "allow",
    grep: "allow",
    list: "allow",
    lsp: "allow",
    skill: "allow",
    task: "allow",
    todowrite: "allow",
    webfetch: "allow",
    websearch: "allow",
    bash: { "*": "allow", "git push *": "deny" },
    external_directory: "deny",
    question: "deny",
    doom_loop: "deny",
  });
  assert.deepEqual(file.settings.keys.websearch, { provider: "random" });
});
