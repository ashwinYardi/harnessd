import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ESCALATION_TRIGGERS, type Issue } from "@harnessd/shared";
import {
  BUILT_IN_GRILL_METHOD,
  buildGrillPrompt,
  loadGrillContext,
  loadGrillMethod,
  memorySection,
} from "./prompt.ts";

const issues = JSON.parse(
  readFileSync(new URL("./fixtures/issues.json", import.meta.url), "utf8"),
) as Record<string, Issue>;
const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

test("prompt includes the issue, the spec, every decision record and the D-011 triggers", async () => {
  const context = await loadGrillContext(repoRoot);
  assert.ok(context.decisions.some((d) => d.name.startsWith("D-011")));
  const issue = issues.clear as Issue;
  const prompt = buildGrillPrompt({ issue, context, instructions: "Keep the board honest." });

  assert.match(prompt, /## Issue MET-40: Daemon reports its version on \/health/);
  assert.match(prompt, /- \[ \] GET \/health returns \{ ok, version \}/);
  assert.match(prompt, /\*\*Size\*\*: S/);
  assert.match(prompt, /## Coordinator instructions\nKeep the board honest\./);
  assert.ok(prompt.includes(context.spec), "spec text");
  assert.match(prompt, /## Autonomy loop/);
  for (const d of context.decisions) {
    assert.ok(prompt.includes(`### ${d.name}\n${d.text}`), d.name);
  }
  assert.match(prompt, /D-011 Autopilot; ask only when worth it/);
  for (const t of ESCALATION_TRIGGERS) assert.ok(prompt.includes(`- ${t}: `), t);
  assert.match(prompt, /strict JSON only/);
  assert.match(prompt, /"escalation": null \| \{ "trigger"/);
});

test("loadGrillContext reads docs/ and tolerates a repo without them", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harnessd-grill-"));
  try {
    assert.deepEqual(await loadGrillContext(dir), { spec: "", decisions: [] });
    await mkdir(join(dir, "docs", "decisions"), { recursive: true });
    await writeFile(join(dir, "docs", "SPEC.md"), "# spec\n");
    await writeFile(join(dir, "docs", "decisions", "D-002-b.md"), "# D-002\n");
    await writeFile(join(dir, "docs", "decisions", "D-001-a.md"), "# D-001\n");
    await writeFile(join(dir, "docs", "decisions", "notes.txt"), "skip");
    assert.deepEqual(await loadGrillContext(dir), {
      spec: "# spec",
      decisions: [
        { name: "D-001-a.md", text: "# D-001" },
        { name: "D-002-b.md", text: "# D-002" },
      ],
    });
    const prompt = buildGrillPrompt({
      issue: issues.taste as Issue,
      context: { spec: "", decisions: [] },
    });
    assert.match(prompt, /## Spec \(docs\/SPEC\.md\)\n\(missing\)/);
    assert.doesNotMatch(prompt, /Coordinator instructions/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadGrillMethod builds grill-with-docs from the installed skills, else the built-in", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harnessd-skills-"));
  try {
    const builtIn = await loadGrillMethod(join(dir, "missing"));
    assert.equal(builtIn.source, "built-in");
    assert.equal(builtIn.text, BUILT_IN_GRILL_METHOD);
    assert.deepEqual(await loadGrillMethod(undefined), builtIn);

    await mkdir(join(dir, "grilling"), { recursive: true });
    await writeFile(
      join(dir, "grilling", "SKILL.md"),
      "---\nname: grilling\n---\n\nWork the frontier.\n",
    );
    assert.equal((await loadGrillMethod(dir)).source, "built-in", "needs both skills");

    await mkdir(join(dir, "domain-modeling"), { recursive: true });
    await writeFile(
      join(dir, "domain-modeling", "SKILL.md"),
      "---\nname: domain-modeling\n---\n# Domain Modeling\nUpdate GLOSSARY.md inline.\n",
    );
    const method = await loadGrillMethod(dir);
    assert.equal(method.source, "skill pack");
    assert.equal(
      method.text,
      "### grilling\nWork the frontier.\n\n### domain-modeling\n# Domain Modeling\nUpdate GLOSSARY.md inline.",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadGrillContext reads GLOSSARY.md, the vault glossary and the method", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harnessd-grill-"));
  try {
    await writeFile(join(dir, "GLOSSARY.md"), "# Glossary\n\n**Pin**: a commit.\n");
    await mkdir(join(dir, ".harnessd", "vault", "glossary"), { recursive: true });
    await writeFile(
      join(dir, ".harnessd", "vault", "glossary", "work-part.md"),
      "---\nterm: Work part\n---\n\n**Work part**:\nA sub-issue.\n",
    );
    const context = await loadGrillContext(dir, { skillsDir: join(dir, "no-skills") });
    assert.equal(context.glossary, "# Glossary\n\n**Pin**: a commit.");
    assert.deepEqual(context.vaultGlossary, ["**Work part**:\nA sub-issue."]);
    assert.equal(context.method?.source, "built-in");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("prompt runs grill-with-docs headless and asks for terms and precedents", () => {
  const prompt = buildGrillPrompt({
    issue: issues.clear as Issue,
    context: {
      spec: "# spec",
      decisions: [],
      glossary: "**Pin**: a commit.",
      vaultGlossary: ["**Work part**:\nA sub-issue."],
      method: { source: "skill pack", text: "### grilling\nWork the frontier." },
    },
  });
  assert.match(prompt, /## Method: grill-with-docs \(skill pack\)/);
  assert.match(prompt, /### grilling\nWork the frontier\./);
  assert.match(prompt, /No human answers during the grill/);
  assert.match(prompt, /## Glossary \(GLOSSARY\.md\)\n\*\*Pin\*\*: a commit\./);
  assert.match(
    prompt,
    /## Workspace glossary \(\.harnessd\/vault\/glossary\/\)\n\*\*Work part\*\*/,
  );
  assert.match(prompt, /"terms": \[\{ "term": "string", "definition": "string", "avoid"/);
  assert.match(prompt, /"precedents": \[\{ "title": "string", "decision": "string", "why"/);

  const bare = buildGrillPrompt({
    issue: issues.clear as Issue,
    context: { spec: "", decisions: [] },
  });
  assert.match(bare, /## Method: grill-with-docs \(built-in\)/);
  assert.ok(bare.includes(BUILT_IN_GRILL_METHOD));
  assert.match(bare, /## Glossary \(GLOSSARY\.md\)\n\(none\)/);
});

test("the grill prompt asks for normalizedDoneWhen when the filed list cannot pass the plan", () => {
  const prompt = buildGrillPrompt({
    issue: issues.clear as Issue,
    context: { spec: "", decisions: [] },
  });
  assert.match(prompt, /"normalizedDoneWhen": \["string"\]/);
  assert.match(
    prompt,
    /When the filed Done-when list cannot pass the plan rules, also set normalizedDoneWhen: a docs-only ticket gets at most 3 items, no ticket gets more than 18, every original requirement stays/,
  );
  assert.match(prompt, /Leave it out when the filed list already passes\./);
});

test("memorySection names the memory tools, both vaults and how to commit a generated file", () => {
  const text = memorySection({
    workspaceVault: "/repo/.harnessd/vault",
    globalVault: "/home/.harnessd/vault",
  });
  assert.match(text, /^## Memory\n/);
  for (const tool of ["search_notes", "read_note", "write_note"]) assert.ok(text.includes(tool));
  assert.ok(text.includes("harnessd-memory"));
  assert.ok(text.includes("/repo/.harnessd/vault/"));
  assert.ok(text.includes("/home/.harnessd/vault/ ($HARNESSD_HOME/vault/)"));
  assert.match(text, /not part of your change unless the issue asks/);
  assert.match(text, /git add -f/);
  assert.match(text, /--no-skip-worktree/);
});
