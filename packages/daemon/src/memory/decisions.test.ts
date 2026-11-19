import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { parseFrontmatter } from "../config/frontmatter.ts";
import { slugify, writeDecisionNote } from "./decisions.ts";
import { searchNotes } from "./vault.ts";

const roots: string[] = [];
after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

test("writeDecisionNote writes decisions/<ISSUE>-<slug>.md with frontmatter and body", async () => {
  const root = await mkdtemp(join(tmpdir(), "harnessd-decision-"));
  roots.push(root);
  const vault = join(root, "vault");
  const path = await writeDecisionNote(vault, {
    issue: "met-11",
    title: "Store the queue in Linear, not SQLite!",
    question: "Where does the coordinator keep its queue?",
    decision: "Read it from Linear on every tick.",
    basis: "SPEC: Linear is the source of truth; D-005: no database in v1.",
  });
  assert.equal(path, "decisions/MET-11-store-the-queue-in-linear-not-sqlite.md");
  const text = await readFile(join(vault, path), "utf8");
  assert.equal(
    text,
    [
      "---",
      "issue: MET-11",
      "question: Where does the coordinator keep its queue?",
      "decision: Read it from Linear on every tick.",
      'basis: "SPEC: Linear is the source of truth; D-005: no database in v1."',
      "---",
      "",
      "# MET-11: Store the queue in Linear, not SQLite!",
      "",
      "## Question",
      "",
      "Where does the coordinator keep its queue?",
      "",
      "## Decision",
      "",
      "Read it from Linear on every tick.",
      "",
      "## Basis",
      "",
      "SPEC: Linear is the source of truth; D-005: no database in v1.",
      "",
    ].join("\n"),
  );
  const { data } = parseFrontmatter(text, path);
  assert.deepEqual(Object.keys(data), ["issue", "question", "decision", "basis"]);
  assert.equal(data.issue, "MET-11");
  assert.equal((await searchNotes(vault, "source of truth"))[0]?.path, path);
});

test("writeDecisionNote rejects a bad issue key or empty fields", async () => {
  const note = { issue: "MET-1", title: "t", question: "q", decision: "d", basis: "b" };
  await assert.rejects(
    writeDecisionNote("/nonexistent", { ...note, issue: "../x" }),
    /issue must be a key/,
  );
  await assert.rejects(
    writeDecisionNote("/nonexistent", { ...note, basis: " " }),
    /basis is required/,
  );
});

test("slugify keeps ascii words and caps the length", () => {
  assert.equal(slugify("Café: use Postgres?"), "cafe-use-postgres");
  assert.equal(slugify("!!!"), "decision");
  assert.equal(slugify("a".repeat(80)).length, 60);
});
