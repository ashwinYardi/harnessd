// Measures what one agent run loads (D-040). The numbers are reported in
// docs/LOOP.md "What an agent run sees"; this test keeps them from drifting silently.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { ConfigLayer, Issue, LinkedIssue, ResolvedAgentConfig } from "@harnessd/shared";
import { mergeLayers } from "../config/merge.ts";
import { MEMORY_TOOLS } from "../memory/server.ts";
import { generateSyncFiles, opencodeSettings } from "../sync/generate.ts";
import { buildPartPrompt } from "./dispatch.ts";
import { buildPlanPrompt } from "./plan.ts";
import { buildGrillPrompt, type GrillContext } from "./prompt.ts";
import { buildQaPrompt } from "./qa.ts";
import { withheldSkills } from "./worktree-sync.ts";

const REPO = fileURLToPath(new URL("../../../../", import.meta.url));

/**
 * The skill folders the repo commits, read from HEAD. A worktree a run cut down has
 * already removed its withheld folders, so reading the checkout would skew the count.
 */
function committedSkills(): { names: string[]; body(name: string): string } {
  const listed = execFileSync(
    "git",
    ["-C", REPO, "ls-tree", "-d", "--name-only", "HEAD:.claude/skills"],
    {
      encoding: "utf8",
    },
  ).trim();
  const names = listed === "" ? [] : listed.split("\n").sort();
  return {
    names,
    body: (name) =>
      execFileSync("git", ["-C", REPO, "show", `HEAD:.claude/skills/${name}/SKILL.md`], {
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
      }),
  };
}

const issues = JSON.parse(
  readFileSync(new URL("./fixtures/issues.json", import.meta.url), "utf8"),
) as Record<string, Issue>;

const agent: ResolvedAgentConfig = {
  name: "backend",
  role: "backend",
  harness: "claude-code",
  instructions: "Own the API layer.",
  rules: [],
  skills: [],
};

/** A prompt's size in characters, the unit a harness bills as about one token per 3–4. */
function size(text: string): number {
  return text.length;
}

function report(label: string, chars: number): number {
  console.log(`${label}: ${chars} chars`);
  return chars;
}

test("the four prompt kinds stay within their measured size", () => {
  const issue = issues.clear as Issue;
  const linked: LinkedIssue = { ...issue, blockers: [] };
  const context: GrillContext = { spec: "# spec\n".repeat(200), decisions: [] };

  const grill = report(
    "grill prompt",
    size(buildGrillPrompt({ issue, context, instructions: "" })),
  );
  const plan = report("plan prompt", size(buildPlanPrompt({ issue, context, instructions: "" })));
  const part = report(
    "part prompt",
    size(buildPartPrompt({ agent, issue: linked, branch: "met-40" })),
  );
  const qa = report(
    "qa prompt",
    size(
      buildQaPrompt({
        agent: { ...agent, role: "qa", name: "qa" },
        qa: linked,
        parent: issue,
        part: linked,
        pr: {
          number: 7,
          title: "MET-40: work",
          url: "https://github.test/o/r/pull/7",
          headRefName: "met-40",
          headRefOid: "sha7",
          baseRefName: "main",
          isDraft: false,
        },
        diff: "+const x = 1;\n".repeat(100),
        ci: [{ name: "CI / test", state: "pass", detail: "SUCCESS" }],
        files: [{ path: "src/x.ts", additions: 3, deletions: 1 }],
        checklist: ["Works", "Has tests"],
        tests: { passed: true, command: "pnpm test", exitCode: 0, timedOut: false, output: "ok" },
      }),
    ),
  );

  // Ceilings, not targets: a prompt that grows past these is a spend regression (D-040).
  assert.ok(grill < 200_000, `grill ${grill}`);
  assert.ok(plan < 200_000, `plan ${plan}`);
  assert.ok(part < 20_000, `part ${part}`);
  assert.ok(qa < 60_000, `qa ${qa}`);
});

test("the committed skill pack a worktree loads loses the skills a builder does not use", () => {
  // A worktree is cut from main, so it starts with the skill folders the repo commits.
  // Count those, not only the files sync generates (D-040, D-043).
  const pack = committedSkills();
  const body = (name: string): string => pack.body(name);
  const builder = withheldSkills("backend");
  const frontend = withheldSkills("frontend");
  assert.ok(pack.names.includes("impeccable"));
  assert.ok(pack.names.includes("grilling"));
  const sum = (list: string[]): number => list.reduce((total, name) => total + size(body(name)), 0);

  const full = report("committed SKILL.md bodies, no withholding", sum(pack.names));
  const ui = report(
    "committed SKILL.md bodies, frontend run",
    sum(pack.names.filter((name) => !frontend.includes(name))),
  );
  const nonUi = report(
    "committed SKILL.md bodies, builder or QA run",
    sum(pack.names.filter((name) => !builder.includes(name))),
  );
  assert.equal(
    full - ui,
    frontend.reduce((total, name) => total + size(body(name)), 0),
  );
  // The frontend run keeps impeccable and drops the coordinator's four skills.
  assert.equal(ui - nonUi, size(body("impeccable")));
  // A builder or QA run must stay well under the size docs/LOOP.md reports.
  assert.ok(ui < 60_000, `frontend skill bodies ${ui}`);
  assert.ok(nonUi < 50_000, `builder skill bodies ${nonUi}`);
});

