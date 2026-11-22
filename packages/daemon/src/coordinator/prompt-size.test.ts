// Measures what one agent run loads (D-040). The numbers are reported in
// docs/LOOP.md "What an agent run sees"; this test keeps them from drifting silently.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { ConfigLayer, Issue, LinkedIssue, ResolvedAgentConfig } from "@harnessd/shared";
import { mergeLayers } from "../config/merge.ts";
import { generateSyncFiles } from "../sync/generate.ts";
import { buildPartPrompt } from "./dispatch.ts";
import { buildPlanPrompt } from "./plan.ts";
import { buildGrillPrompt, type GrillContext } from "./prompt.ts";
import { buildQaPrompt } from "./qa.ts";

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
