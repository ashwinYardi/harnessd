import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createFileDecisionSink, workspaceVaultDir } from "./decisions.ts";

test("file sink writes the note into the workspace vault via writeDecisionNote", async () => {
  const repo = await mkdtemp(join(tmpdir(), "harnessd-notes-"));
  try {
    const vault = workspaceVaultDir(repo);
    assert.equal(vault, join(repo, ".harnessd", "vault"));
    const sink = createFileDecisionSink(vault);
    const note = {
      issue: "MET-41",
      title: "Which channel",
      question: 'Which "channel"?',
      decision: "#harnessd",
      basis: "SPEC Visibility",
    };
    const path = await sink.write(note);
    assert.equal(path, join(vault, "decisions", "MET-41-which-channel.md"));
    const text = await readFile(path, "utf8");
    assert.match(text, /^---\n/);
    assert.match(text, /issue: "?MET-41"?/);
    assert.match(text, /# MET-41: Which channel/);
    assert.match(text, /## Decision\n\n#harnessd/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("file sink writes terms to glossary/ and drafts to decision-drafts/, once each", async () => {
  const repo = await mkdtemp(join(tmpdir(), "harnessd-notes-"));
  try {
    const vault = workspaceVaultDir(repo);
    const sink = createFileDecisionSink(vault);
    const term = { issue: "MET-22", term: "Work part", definition: "A sub-issue.", avoid: [] };
    assert.equal(await sink.term?.(term), join(vault, "glossary", "work-part.md"));
    assert.equal(await sink.term?.(term), undefined);
    const draft = { issue: "MET-22", title: "Vault terms", decision: "D.", why: "W." };
    const path = await sink.draft?.(draft);
    assert.equal(path, join(vault, "decision-drafts", "MET-22-vault-terms.md"));
    assert.match(await readFile(path ?? "", "utf8"), /# D-NNN Vault terms\nStatus: draft /);
    assert.equal(await sink.draft?.(draft), undefined);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
