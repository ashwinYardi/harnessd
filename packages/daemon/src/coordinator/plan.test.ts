import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  HarnessAdapter,
  Issue,
  ResolvedAgentConfig,
  RunResult,
  Task,
  TokenUsage,
} from "@harnessd/shared";
import {
  buildPlanPrompt,
  checkPlan,
  MAX_PART_FILES,
  MAX_PLAN_PARTS,
  type PlanPart,
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

/** A part in the fixed brief shape the plan reply must use (MET-160). */
function brief(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    role: "backend",
    title: "backend work",
    size: "S",
    goal: "Add the avatar field to the API.",
    doneWhen: [1],
    files: ["packages/daemon/src/api.ts"],
    steps: ["Add the field."],
    verify: [{ run: "pnpm test", expect: "passes" }],
    outOfScope: "The UI.",
    ...fields,
  };
}

function reply(parts: unknown[], reason: unknown = "The work fits one part."): string {
  return JSON.stringify({ parts, reason });
}

type Reply = string | { status: RunResult["status"]; error?: string; reason?: RunResult["reason"] };

const RUN_TOKENS: TokenUsage = { input: 10, output: 1, cacheRead: 0, cacheWrite: 0 };

/**
 * Answers each plan run with the next reply and repeats the last one. The first run gets
 * the first reply, the retry the second. Every run reports the same token use, so a plan
 * that retries shows the summed use.
 */
