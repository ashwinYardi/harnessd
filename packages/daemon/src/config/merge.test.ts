import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigError, type ConfigLayer, DEFAULT_SETTINGS } from "@harnessd/shared";
import { deepMerge, mergeLayers, resolveAgentConfig } from "./merge.ts";

function layer(scope: ConfigLayer["scope"], extra: Partial<ConfigLayer> = {}): ConfigLayer {
  return {
    scope,
    dir: `/${scope}`,
    settings: {},
    agents: {},
    rules: [],
    skills: [],
    mcp: {},
    skillSettings: {},
    ...extra,
  };
}

test("no layers gives the defaults", () => {
  const merged = mergeLayers([]);
  assert.deepEqual(merged.limits, {
    max_concurrent: 1,
    max_parents: 1,
    budget_minutes: { S: 30, M: 120 },
    token_budget: { S: 3_000_000, M: 6_000_000 },
    cached_token_weight: 0.1,
    max_turns: { S: 80, M: 160 },
    qa_max_failures: 2,
  });
  assert.equal(merged.slack.channel, "#harnessd");
  assert.equal(merged.daemon.port, 4747);
  assert.equal(merged.daemon.self_update, true);
  assert.deepEqual(merged.merge.protected_paths, DEFAULT_SETTINGS.merge.protected_paths);
  assert.deepEqual(Object.keys(merged.agents), [
    "coordinator",
    "backend",
    "frontend",
    "qa",
    "reviewer",
  ]);
  for (const agent of Object.values(merged.agents)) {
    if (agent.name === "reviewer") continue;
    assert.equal(agent.harness, "claude-code");
  }
  assert.deepEqual(merged.agents.reviewer, {
    name: "reviewer",
    role: "reviewer",
    harness: "codex",
    model: "gpt-6.2-sol",
    instructions: [],
  });
  assert.deepEqual(merged.instructions, []);
});

test("scalars override and tables deep-merge, later layer winning", () => {
  const merged = mergeLayers([
    layer("global", {
      settings: {
        limits: { max_concurrent: 5, budget_minutes: { S: 10 } },
        linear: { team_id: "MET" },
      },
    }),
    layer("workspace", {
      settings: { limits: { budget_minutes: { M: 60 } }, linear: { project: "harnessd" } },
    }),
  ]);
  assert.deepEqual(merged.limits, {
    max_concurrent: 5,
    max_parents: 1,
    budget_minutes: { S: 10, M: 60 },
    token_budget: { S: 3_000_000, M: 6_000_000 },
    cached_token_weight: 0.1,
    max_turns: { S: 80, M: 160 },
    qa_max_failures: 2,
  });
  assert.deepEqual(merged.linear, { team_id: "MET", project: "harnessd" });
});

test("limits merge per key, the cached weight included", () => {
  const merged = mergeLayers([
    layer("global", {
      settings: {
        limits: {
          token_budget: { S: 1_000 },
          cached_token_weight: 0.25,
          max_turns: { S: 40 },
        },
      },
    }),
    layer("workspace", {
      settings: { limits: { cached_token_weight: 0.05, max_turns: { M: 90 } } },
    }),
  ]);
  assert.deepEqual(merged.limits, {
    max_concurrent: 1,
    max_parents: 1,
    budget_minutes: { S: 30, M: 120 },
    token_budget: { S: 1_000, M: 6_000_000 },
    cached_token_weight: 0.05,
    max_turns: { S: 40, M: 90 },
    qa_max_failures: 2,
  });
});

test("max_parents merges per layer, the workspace winning", () => {
  const merged = mergeLayers([
    layer("global", { settings: { limits: { max_parents: 2 } } }),
    layer("workspace", { settings: { limits: { max_parents: 3 } } }),
  ]);
  assert.equal(merged.limits.max_parents, 3);
  assert.equal(merged.limits.max_concurrent, 1);
});

test("qa commands default to pnpm and merge per key", () => {
  assert.deepEqual(mergeLayers([]).qa, {
    setup_command: "pnpm install --frozen-lockfile --prefer-offline",
    test_command: "pnpm test",
  });
  const merged = mergeLayers([layer("workspace", { settings: { qa: { setup_command: "" } } })]);
  assert.deepEqual(merged.qa, { setup_command: "", test_command: "pnpm test" });
});