test("the builder's base prompt fits well under 100k tokens", () => {
  const pack = committedSkills();
  const withheld = withheldSkills("backend");
  const skills = pack.names
    .filter((name) => !withheld.includes(name))
    .reduce((total, name) => total + size(pack.body(name)), 0);
  const agents = size(readFileSync(join(REPO, "AGENTS.md"), "utf8"));
  const settings = opencodeSettings(mergeLayers([]), { memoryMcpOnly: true });
  const opencode = size(
    JSON.stringify({ ...settings.keys, mcp: settings.entries?.mcp ?? {} }, null, 2),
  );
  const memory = size(JSON.stringify(MEMORY_TOOLS));

  report("AGENTS.md (this repo, rules included)", agents);
  report("builder SKILL.md bodies", skills);
  report("opencode.json MCP and permission tables", opencode);
  report("harnessd-memory tool list", memory);

  // The owner's own skill folders: OpenCode reads them too, and harnessd cannot remove
  // them without breaking sign-in (D-036). Measured, out of scope (MET-112).
  let home = 0;
  for (const root of [".claude/skills", ".agents/skills"]) {
    let owned: string[] = [];
    try {
      owned = readdirSync(join(homedir(), root), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      continue;
    }
    for (const name of owned) {
      try {
        home += size(readFileSync(join(homedir(), root, name, "SKILL.md"), "utf8"));
      } catch {
        // A folder without a SKILL.md is not a skill the harness loads.
      }
    }
  }
  report("owner ~/.claude/skills and ~/.agents/skills (out of scope)", home);

  const total = agents + skills + opencode + memory;
  const estimated = Math.ceil(total / 4);
  console.log(`estimated builder base prompt tokens (4 chars per token): ${estimated}`);
  // Ceilings, not targets: a part of the base prompt that grows past these is a spend
  // regression. Keep them near the numbers docs/LOOP.md reports.
  assert.ok(agents < 6_000, `AGENTS.md ${agents}`);
  assert.ok(skills < 45_000, `skill bodies ${skills}`);
  assert.ok(opencode < 2_000, `opencode.json ${opencode}`);
  assert.ok(memory < 3_000, `memory tool list ${memory}`);
  assert.ok(estimated < 13_000, `base prompt ${estimated} tokens`);
});

test("the worktree sync output is counted by file kind", () => {
  const body = "Do the work one step at a time. ".repeat(40);
  const desktopSkill = {
    name: "tdd",
    source: "global/.harnessd/skills/tdd/SKILL.md",
    dir: "/pack/tdd",
    body,
    frontmatter: ["disable-model-invocation: true"],
  };
  const uiSkill = { ...desktopSkill, name: "impeccable", body: body.repeat(3) };
  const layer: ConfigLayer = {
    scope: "global",
    dir: "/global",
    settings: {},
    agents: {},
    rules: [{ name: "Repo rules", source: "/global/rules/repo.md", text: "Keep it small.\n" }],
    skills: [desktopSkill, uiSkill],
    mcp: { docs: { command: "npx", args: ["-y", "docs-mcp"] } },
    skillSettings: {},
    instructions: { source: "/global/AGENTS.md", text: "Global instructions.\n" },
  };
  const config = mergeLayers([layer]);
  const files = generateSyncFiles(config, { memoryMcpOnly: true });

  const text = (path: string): string => {
    const file = files.find((f) => f.path === path);
    assert.ok(file !== undefined && "content" in file, `${path} has content`);
    return file.content;
  };
  const skills = files
    .filter((f) => f.path.endsWith("/SKILL.md") && "content" in f)
    .map((f) => ("content" in f ? size(f.content) : 0))
    .reduce((a, b) => a + b, 0);

  report("AGENTS.md", size(text("AGENTS.md")));
  report("skill files", skills);
  assert.equal(
    text(".mcp.json"),
    '{\n  "mcpServers": {\n    "harnessd-memory": {\n      "command": "harnessd",\n      "args": [\n        "mcp",\n        "memory"\n      ]\n    }\n  }\n}\n',
  );
  // The memory-only set leaves the user's MCP servers out of a worktree run.
  assert.doesNotMatch(text(".mcp.json"), /docs-mcp/);
});
