import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { readGlossary, writeDraftDecision, writeGlossaryTerm } from "./glossary.ts";

const roots: string[] = [];
after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function vault(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "harnessd-glossary-"));
  roots.push(root);
  return join(root, "vault");
}

test("writeGlossaryTerm writes glossary/<slug>.md and never overwrites a term", async () => {
  const dir = await vault();
  const path = await writeGlossaryTerm(dir, {
    issue: "met-22",
    term: "Work part",
    definition: "A backend or frontend sub-issue that the split creates.",
    avoid: ["chunk", "subtask"],
  });
  assert.equal(path, "glossary/work-part.md");
  assert.equal(
    await readFile(join(dir, path ?? ""), "utf8"),
    [
      "---",
      "term: Work part",
      "issue: MET-22",
      "avoid:",
      "  - chunk",
      "  - subtask",
      "---",
      "",
      "**Work part**:",
      "A backend or frontend sub-issue that the split creates.",
      "_Avoid_: chunk, subtask",
      "",
    ].join("\n"),
  );

  const again = await writeGlossaryTerm(dir, {
    issue: "MET-23",
    term: "work part",
    definition: "Something else.",
  });
  assert.equal(again, undefined);
  assert.match(await readFile(join(dir, path ?? ""), "utf8"), /split creates/);
});

test("readGlossary returns each term note body, sorted, without frontmatter", async () => {
  const dir = await vault();
  assert.deepEqual(await readGlossary(dir), []);
  await writeGlossaryTerm(dir, { issue: "MET-1", term: "Zeta", definition: "Last." });
  await writeGlossaryTerm(dir, { issue: "MET-1", term: "Alpha", definition: "First." });
  assert.deepEqual(await readGlossary(dir), ["**Alpha**:\nFirst.", "**Zeta**:\nLast."]);
});

test("writeDraftDecision writes a draft record in the D-NNN style and never overwrites", async () => {
  const dir = await vault();
  const draft = {
    issue: "MET-22",
    title: "Terms go to the workspace vault",
    decision: "The loop writes new terms to the workspace vault, not GLOSSARY.md.",
    why: "GLOSSARY.md stays human-reviewed.",
  };
  const path = await writeDraftDecision(dir, draft, new Date("2026-11-20T10:00:00Z"));
  assert.equal(path, "decision-drafts/MET-22-terms-go-to-the-workspace-vault.md");
  assert.equal(
    await readFile(join(dir, path ?? ""), "utf8"),
    [
      "---",
      "issue: MET-22",
      "status: draft",
      "---",
      "",
      "# D-NNN Terms go to the workspace vault",
      "Status: draft 2026-11-20. From the coordinator grill of MET-22; open a docs PR to accept it.",
      "",
      "The loop writes new terms to the workspace vault, not GLOSSARY.md.",
      "",
      "Why: GLOSSARY.md stays human-reviewed.",
      "",
      "Issue: MET-22.",
      "",
    ].join("\n"),
  );
  assert.equal(await writeDraftDecision(dir, { ...draft, why: "Other." }), undefined);
});
