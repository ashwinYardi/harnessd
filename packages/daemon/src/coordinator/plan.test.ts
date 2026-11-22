import assert from "node:assert/strict";
import { test } from "node:test";
import {
  emptyTokenUsage,
  type HarnessAdapter,
  type Issue,
  type ResolvedAgentConfig,
  type RunResult,
  type Task,
} from "@harnessd/shared";
import {
  buildPlanPrompt,
  fallbackPlan,
  MAX_PLAN_PARTS,
  parsePlanReply,
  planIssue,
} from "./plan.ts";

function issue(fields: Partial<Issue> = {}): Issue {
  return {
    id: "id-1",
    key: "MET-40",
    title: "Agents show avatars",
    description:
      "**Why**\nPeople tell agents apart.\n\n**Done when**\n- [ ] Avatars show\n\n**Size**: M",
    priority: 2,
    state: "Ready",
    labels: ["coordinator"],
    size: "M",
    doneWhen: [{ text: "Avatars show", checked: false }],
    url: "https://linear.test/MET-40",
    blockedBy: [],
    ...fields,
  };
}

const agent: ResolvedAgentConfig = {
  name: "coordinator",
  role: "coordinator",
  harness: "claude-code",
  instructions: "Keep parts small.",
  rules: [],
  skills: [],
};

function adapterReplying(
  reply: string | { status: RunResult["status"]; error: string },
  turns?: number,
) {
  const tasks: Task[] = [];
  const adapter: HarnessAdapter = {
    id: "claude-code",
    start(task) {
      tasks.push(task);
      const result: RunResult = {
        status: typeof reply === "string" ? "ok" : reply.status,
        exitCode: 0,
        durationMs: 1,
        tokens: emptyTokenUsage(),
      };
      if (turns !== undefined) result.turns = turns;
      if (typeof reply === "string") result.finalText = reply;
      else result.error = reply.error;
      return {
        events: (async function* () {
          yield { type: "end" as const, result };
        })(),
        result: Promise.resolve(result),
        cancel: async () => {},
      };
    },
  };
  return { adapter, tasks };
}

const part = (role: string, size = "S") => ({
  role,
  title: `${role} work`,
  prompt: "Do it.",
  size,
});

test("parsePlanReply accepts strict JSON with a reason, also inside a code fence", () => {
  const reply = JSON.stringify({
    parts: [part("backend"), part("frontend", "m")],
    reason: "The UI needs the API first.",
  });
  assert.deepEqual(parsePlanReply(reply), {
    ok: true,
    parts: [
      { role: "backend", title: "backend work", prompt: "Do it.", size: "S" },
      { role: "frontend", title: "frontend work", prompt: "Do it.", size: "M" },
    ],
    reason: "The UI needs the API first.",
  });
  assert.equal(parsePlanReply(`Here:\n\`\`\`json\n${reply}\n\`\`\``).ok, true);
});

test("a plan with more than one part and no reason is invalid (D-040)", () => {
  const parsed = parsePlanReply(JSON.stringify({ parts: [part("backend"), part("frontend")] }));
  assert.equal(parsed.ok, false);
  if (!parsed.ok) assert.match(parsed.error, /reason: a plan with more than one part/);
  assert.equal(parsePlanReply(JSON.stringify({ parts: [part("backend")] })).ok, true);
});

test("a blank reason counts as no reason: one part is valid and keeps its own brief", () => {
  for (const reason of ["", "  \t"]) {
    const parsed = parsePlanReply(
      JSON.stringify({ parts: [{ ...part("backend"), prompt: "Own brief." }], reason }),
    );
    assert.equal(parsed.ok, true, JSON.stringify(reason));
    if (parsed.ok) {
      assert.equal(parsed.parts.length, 1);
      assert.equal(parsed.parts[0]?.prompt, "Own brief.");
      assert.equal("reason" in parsed, false);
    }
  }
});

test("a blank reason is still invalid for a plan with more than one part (D-040)", () => {
  for (const reason of ["", "  \t"]) {
    const parsed = parsePlanReply(
      JSON.stringify({ parts: [part("backend"), part("frontend")], reason }),
    );
    assert.equal(parsed.ok, false, JSON.stringify(reason));
    if (!parsed.ok) assert.match(parsed.error, /more than one part/);
  }
});

test("parsePlanReply parses L so the loop can refuse it", () => {
  const parsed = parsePlanReply(JSON.stringify({ parts: [part("backend", "L")] }));
  assert.equal(parsed.ok && parsed.parts[0]?.size, "L");
});

test("parsePlanReply rejects anything off-shape", () => {
  const cases: Array<[unknown, RegExp]> = [
    [[], /expected a JSON object/],
    [{ parts: [], notes: "x" }, /unknown key "notes"/],
    [{ parts: "x" }, /parts: expected an array/],
    [{ parts: [] }, /at least one part/],
    [{ parts: Array.from({ length: MAX_PLAN_PARTS + 1 }, () => part("backend")) }, /at most 6/],
    [{ parts: [{ ...part("backend"), extra: 1 }] }, /parts\[0\]: unknown key "extra"/],
    [{ parts: [{ ...part("backend"), title: " " }] }, /parts\[0\]\.title: expected a non-empty/],
    [{ parts: [part("qa")] }, /role: expected backend or frontend, got "qa"/],
    [{ parts: [part("backend", "XL")] }, /size: expected S or M, got "XL"/],
    [{ parts: [part("backend")], reason: 5 }, /reason: expected a string/],
    [{ parts: [part("backend")], reason: null }, /reason: expected a string/],
    [{ parts: [part("backend")], reason: { why: "x" } }, /reason: expected a string/],
  ];
  for (const [value, error] of cases) {
    const parsed = parsePlanReply(JSON.stringify(value));
    assert.equal(parsed.ok, false, JSON.stringify(value));
    if (!parsed.ok) assert.match(parsed.error, error);
  }
  const prose = parsePlanReply("I think two parts.");
  assert.equal(prose.ok, false);
  if (!prose.ok) assert.match(prose.error, /^not JSON/);
});