function adapterReplying(...replies: Reply[]) {
  const tasks: Task[] = [];
  const adapter: HarnessAdapter = {
    id: "claude-code",
    start(task) {
      tasks.push(task);
      const next = replies.length > 1 ? replies.shift() : replies[0];
      if (next === undefined) throw new Error("no reply");
      const result: RunResult = {
        status: typeof next === "string" ? "ok" : next.status,
        exitCode: 0,
        durationMs: 1,
        tokens: RUN_TOKENS,
      };
      if (typeof next === "string") result.finalText = next;
      else {
        if (next.error !== undefined) result.error = next.error;
        if (next.reason !== undefined) result.reason = next.reason;
      }
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

const planDeps = { agent, context: { spec: "", decisions: [] }, cwd: "/repo" };

test("parsePlanReply accepts a part with the fixed brief fields and a reason", () => {
  const parsed = parsePlanReply(
    reply([brief({ size: "m" })], "The UI and the API are separate parts."),
  );
  assert.deepEqual(parsed, {
    ok: true,
    parts: [
      {
        role: "backend",
        title: "backend work",
        size: "M",
        goal: "Add the avatar field to the API.",
        doneWhen: [1],
        files: ["packages/daemon/src/api.ts"],
        steps: ["Add the field."],
        verify: [{ run: "pnpm test", expect: "passes" }],
        outOfScope: "The UI.",
      },
    ],
    reason: "The UI and the API are separate parts.",
  });
  assert.equal(parsePlanReply(reply([brief()])).ok, true);
  assert.equal(parsePlanReply(`Here:\n\`\`\`json\n${reply([brief()])}\n\`\`\``).ok, true);
});

test("reason is required for every plan, one part or more", () => {
  for (const [value, why] of [
    [undefined, "missing"],
    ["", "blank"],
    ["  \t", "blank"],
    [5, "not a string"],
    [null, "null"],
  ] as const) {
    const raw = value === undefined ? { parts: [brief()] } : { parts: [brief()], reason: value };
    for (const parts of [[brief()], [brief(), brief({ role: "frontend" })]]) {
      const parsed = parsePlanReply(JSON.stringify({ ...raw, parts }));
      assert.equal(parsed.ok, false, `${why}, ${parts.length} part(s)`);
      if (!parsed.ok) assert.match(parsed.error, /reason: expected a non-empty string/);
    }
  }
});

test("parsePlanReply rejects an unknown key, including the old prompt key", () => {
  for (const extra of [{ prompt: "Do it." }, { extra: 1 }]) {
    const parsed = parsePlanReply(reply([brief(extra)]));
    assert.equal(parsed.ok, false, JSON.stringify(extra));
    if (!parsed.ok) assert.match(parsed.error, /unknown key/);
  }
});

test("parsePlanReply rejects a part that misses a brief field", () => {
  for (const key of ["goal", "doneWhen", "files", "steps", "verify", "outOfScope"]) {
    const part = brief();
    delete part[key];
    const parsed = parsePlanReply(reply([part]));
    assert.equal(parsed.ok, false, key);
    if (!parsed.ok) assert.match(parsed.error, new RegExp(`parts\\[0\\]\\.${key}: expected`));
  }
});

test("parsePlanReply rejects off-shape brief fields", () => {
  const cases: Array<[unknown, RegExp]> = [
    [[], /expected a JSON object/],
    [{ parts: [], notes: "x", reason: "One part." }, /unknown key "notes"/],
    [{ parts: "x", reason: "One part." }, /parts: expected an array/],
    [{ parts: [], reason: "One part." }, /at least one part/],
    [
      { parts: Array.from({ length: MAX_PLAN_PARTS + 1 }, () => brief()), reason: "One part." },
      /at most 6/,
    ],
    [
      { parts: [{ ...brief(), title: " " }], reason: "One part." },
      /parts\[0\]\.title: expected a non-empty/,
    ],
    [
      { parts: [{ ...brief(), role: "qa" }], reason: "One part." },
      /role: expected backend or frontend, got "qa"/,
    ],
    [
      { parts: [{ ...brief(), size: "XL" }], reason: "One part." },
      /size: expected S or M, got "XL"/,
    ],
    [
      { parts: [{ ...brief(), goal: 5 }], reason: "One part." },
      /parts\[0\]\.goal: expected a non-empty string/,
    ],
    [
      { parts: [{ ...brief(), doneWhen: "1" }], reason: "One part." },
      /parts\[0\]\.doneWhen: expected an array/,
    ],
    [
      { parts: [{ ...brief(), doneWhen: [0] }], reason: "One part." },
      /doneWhen\[0\]: expected a positive Done-when number/,
    ],
    [
      { parts: [{ ...brief(), doneWhen: [1.5] }], reason: "One part." },
      /doneWhen\[0\]: expected a positive Done-when number/,
    ],
    [
      { parts: [{ ...brief(), files: "x.ts" }], reason: "One part." },
      /parts\[0\]\.files: expected an array/,
    ],
    [{ parts: [{ ...brief(), files: [1] }], reason: "One part." }, /files\[0\]: expected a string/],
    [
      { parts: [{ ...brief(), steps: [{}] }], reason: "One part." },
      /steps\[0\]: expected a string/,
    ],
    [
      { parts: [{ ...brief(), verify: "pnpm test" }], reason: "One part." },
      /parts\[0\]\.verify: expected an array/,
    ],
    [
      { parts: [{ ...brief(), verify: [["pnpm test"]] }], reason: "One part." },
      /verify\[0\]: expected an object/,
    ],
    [
      { parts: [{ ...brief(), verify: [{ run: "pnpm test" }] }], reason: "One part." },
      /verify\[0\]: expected run and expect strings/,
    ],
    [
      {
        parts: [{ ...brief(), verify: [{ run: "pnpm test", expect: "passes", why: "x" }] }],
        reason: "One part.",
      },
      /verify\[0\]: unknown key "why"/,
    ],
    [
      { parts: [{ ...brief(), outOfScope: 5 }], reason: "One part." },
      /parts\[0\]\.outOfScope: expected a non-empty/,
    ],
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

test("parsePlanReply parses L so the loop can refuse it", () => {
  const parsed = parsePlanReply(reply([brief({ size: "L" })]));
  assert.equal(parsed.ok && parsed.parts[0]?.size, "L");
});

test("checkPlan rejects an empty or blank brief field", () => {
  const part = (fields: Partial<PlanPart>): PlanPart => ({
    role: "backend",
    title: "backend work",
    size: "S",
    goal: "Add the field.",
    doneWhen: [1],
    files: ["src/a.ts"],
    steps: ["Add the field."],
    verify: [{ run: "pnpm test", expect: "passes" }],
    outOfScope: "The UI.",
    ...fields,
  });
  const cases: Array<[Partial<PlanPart>, RegExp]> = [
    [{ goal: " " }, /parts\[0\]\.goal: expected a one-sentence goal/],
    [{ files: [] }, /parts\[0\]\.files: expected at least one file/],
    [{ files: [" "] }, /parts\[0\]\.files\[0\]: expected a repo-relative path/],
    [{ steps: [] }, /parts\[0\]\.steps: expected at least one step/],
    [{ steps: [""] }, /parts\[0\]\.steps\[0\]: expected one action/],
    [{ verify: [] }, /parts\[0\]\.verify: expected at least one check/],
    [{ verify: [{ run: "", expect: "passes" }] }, /verify\[0\]: expected run and expect/],
    [{ verify: [{ run: "pnpm test", expect: " " }] }, /verify\[0\]: expected run and expect/],
    [{ outOfScope: "" }, /parts\[0\]\.outOfScope: expected what the part leaves out/],
  ];
  for (const [fields, error] of cases) {
    assert.match(checkPlan([part(fields)], issue()).join("\n"), error);
  }
});

test("checkPlan caps a part at 3 Done-when items and 8 files", () => {
  const many = issue({
    doneWhen: [
      { text: "One", checked: false },
      { text: "Two", checked: false },
      { text: "Three", checked: false },
      { text: "Four", checked: false },
    ],
  });
  const parsed = parsePlanReply(reply([brief({ doneWhen: [1, 2, 3, 4] })]));
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    const errors = checkPlan(parsed.parts, many);
    assert.match(errors.join("\n"), /doneWhen: expected at most 3 items, got 4/);
    assert.equal(errors.filter((e) => /in no part/.test(e)).length, 0);
  }
  const files = Array.from({ length: MAX_PART_FILES + 1 }, (_, i) => `src/f${i}.ts`);
  const eight = parsePlanReply(reply([brief({ files })]));
  assert.equal(eight.ok, true);
  if (eight.ok) {
    assert.match(
      checkPlan(eight.parts, issue()).join("\n"),
      /files: expected at most 8 files, got 9/,
    );
  }
  const ok = parsePlanReply(reply([brief({ files: files.slice(0, MAX_PART_FILES) })]));
  if (ok.ok) assert.ok(MAX_PART_FILES === 8 && ok.parts[0]?.files.length === 8);
});

test("checkPlan rejects a Done-when number outside the parent list", () => {
  const parsed = parsePlanReply(reply([brief({ doneWhen: [2] })]));
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.match(
      checkPlan(parsed.parts, issue()).join("\n"),
      /parts\[0\]\.doneWhen\[0\]: expected a number from 1 to 1, got 2/,
    );
  }
});

test("checkPlan rejects a plan that leaves a parent Done-when item in no part", () => {
  const two = issue({
    doneWhen: [
      { text: "API serves avatars", checked: false },
      { text: "Board shows avatars", checked: false },
    ],
  });
  const parsed = parsePlanReply(reply([brief({ doneWhen: [1] })]));
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    const errors = checkPlan(parsed.parts, two);
    assert.equal(errors.length, 1, errors.join("\n"));
    assert.match(errors[0] ?? "", /Done when item 2 is in no part: "Board shows avatars"/);
  }
  // Two parts that name the same item cover everything: one item may sit in two parts.
  const both = parsePlanReply(
    reply([brief({ role: "backend" }), brief({ role: "frontend", doneWhen: [1, 2] })]),
  );
  assert.equal(both.ok, true);
  if (both.ok) assert.deepEqual(checkPlan(both.parts, two), []);
});

test("checkPlan skips coverage when the parent has no parsed Done-when items", () => {
  const parsed = parsePlanReply(reply([brief({ doneWhen: [] })]));
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.deepEqual(checkPlan(parsed.parts, issue({ doneWhen: [] })), []);
    assert.match(
      checkPlan(parsed.parts, issue()).join("\n"),
      /doneWhen: expected at least one Done-when number/,
    );
  }
});

test("checkPlan returns every error, not only the first", () => {
  const parsed = parsePlanReply(reply([brief({ files: [], steps: [], verify: [] })]));
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    const errors = checkPlan(parsed.parts, issue());
    assert.equal(errors.length, 3, errors.join("\n"));
  }
});

test("parsePlanReply keeps the decisions and drops an id with no record (D-044)", () => {
  const logs: string[] = [];
  const parsed = parsePlanReply(
    reply([
      brief({
        role: "backend",
        decisions: [
          { id: "D-014", line: "Kept." },
          { id: "D-999", line: "Missing." },
        ],
        calls: [1, "How?"],
      }),
    ]),
    { knownIds: new Set(["D-014"]), log: (line) => logs.push(line) },
  );
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.deepEqual(parsed.parts[0]?.decisions, [{ id: "D-014", line: "Kept." }]);
    assert.deepEqual(parsed.parts[0]?.calls, [1, "How?"]);
  }
  assert.deepEqual(logs, ["plan: dropped decision D-999: no record in docs/decisions/"]);
});

