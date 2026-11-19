import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ESCALATION_TRIGGERS, type Issue } from "@harnessd/shared";
import { buildGrillPrompt, loadGrillContext } from "./prompt.ts";

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