test("arrays replace rather than concatenate", () => {
  const merged = mergeLayers([
    layer("global", { settings: { merge: { protected_paths: ["a/**"] } } }),
    layer("workspace", { settings: { merge: { protected_paths: ["b/**"] } } }),
  ]);
  assert.deepEqual(merged.merge.protected_paths, ["b/**"]);
});

test("merging never mutates the defaults", () => {
  const before = structuredClone(DEFAULT_SETTINGS);
  const merged = mergeLayers([
    layer("global", { settings: { limits: { budget_minutes: { S: 1 } } } }),
  ]);
  merged.merge.protected_paths.push("x");
  assert.deepEqual(DEFAULT_SETTINGS, before);
});

test("deepMerge ignores undefined values", () => {
  assert.deepEqual(deepMerge({ a: 1, b: { c: 2 } }, { b: {} }), { a: 1, b: { c: 2 } });
});

test("agent fields override per layer and instructions accumulate", () => {
  const merged = mergeLayers([
    layer("global", {
      agents: {
        backend: {
          model: "opus",
          instructions: { source: "g", text: "global backend" },
          label: "g",
          keyPrefix: "",
        },
      },
    }),
    layer("workspace", {
      agents: {
        backend: {
          harness: "codex",
          instructions: { source: "w", text: "ws backend" },
          label: "w",
          keyPrefix: "",
        },
      },
    }),
  ]);
  const backend = merged.agents.backend;
  assert.equal(backend?.harness, "codex");
  assert.equal(backend?.model, "opus");
  assert.equal(backend?.role, "backend");
  assert.deepEqual(
    backend?.instructions.map((b) => b.text),
    ["global backend", "ws backend"],
  );
});

test("a layer overrides the reviewer's harness, model and fallbacks (MET-222)", () => {
  const merged = mergeLayers([
    layer("workspace", {
      agents: {
        reviewer: {
          harness: "claude-code",
          model: "opus",
          fallback_harness: "codex",
          fallback_model: "gpt-5",
          label: "w",
          keyPrefix: "",
        },
      },
    }),
  ]);
  assert.deepEqual(merged.agents.reviewer, {
    name: "reviewer",
    role: "reviewer",
    harness: "claude-code",
    model: "opus",
    fallback_harness: "codex",
    fallback_model: "gpt-5",
    instructions: [],
  });
});

test("custom agents need a role", () => {
  assert.throws(
    () =>
      mergeLayers([
        layer("global", {
          agents: { docs: { label: "~/.harnessd/config.toml", keyPrefix: "agents.docs" } },
        }),
      ]),
    (e: unknown) =>
      e instanceof ConfigError &&
      e.message.startsWith(
        "~/.harnessd/config.toml: agents.docs.role: required for agents other than the defaults",
      ),
  );
  const merged = mergeLayers([
    layer("global", { agents: { docs: { role: "backend", label: "x", keyPrefix: "" } } }),
  ]);
  assert.deepEqual(merged.agents.docs, {
    name: "docs",
    role: "backend",
    harness: "claude-code",
    instructions: [],
  });
});

test("rules and skills merge by name, later layer winning", () => {
  const merged = mergeLayers([
    layer("global", {
      rules: [
        { name: "style", source: "g/style.md", text: "global style" },
        { name: "tests", source: "g/tests.md", text: "global tests" },
      ],
      skills: [{ name: "deploy", dir: "g/deploy", source: "g/deploy/SKILL.md", body: "g" }],
    }),
    layer("workspace", {
      rules: [{ name: "style", source: "w/style.md", text: "ws style" }],
      skills: [
        { name: "deploy", dir: "w/deploy", source: "w/deploy/SKILL.md", body: "w" },
        { name: "bench", dir: "w/bench", source: "w/bench/SKILL.md", body: "b" },
      ],
    }),
  ]);
  assert.deepEqual(
    merged.rules.map((r) => [r.name, r.text]),
    [
      ["style", "ws style"],
      ["tests", "global tests"],
    ],
  );
  assert.deepEqual(
    merged.skills.map((s) => [s.name, s.body]),
    [
      ["bench", "b"],
      ["deploy", "w"],
    ],
  );
});