test("a malformed decision or call entry makes the reply invalid (D-044)", () => {
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ decisions: "D-014" }, /decisions: expected an array/],
    [{ decisions: [{ id: "D-14", line: "x" }] }, /expected D-NNN, got "D-14"/],
    [{ decisions: [{ id: "D-014", line: "" }] }, /expected id and line strings/],
    [{ calls: [0] }, /expected a positive call number/],
    [{ calls: [true] }, /expected a positive call number/],
  ];
  for (const [extra, error] of cases) {
    const parsed = parsePlanReply(reply([brief(extra)]));
    assert.equal(parsed.ok, false, JSON.stringify(extra));
    if (!parsed.ok) assert.match(parsed.error, error);
  }
});

test("buildPlanPrompt carries the brief fields, the rules, the issue and the context", () => {
  const prompt = buildPlanPrompt({
    issue: issue(),
    context: { spec: "THE SPEC", decisions: [{ name: "D-014", text: "Sizes." }] },
    instructions: "Keep parts small.",
    calls: [{ question: "Where?", answer: "daemon", basis: "SPEC" }],
  });
  for (const text of [
    "Reply with strict JSON only",
    "Plan ONE part by default",
    '"reason" must say why the issue is one part or why it splits',
    "L is not allowed",
    "Do not plan QA",
    "## Coordinator instructions\nKeep parts small.",
    "## Issue MET-40: Agents show avatars",
    "- [ ] Avatars show",
    "1. Where? → daemon",
    "THE SPEC",
    "### D-014\nSizes.",
  ]) {
    assert.ok(prompt.includes(text), text);
  }
  assert.ok(prompt.includes('"goal": "one sentence"'), prompt);
  assert.ok(prompt.includes('"doneWhen": [1, 2]'), prompt);
  assert.ok(prompt.includes('"verify": [{ "run"'), prompt);
  assert.ok(prompt.includes('"outOfScope"'), prompt);
});