test("fallbackPlan is one part: frontend with the ui label, else backend, at the issue size", () => {
  assert.deepEqual(
    fallbackPlan(issue({ labels: ["ui"], size: "S" })).map((p) => [p.role, p.size, p.title]),
    [["frontend", "S", "Agents show avatars"]],
  );
  assert.deepEqual(
    fallbackPlan(issue()).map((p) => [p.role, p.size]),
    [["backend", "M"]],
  );
  assert.equal(fallbackPlan(issue({ size: undefined }))[0]?.size, "M");
});

test("buildPlanPrompt carries the rules, the issue, the grill calls and the context", () => {
  const prompt = buildPlanPrompt({
    issue: issue(),
    context: { spec: "THE SPEC", decisions: [{ name: "D-014", text: "Sizes." }] },
    instructions: "Keep parts small.",
    calls: [{ question: "Where?", answer: "daemon", basis: "SPEC" }],
  });
  for (const text of [
    "Reply with strict JSON only",
    "Plan ONE part by default",
    '"reason" must say why',
    'For a one-part plan, leave out "reason".',
    "L is not allowed",
    "Do not plan QA",
    "## Coordinator instructions\nKeep parts small.",
    "## Issue MET-40: Agents show avatars",
    "- [ ] Avatars show",
    "- Where? → daemon",
    "THE SPEC",
    "### D-014\nSizes.",
  ]) {
    assert.ok(prompt.includes(text), text);
  }
});

test("planIssue runs the coordinator harness and returns the model plan", async () => {
  const { adapter, tasks } = adapterReplying(JSON.stringify({ parts: [part("backend")] }));
  const plan = await planIssue(issue(), {
    adapter,
    agent: { ...agent, model: "opus" },
    context: { spec: "", decisions: [] },
    cwd: "/repo",
  });
  assert.equal(plan.source, "model");
  assert.equal(plan.parts.length, 1);
  assert.equal(tasks[0]?.id, "plan-MET-40");
  assert.equal(tasks[0]?.budgetMs, 10 * 60_000);
  assert.equal(tasks[0]?.model, "opus");
});

test("planIssue returns the turn count the harness reports, so the log line shows it", async () => {
  const { adapter } = adapterReplying(JSON.stringify({ parts: [part("backend")] }), 7);
  const plan = await planIssue(issue(), {
    adapter,
    agent,
    context: { spec: "", decisions: [] },
    cwd: "/repo",
  });
  assert.equal(plan.turns, 7);
  const { adapter: silent } = adapterReplying(JSON.stringify({ parts: [part("backend")] }));
  const none = await planIssue(issue(), {
    adapter: silent,
    agent,
    context: { spec: "", decisions: [] },
    cwd: "/repo",
  });
  assert.equal(none.turns, undefined);
});

test("planIssue keeps a one-part plan with a blank reason and its own brief", async () => {
  const { adapter } = adapterReplying(
    JSON.stringify({ parts: [{ ...part("backend"), prompt: "Own brief." }], reason: "" }),
  );
  const plan = await planIssue(issue(), {
    adapter,
    agent,
    context: { spec: "", decisions: [] },
    cwd: "/repo",
  });
  assert.equal(plan.source, "model");
  assert.equal(plan.parts.length, 1);
  assert.equal(plan.parts[0]?.prompt, "Own brief.");
  assert.equal("reason" in plan, false);
});

test("planIssue falls back to one part when a two-part plan has a blank reason", async () => {
  const { adapter } = adapterReplying(
    JSON.stringify({ parts: [part("backend"), part("frontend")], reason: "" }),
  );
  const plan = await planIssue(issue(), {
    adapter,
    agent,
    context: { spec: "", decisions: [] },
    cwd: "/repo",
  });
  assert.equal(plan.source, "fallback");
  assert.match(plan.error ?? "", /more than one part/);
  assert.deepEqual(plan.parts, fallbackPlan(issue()));
  assert.equal(plan.parts.length, 1);
});

test("planIssue falls back on a bad reply, a failed run or a harness mismatch", async () => {
  const deps = { agent, context: { spec: "", decisions: [] }, cwd: "/repo" };
  const bad = await planIssue(issue(), { ...deps, adapter: adapterReplying("nope").adapter });
  assert.equal(bad.source, "fallback");
  assert.match(bad.error ?? "", /not JSON/);
  assert.deepEqual(bad.parts, fallbackPlan(issue()));

  const failed = await planIssue(issue(), {
    ...deps,
    adapter: adapterReplying({ status: "timeout", error: "over budget" }).adapter,
  });
  assert.equal(failed.source, "fallback");

  const other = adapterReplying("{}");
  const mismatch = await planIssue(issue(), {
    ...deps,
    adapter: { ...other.adapter, id: "codex" },
  });
  assert.equal(mismatch.source, "fallback");
  assert.match(mismatch.error ?? "", /does not match/);
  assert.equal(other.tasks.length, 0);
});

test("a limited plan run is no plan and no fallback (MET-70)", async () => {
  const plan = await planIssue(issue(), {
    agent,
    context: { spec: "", decisions: [] },
    cwd: "/repo",
    adapter: adapterReplying({ status: "limited", error: "usage limit reached" }).adapter,
  });
  assert.equal(plan.source, "limited");
  assert.deepEqual(plan.parts, []);
  assert.match(plan.error ?? "", /usage limit reached/);
});