test("a skill turned off in a later layer is dropped, and a later layer can turn it back on", () => {
  const skill = (name: string) => ({
    name,
    dir: `g/${name}`,
    source: `g/${name}/SKILL.md`,
    body: "",
  });
  const global = layer("global", {
    skills: [skill("tdd"), skill("research"), skill("prototype")],
    skillSettings: { tdd: { commit: "abc" }, prototype: { enabled: false } },
  });
  const merged = mergeLayers([
    global,
    layer("workspace", {
      skillSettings: {
        research: { enabled: false },
        prototype: { enabled: true },
        nope: { enabled: false },
      },
    }),
  ]);
  assert.deepEqual(
    merged.skills.map((s) => s.name),
    ["prototype", "tdd"],
  );
  assert.deepEqual(
    resolveAgentConfig(merged, "backend").skills.map((s) => s.name),
    ["prototype", "tdd"],
  );
  assert.deepEqual(
    mergeLayers([global]).skills.map((s) => s.name),
    ["research", "tdd"],
  );
});

test("resolveAgentConfig concatenates global, workspace, then agent instructions", () => {
  const merged = mergeLayers([
    layer("global", {
      instructions: { source: "g/AGENTS.md", text: "GLOBAL" },
      agents: {
        qa: { instructions: { source: "g/qa.md", text: "GLOBAL QA" }, label: "g", keyPrefix: "" },
      },
      rules: [{ name: "r", source: "g/r.md", text: "rule" }],
    }),
    layer("workspace", {
      instructions: { source: "w/AGENTS.md", text: "WORKSPACE" },
      agents: {
        qa: {
          model: "sonnet",
          instructions: { source: "w/qa.md", text: "WS QA" },
          label: "w",
          keyPrefix: "",
        },
      },
    }),
  ]);
  const qa = resolveAgentConfig(merged, "qa");
  assert.equal(qa.instructions, "GLOBAL\n\nWORKSPACE\n\nGLOBAL QA\n\nWS QA");
  assert.equal(qa.harness, "claude-code");
  assert.equal(qa.model, "sonnet");
  assert.equal(qa.role, "qa");
  assert.deepEqual(
    qa.rules.map((r) => r.name),
    ["r"],
  );
  const backend = resolveAgentConfig(merged, "backend");
  assert.equal(backend.instructions, "GLOBAL\n\nWORKSPACE");
  assert.equal("model" in backend, false);
});

test("fallback_harness and fallback_model override per layer and resolve", () => {
  const merged = mergeLayers([
    layer("global", {
      agents: {
        backend: { fallback_harness: "codex", fallback_model: "gpt-5", label: "g", keyPrefix: "" },
      },
    }),
    layer("workspace", {
      agents: { backend: { fallback_model: "gpt-5-codex", label: "w", keyPrefix: "" } },
    }),
  ]);
  const backend = resolveAgentConfig(merged, "backend");
  assert.equal(backend.fallback_harness, "codex");
  assert.equal(backend.fallback_model, "gpt-5-codex");
  const qa = resolveAgentConfig(merged, "qa");
  assert.equal("fallback_harness" in qa, false);
  assert.equal("fallback_model" in qa, false);
});

test("resolveAgentConfig rejects unknown agents", () => {
  assert.throws(() => resolveAgentConfig(mergeLayers([]), "nobody"), /unknown agent "nobody"/);
});

test("mcp servers merge by name and a later layer replaces the whole entry", () => {
  const merged = mergeLayers([
    layer("global", {
      mcp: {
        zeta: { command: "zeta" },
        docs: { command: "docs", args: ["--global"], env: { A: "1" } },
      },
    }),
    layer("workspace", { mcp: { docs: { command: "docs-local" }, alpha: { command: "alpha" } } }),
  ]);
  assert.deepEqual(Object.keys(merged.mcp), ["alpha", "docs", "zeta"]);
  assert.deepEqual(merged.mcp.docs, { command: "docs-local" });
});
