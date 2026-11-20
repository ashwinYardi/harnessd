import assert from "node:assert/strict";
import { test } from "node:test";
import { parseConfigFile } from "@harnessd/shared";
import { parse } from "smol-toml";
import { applyTeam, TeamEditError } from "./team.ts";

const FILE = `# Workspace config for this repo.
[linear]
team_id = "MET" # the team key

# Backend runs on Codex for now.
[agents.backend]
role = "backend"
harness = "codex" # trial
model = "gpt-5"
instructions = """
role = "not a key"
"""

# Docs writer.
[agents.docs]
role = "frontend"
harness = "claude-code"

[slack]
summary_time = "21:00"
`;

test("applyTeam changes keys in place and keeps comments and other tables", () => {
  const out = applyTeam(FILE, {
    set: { backend: { role: "backend", harness: "claude-code", model: "opus" } },
    remove: [],
  });
  assert.match(out, /^# Workspace config for this repo\.$/m);
  assert.match(out, /team_id = "MET" # the team key/);
  assert.match(out, /# Backend runs on Codex for now\.\n\[agents\.backend\]/);
  assert.match(out, /^harness = "claude-code" # trial$/m);
  assert.match(out, /^model = "opus"$/m);
  assert.match(out, /^role = "not a key"$/m, "multi-line string body untouched");
  assert.match(out, /\[slack\]\nsummary_time = "21:00"/);
  assert.equal(out.match(/^role = "backend"$/gm)?.length, 1);
  parseConfigFile(parse(out), "config.toml");
});

test("applyTeam removes a model when it is cleared", () => {
  const out = applyTeam(FILE, {
    set: { backend: { role: "backend", harness: "codex" } },
    remove: [],
  });
  assert.doesNotMatch(out, /model = "gpt-5"/);
});

test("applyTeam removes a table with its leading comment and adds new tables after the last agent", () => {
  const out = applyTeam(FILE, {
    set: { reviewer: { role: "qa", harness: "claude-code", model: "sonnet" } },
    remove: ["docs"],
  });
  assert.doesNotMatch(out, /agents\.docs|Docs writer/);
  assert.match(
    out,
    /\[agents\.reviewer\]\nrole = "qa"\nharness = "claude-code"\nmodel = "sonnet"\n\n\[slack\]/,
  );
  const parsed = parseConfigFile(parse(out), "config.toml");
  assert.deepEqual(Object.keys(parsed.agents ?? {}), ["backend", "reviewer"]);
});

test("applyTeam writes a first agent table into a file without one, or into an empty file", () => {
  const out = applyTeam('[linear]\nteam_id = "MET"\n', {
    set: { qa: { role: "qa", harness: "codex" } },
    remove: [],
  });
  assert.equal(out, '[linear]\nteam_id = "MET"\n\n[agents.qa]\nrole = "qa"\nharness = "codex"\n');
  assert.equal(
    applyTeam("", { set: { qa: { role: "qa", harness: "codex" } }, remove: [] }),
    '[agents.qa]\nrole = "qa"\nharness = "codex"\n',
  );
});

test("applyTeam escapes values as TOML strings", () => {
  const out = applyTeam("", {
    set: { a: { role: "qa", harness: "codex", model: 'x"y\\z' } },
    remove: [],
  });
  assert.equal((parse(out) as { agents: { a: { model: string } } }).agents.a.model, 'x"y\\z');
});

test("applyTeam refuses agents written in a form it cannot edit safely", () => {
  assert.throws(
    () => applyTeam('[agents]\nbackend = { role = "backend" }\n', { set: {}, remove: ["backend"] }),
    TeamEditError,
  );
  assert.throws(
    () => applyTeam('agents.backend.role = "backend"\n', { set: {}, remove: [] }),
    TeamEditError,
  );
});