test("the plan prompt asks for decision IDs and forbids the read-everything line (D-044)", () => {
  const prompt = buildPlanPrompt({
    issue: issue(),
    context: { spec: "THE SPEC", decisions: [{ name: "D-014", text: "Sizes." }] },
  });
  assert.match(prompt, /"decisions": \[\{ "id": "D-NNN", "line"/);
  assert.match(prompt, /"calls": \[1, "a grill question this part follows"\]/);
  assert.match(prompt, /Each part lists the decision records it depends on/);
  assert.match(prompt, /Each part lists the grill calls that apply to it/);
  assert.match(prompt, /Never write "Read docs\/SPEC\.md and docs\/decisions\/"/);
  assert.doesNotMatch(prompt, /"prompt": "string"/);
});

test("buildPlanPrompt lists the errors of a rejected plan in a retry prompt", () => {
  const prompt = buildPlanPrompt({
    issue: issue(),
    context: { spec: "", decisions: [] },
    errors: ["parts[0].goal: expected a one-sentence goal", "Done when item 1 is in no part"],
  });
  assert.match(prompt, /## Errors in your previous plan/);
  assert.match(prompt, /- parts\[0\]\.goal: expected a one-sentence goal/);
  assert.match(prompt, /- Done when item 1 is in no part/);
});

test("planIssue runs the coordinator harness and returns the model plan", async () => {
  const { adapter, tasks } = adapterReplying(reply([brief()]));
  const plan = await planIssue(issue(), {
    ...planDeps,
    adapter,
    agent: { ...agent, model: "opus" },
  });
  assert.equal(plan.source, "model");
  assert.equal(plan.parts.length, 1);
  assert.equal(plan.reason, "The work fits one part.");
  assert.equal(tasks[0]?.id, "plan-MET-40");
  assert.equal(tasks[0]?.budgetMs, 10 * 60_000);
  assert.equal(tasks[0]?.maxTurns, 50);
  assert.equal(tasks[0]?.model, "opus");
  assert.deepEqual(plan.tokens, RUN_TOKENS);
});

test("planIssue returns the turn count, and sums it over the retry", async () => {
  const tasks: Task[] = [];
  const adapter: HarnessAdapter = {
    id: "claude-code",
    start(task) {
      tasks.push(task);
      const result: RunResult = {
        status: "ok",
        exitCode: 0,
        durationMs: 1,
        tokens: RUN_TOKENS,
        turns: 7,
        finalText: tasks.length === 1 ? "not json" : reply([brief()]),
      };
      return {
        events: (async function* () {
          yield { type: "end" as const, result };
        })(),
        result: Promise.resolve(result),
        cancel: async () => {},
      };
    },
  };
  const plan = await planIssue(issue(), { ...planDeps, adapter });
  assert.equal(plan.source, "model");
  assert.equal(plan.turns, 14);
});

test("planIssue retries a bad reply once with the errors in the prompt", async () => {
  const { adapter, tasks } = adapterReplying("not json", reply([brief()]));
  const plan = await planIssue(issue(), { ...planDeps, adapter });
  assert.equal(plan.source, "model");
  assert.equal(tasks.length, 2, "one retry");
  assert.doesNotMatch(tasks[0]?.prompt ?? "", /Errors in your previous plan/);
  assert.match(tasks[1]?.prompt ?? "", /## Errors in your previous plan/);
  assert.match(tasks[1]?.prompt ?? "", /not JSON/);
  assert.deepEqual(plan.tokens, { input: 20, output: 2, cacheRead: 0, cacheWrite: 0 });
});

test("a plan with an uncovered Done-when item is retried, then rejected", async () => {
  const two = issue({
    doneWhen: [
      { text: "API serves avatars", checked: false },
      { text: "Board shows avatars", checked: false },
    ],
  });
  const { adapter, tasks } = adapterReplying(reply([brief({ doneWhen: [1] })]));
  const plan = await planIssue(two, { ...planDeps, adapter });
  assert.equal(plan.source, "bad");
  assert.equal(tasks.length, 2);
  assert.match(tasks[1]?.prompt ?? "", /Done when item 2 is in no part/);
  assert.deepEqual(plan.parts, []);
  assert.deepEqual(plan.errors, ['Done when item 2 is in no part: "Board shows avatars"']);
  assert.match(plan.error ?? "", /Done when item 2 is in no part/);
});

test("a second bad plan is source bad and carries every error", async () => {
  const { adapter, tasks } = adapterReplying(reply([brief({ files: [], steps: [] })]));
  const plan = await planIssue(issue(), { ...planDeps, adapter });
  assert.equal(plan.source, "bad");
  assert.equal(tasks.length, 2);
  assert.equal(plan.errors?.length, 2, JSON.stringify(plan.errors));
  assert.deepEqual(plan.parts, []);
});

test("a turn-capped plan run counts as a bad plan and gets the one retry", async () => {
  const capped: Reply = { status: "error", error: "turn cap (50 turns)", reason: "turn_cap" };
  const { adapter, tasks } = adapterReplying(capped, reply([brief()]));
  const plan = await planIssue(issue(), { ...planDeps, adapter });
  assert.equal(plan.source, "model");
  assert.equal(tasks.length, 2);
  assert.match(tasks[1]?.prompt ?? "", /- turn cap \(50 turns\)/);

  const twice = adapterReplying(capped);
  const bad = await planIssue(issue(), { ...planDeps, adapter: twice.adapter });
  assert.equal(bad.source, "bad");
  assert.deepEqual(bad.errors, ["turn cap (50 turns)"]);
  assert.equal(twice.tasks.length, 2);
});

test("a limited plan run keeps its hold path and gets no retry (D-034)", async () => {
  const { adapter, tasks } = adapterReplying({ status: "limited", error: "usage limit reached" });
  const plan = await planIssue(issue(), { ...planDeps, adapter });
  assert.equal(plan.source, "limited");
  assert.deepEqual(plan.parts, []);
  assert.match(plan.error ?? "", /usage limit reached/);
  assert.equal(tasks.length, 1);
});

test("a harness-failed plan run keeps its switch path and gets no retry (D-048)", async () => {
  const { adapter, tasks } = adapterReplying({ status: "timeout", error: "over budget" });
  const plan = await planIssue(issue(), { ...planDeps, adapter });
  assert.equal(plan.source, "harness");
  assert.match(plan.switchReason ?? "", /timed out/);
  assert.deepEqual(plan.parts, []);
  assert.equal(tasks.length, 1);
});

test("an adapter mismatch runs no plan and no retry", async () => {
  const { adapter, tasks } = adapterReplying(reply([brief()]));
  const plan = await planIssue(issue(), { ...planDeps, adapter: { ...adapter, id: "codex" } });
  assert.equal(plan.source, "harness");
  assert.match(plan.error ?? "", /does not match/);
  assert.equal(tasks.length, 0);
});
