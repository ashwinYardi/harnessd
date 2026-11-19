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
