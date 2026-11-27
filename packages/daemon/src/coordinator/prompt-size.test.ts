// Measures what one agent run loads (D-040). The numbers are reported in
// docs/LOOP.md "What an agent run sees"; this test keeps them from drifting silently.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Call, ConfigLayer, Issue, LinkedIssue, ResolvedAgentConfig } from "@harnessd/shared";
import { mergeLayers } from "../config/merge.ts";
import { MEMORY_TOOLS } from "../memory/server.ts";
import { generateSyncFiles, opencodeSettings } from "../sync/generate.ts";
import { buildPartPrompt } from "./dispatch.ts";
import { buildPlanPrompt, type PlanPart } from "./plan.ts";
import { buildGrillPrompt, type GrillContext } from "./prompt.ts";
import { buildQaPrompt } from "./qa.ts";
import { formatPartDescription } from "./split.ts";
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

test("the committed skill pack a worktree loads loses the skills a run does not use", () => {
  // A worktree is cut from main, so it starts with the skill folders the repo commits.
  // Count those, not only the files sync generates (D-040, D-043).
  const pack = committedSkills();
  const body = (name: string): string => pack.body(name);
  const builder = withheldSkills("backend");
  const qa = withheldSkills("qa");
  const frontend = withheldSkills("frontend");
  const reviewer = withheldSkills("reviewer");
  assert.ok(pack.names.includes("grill-with-docs"));
  assert.ok(pack.names.includes("code-review"));
  const sum = (list: string[]): number => list.reduce((total, name) => total + size(body(name)), 0);

  const full = report("committed SKILL.md bodies, no withholding", sum(pack.names));
  const ui = report(
    "committed SKILL.md bodies, frontend run",
    sum(pack.names.filter((name) => !frontend.includes(name))),
  );
  const nonUi = report(
    "committed SKILL.md bodies, builder run",
    sum(pack.names.filter((name) => !builder.includes(name))),
  );
  const inspected = report(
    "committed SKILL.md bodies, reviewer run",
    sum(pack.names.filter((name) => !reviewer.includes(name))),
  );
  // Builder, frontend and QA runs drop grill-with-docs and code-review; the reviewer keeps
  // code-review (MET-222).
  assert.ok(frontend.includes("grill-with-docs"));
  assert.ok(frontend.includes("code-review"));
  assert.equal(qa.includes("grill-with-docs"), true);
  assert.equal(qa.includes("code-review"), true);
  assert.equal(reviewer.includes("grill-with-docs"), true);
  assert.equal(reviewer.includes("code-review"), false);
  // The reviewer run keeps code-review, so it loads that body and the builder does not.
  assert.equal(inspected - nonUi, size(body("code-review")));
  // A builder run must stay well under the size docs/LOOP.md reports.
  assert.ok(ui < 60_000, `frontend skill bodies ${ui}`);
  assert.ok(nonUi < 50_000, `builder skill bodies ${nonUi}`);
  assert.ok(nonUi < full, "the builder drops the skills it does not use");
});

/** The builder skill set before D-044: the five non-builder skills from D-043. */
const OLD_BUILDER_WITHHELD = ["impeccable", "grilling", "domain-modeling", "research", "prototype"];

/** The old reading rule, replaced by the role split in .harnessd/AGENTS.md (D-044). */
const OLD_READING_RULE =
  "- Read docs/SPEC.md and docs/decisions/ before any change. If a change contradicts a decision, add a new decision record. Don't silently diverge.";

/** The role split in the generated AGENTS.md; the test below checks it is there. */
const NEW_READING_RULES = [
  "- **Reading by role.** The coordinator (grill, plan) reads `docs/SPEC.md` and every decision record in `docs/decisions/`. A builder or QA run reads only its brief and the decision records the brief names by ID. It reads another record only when the brief or the code points to it.",
  "- If a change contradicts a decision, add a new decision record (D-044). Don't silently diverge.",
].join("\n");

function decisionFiles(): { name: string; text: string }[] {
  const dir = join(REPO, "docs/decisions");
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => ({ name, text: readFileSync(join(dir, name), "utf8") }));
}

test("role-scoped reading shrinks the builder's first turn (D-044)", () => {
  const issue = issues.clear as Issue;
  const linked: LinkedIssue = { ...issue, blockers: [] };
  const calls: Call[] = [
    {
      question: "Where does the version come from?",
      answer: "The package version.",
      basis: "SPEC",
    },
  ];
  const decisions = decisionFiles();
  const named = decisions.filter((d) => /^(D-040|D-043)/.test(d.name));
  const afterPart: PlanPart = {
    role: "backend",
    title: issue.title,
    size: issue.size ?? "M",
    goal: `Implement ${issue.key} as written, with tests.`,
    doneWhen: [1],
    files: ["packages/daemon/src/index.ts"],
    steps: ["Implement the change.", "Run the focused tests."],
    verify: [{ run: "pnpm test", expect: "passes" }],
    outOfScope: "Nothing.",
    decisions: [
      { id: "D-040", line: "One part is one PR." },
      { id: "D-043", line: "The token budget is weighted." },
    ],
    calls: [1],
  };
  const beforePart: PlanPart = {
    role: "backend",
    title: issue.title,
    size: issue.size ?? "M",
    goal: `Implement ${issue.key} as written, with tests.`,
    doneWhen: [1],
    files: ["packages/daemon/src/index.ts"],
    steps: [`Implement the change. ${OLD_READING_RULE}`, "Run the focused tests."],
    verify: [{ run: "pnpm test", expect: "passes" }],
    outOfScope: "Nothing.",
  };
  const beforePrompt = buildPartPrompt({
    agent,
    issue: { ...linked, description: formatPartDescription(issue, beforePart, "backend") },
    branch: "met-147",
  });
  const afterPrompt = buildPartPrompt({
    agent,
    issue: { ...linked, description: formatPartDescription(issue, afterPart, "backend", calls) },
    branch: "met-147",
  });

  const pack = committedSkills();
  const skillChars = (withheld: string[]): number =>
    pack.names
      .filter((name) => !withheld.includes(name))
      .reduce((total, name) => total + size(pack.body(name)), 0);
  const newAgents = readFileSync(join(REPO, "AGENTS.md"), "utf8");
  assert.ok(newAgents.includes(NEW_READING_RULES), "AGENTS.md has the role-scoped rule");
  const oldAgents = newAgents.replace(NEW_READING_RULES, OLD_READING_RULE);

  const spec = readFileSync(join(REPO, "docs/SPEC.md"), "utf8");
  const before =
    size(beforePrompt) +
    size(spec) +
    decisions.reduce((total, d) => total + size(d.text), 0) +
    size(oldAgents) +
    skillChars(OLD_BUILDER_WITHHELD);
  const after =
    size(afterPrompt) +
    named.reduce((total, d) => total + size(d.text), 0) +
    size(newAgents) +
    skillChars(withheldSkills("backend"));

  const beforeChars = report("builder first turn, before role-scoped reading (D-044)", before);
  const afterChars = report("builder first turn, after role-scoped reading (D-044)", after);
  console.log(
    `builder first turn tokens before: ${Math.ceil(beforeChars / 4)}; after: ${Math.ceil(afterChars / 4)} (4 chars per token)`,
  );
  assert.ok(named.length > 0, "the named records exist");
  assert.ok(
    afterChars < beforeChars,
    `after ${afterChars} chars is smaller than before ${beforeChars}`,
  );
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
