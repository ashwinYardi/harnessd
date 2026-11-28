import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ESCALATION_TRIGGERS,
  emptyTokenUsage,
  type HarnessAdapter,
  type LinkedIssue,
  type ResolvedAgentConfig,
  type RunResult,
  type Task,
  type TokenUsage,
} from "@harnessd/shared";
import type { ReviewFinding } from "./review.ts";
import { buildReviewDecisionPrompt, decideReview, parseReviewDecision } from "./review-decision.ts";

const agent: ResolvedAgentConfig = {
  name: "coordinator",
  role: "coordinator",
  harness: "claude-code",
  instructions: "Decide reviews without a human unless D-011 applies.",
  rules: [],
  skills: [],
};

const part: LinkedIssue = {
  id: "id-242",
  key: "MET-242",
  title: "Review decision module",
  description: [
    "**Goal**",
    "Decide a blocking review.",
    "",
    "**Done when**",
    "- [ ] A review decision is checked",
    "- [ ] An escalation names its D-011 trigger",
    "",
    "**Files**",
    "- packages/daemon/src/coordinator/review-decision.ts",
    "",
    "**Steps**",
    "1. Write the prompt.",
    "",
    "**Verify**",
    "- `pnpm --filter @harnessd/daemon test` → exit 0",
    "",
    "**Out of scope**",
    "Wiring the decision into settleReview.",
  ].join("\n"),
  priority: 2,
  state: "In Review",
  labels: ["coordinator"],
  size: "M",
  doneWhen: [
    { text: "A review decision is checked", checked: false },
    { text: "An escalation names its D-011 trigger", checked: false },
  ],
  url: "https://linear.test/MET-242",
  blockedBy: [],
  parentId: "id-241",
  parentKey: "MET-241",
  blockers: [],
};

function finding(fields: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    file: "packages/daemon/src/coordinator/review-decision.ts",
    line: 12,
    severity: "blocking",
    kind: "code",
    text: "The hint is missing.",
    ...fields,
  };
}

const open: ReviewFinding[] = [
  finding(),
  finding({
    file: "packages/daemon/src/coordinator/state.ts",
    line: 40,
    kind: "design",
    text: "The seam is in the wrong module.",
  }),
];

function fixReply(...hints: string[]): string {
  return JSON.stringify({
    decision: "fix",
    findings: open.map((_, i) => ({ id: `R${i + 1}`, hint: hints[i] ?? `Fix R${i + 1}.` })),
  });
}

function escalateReply(trigger: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    decision: "escalate",
    trigger,
    question: "Which public shape should this take?",
    options: ["Keep the current API", "Change the API"],
    recommendation: "Keep the current API until the next major version.",
    ...extra,
  });
}

type Reply = string | Pick<RunResult, "status" | "error" | "reason">;

const RUN_TOKENS: TokenUsage = { input: 70, output: 7, cacheRead: 3, cacheWrite: 1 };

/** Answers each run with the next reply and repeats the last one, recording tasks. */
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

function deps(adapter: HarnessAdapter) {
  return { adapter, agent, cwd: "/repo" };
}

test("the prompt carries the brief, findings, round, D-011 triggers and reply contract", () => {
  const earlier = finding({ text: "An earlier finding.", kind: "code" });
  const prompt = buildReviewDecisionPrompt({
    agent,
    part,
    findings: open,
    round: 2,
    maxRounds: 5,
    earlierFindings: [earlier],
  });
  for (const text of [
    "You are coordinator, the harnessd coordinator agent.",
    "**Goal**",
    "**Done when**",
    "**Files**",
    "**Verify**",
    "**Out of scope**",
    "- A review decision is checked",
    "- An escalation names its D-011 trigger",
    "R1",
    "packages/daemon/src/coordinator/review-decision.ts:12",
    "code",
    "R2",
    "packages/daemon/src/coordinator/state.ts:40",
    "design",
    "Round 2 of 5",
    "An earlier finding.",
    "A design finding alone is no trigger",
    '"decision": "fix"',
    '"decision": "escalate"',
    '"options"',
    '"recommendation"',
  ]) {
    assert.ok(prompt.includes(text), `prompt is missing ${text}`);
  }
  for (const trigger of ESCALATION_TRIGGERS) {
    assert.ok(prompt.includes(trigger), `prompt is missing the ${trigger} trigger`);
  }
  assert.doesNotMatch(prompt, /diff --git/);
  assert.match(prompt, /no PR diff/i);
});

test("a valid fix reply keeps one hint per open finding", () => {
  const parsed = parseReviewDecision(
    fixReply("Move the helper.", "Split the module."),
    open,
    part.key,
  );
  assert.deepEqual(parsed, {
    ok: true,
    decision: {
      decision: "fix",
      hints: [
        { id: "R1", hint: "Move the helper." },
        { id: "R2", hint: "Split the module." },
      ],
    },
  });
});

test("a fix reply is rejected when a finding id is missing, extra, duplicated or blank", () => {
  const missing = JSON.stringify({
    decision: "fix",
    findings: [{ id: "R1", hint: "Fix R1." }],
  });
  const extra = JSON.stringify({
    decision: "fix",
    findings: [
      { id: "R1", hint: "Fix R1." },
      { id: "R2", hint: "Fix R2." },
      { id: "R3", hint: "Fix R3." },
    ],
  });
  const duplicate = JSON.stringify({
    decision: "fix",
    findings: [
      { id: "R1", hint: "Fix R1." },
      { id: "R1", hint: "Fix R1 again." },
    ],
  });
  const blank = JSON.stringify({
    decision: "fix",
    findings: [
      { id: "R1", hint: "Fix R1." },
      { id: "R2", hint: "  " },
    ],
  });
  for (const [reply, why] of [
    [missing, /missing finding "R2"/],
    [extra, /not an open blocking finding "R3"/],
    [duplicate, /duplicate "R1"/],
    [blank, /hint: expected a non-empty string/],
  ] as const) {
    const parsed = parseReviewDecision(reply, open, part.key);
    assert.equal(parsed.ok, false, why.source);
    if (!parsed.ok) assert.match(parsed.error, why);
  }
});

test("a valid escalate reply keeps every D-011 trigger", () => {
  for (const trigger of ESCALATION_TRIGGERS) {
    const parsed = parseReviewDecision(escalateReply(trigger), open, part.key);
    assert.deepEqual(parsed, {
      ok: true,
      decision: {
        decision: "escalate",
        trigger,
        question: "Which public shape should this take?",
        options: ["Keep the current API", "Change the API"],
        recommendation: "Keep the current API until the next major version.",
      },
    });
  }
});

test("an escalate reply with no trigger becomes fix and logs the reason", () => {
  const parsed = parseReviewDecision(escalateReply(undefined), open, part.key);
  assert.deepEqual(parsed, {
    ok: true,
    decision: { decision: "fix", hints: [] },
    log: "MET-242: escalation without a D-011 trigger, sent back as fix",
  });
});

test("an escalate reply with an unknown trigger becomes fix", () => {
  const parsed = parseReviewDecision(escalateReply("unclear"), open, part.key);
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.deepEqual(parsed.decision, { decision: "fix", hints: [] });
    assert.equal(parsed.log, "MET-242: escalation without a D-011 trigger, sent back as fix");
  }
});

test("an untriggered escalate keeps the hints it carries", () => {
  const parsed = parseReviewDecision(
    escalateReply("unclear", {
      findings: [
        { id: "R2", hint: "Split the module." },
        { id: "R9", hint: "Not an open finding." },
      ],
    }),
    open,
    part.key,
  );
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.deepEqual(parsed.decision, {
      decision: "fix",
      hints: [{ id: "R2", hint: "Split the module." }],
    });
  }
});

test("a valid trigger still needs a question, options and a recommendation", () => {
  for (const [extra, why] of [
    [{ question: "" }, /question: expected a non-empty string/],
    [{ options: [] }, /options: expected a non-empty array/],
    [{ options: ["ok", ""] }, /options\[1\]: expected a non-empty string/],
    [{ recommendation: " " }, /recommendation: expected a non-empty string/],
  ] as const) {
    const parsed = parseReviewDecision(escalateReply("money", extra), open, part.key);
    assert.equal(parsed.ok, false, why.source);
    if (!parsed.ok) assert.match(parsed.error, why);
  }
});

test("invalid JSON and a schema error fall back to fix with no hints", async () => {
  const invalid = await decideReview(
    { part, findings: open, round: 1, maxRounds: 5 },
    deps(adapterReplying("not json").adapter),
  );
  assert.deepEqual(invalid.decision, { decision: "fix", hints: [] });
  assert.match(invalid.error ?? "", /not JSON/);
  assert.deepEqual(invalid.tokens, RUN_TOKENS);

  const schema = await decideReview(
    { part, findings: open, round: 1, maxRounds: 5 },
    deps(
      adapterReplying(JSON.stringify({ decision: "fix", findings: [{ id: "R1", hint: "Fix." }] }))
        .adapter,
    ),
  );
  assert.deepEqual(schema.decision, { decision: "fix", hints: [] });
  assert.match(schema.error ?? "", /missing finding "R2"/);
});

test("decideReview logs each failure and counts no review failure", async () => {
  const lines: string[] = [];
  const result = await decideReview(
    { part, findings: open, round: 1, maxRounds: 5 },
    { ...deps(adapterReplying("no JSON here").adapter), log: (line) => lines.push(line) },
  );
  assert.deepEqual(result.decision, { decision: "fix", hints: [] });
  assert.equal(lines.length, 1);
  assert.match(
    lines[0] ?? "",
    /^MET-242: review decision failed \(not JSON: .*\), sent back as fix$/,
  );
});

test("an escalation without a trigger is logged and sent back as fix", async () => {
  const lines: string[] = [];
  const result = await decideReview(
    { part, findings: open, round: 1, maxRounds: 5 },
    { ...deps(adapterReplying(escalateReply(undefined)).adapter), log: (line) => lines.push(line) },
  );
  assert.deepEqual(result.decision, { decision: "fix", hints: [] });
  assert.equal(result.error, undefined);
  assert.deepEqual(lines, ["MET-242: escalation without a D-011 trigger, sent back as fix"]);
});

test("decideReview builds a read-only coordinator task with the 50 turn cap and returns usage", async () => {
  const { adapter, tasks } = adapterReplying(fixReply());
  const result = await decideReview(
    { part, findings: open, round: 2, maxRounds: 5, earlierFindings: [finding()] },
    deps(adapter),
  );
  assert.equal(tasks.length, 1);
  const task = tasks[0];
  assert.ok(task);
  assert.equal(task.readOnly, true);
  assert.equal(task.maxTurns, 50);
  assert.equal(task.role, undefined);
  assert.match(task.prompt, /Round 2 of 5/);
  assert.deepEqual(result.decision, {
    decision: "fix",
    hints: [
      { id: "R1", hint: "Fix R1." },
      { id: "R2", hint: "Fix R2." },
    ],
  });
  assert.deepEqual(result.tokens, RUN_TOKENS);
  assert.equal(result.error, undefined);
});

test("a failed run falls back to fix and marks the D-048 switch", async () => {
  for (const [reply, reason, why] of [
    [{ status: "timeout", error: "over budget" }, "timed out", /timed out/],
    [{ status: "limited", error: "usage limit" }, "hit its usage limit", /usage limit/],
    [{ status: "error", reason: "stalled", error: "no output" }, "stalled", /stalled/],
    [{ status: "error", reason: "turn_cap", error: "turn cap (50 turns)" }, undefined, /turn cap/],
  ] as const) {
    const lines: string[] = [];
    const result = await decideReview(
      { part, findings: open, round: 1, maxRounds: 5 },
      { ...deps(adapterReplying(reply).adapter), log: (line) => lines.push(line) },
    );
    assert.deepEqual(result.decision, { decision: "fix", hints: [] });
    assert.equal(result.switchReason, reason, why.source);
    assert.match(lines[0] ?? "", /review decision failed \(.*\), sent back as fix/);
    assert.deepEqual(result.tokens, RUN_TOKENS);
    assert.ok(lines.length === 1);
  }
});

test("only open blocking findings are numbered and parsed", () => {
  const findings: ReviewFinding[] = [
    open[0] as ReviewFinding,
    finding({ severity: "nit", text: "A nit." }),
    open[1] as ReviewFinding,
  ];
  const reply = JSON.stringify({
    decision: "fix",
    findings: [
      { id: "R1", hint: "Fix the code." },
      { id: "R2", hint: "Fix the design." },
    ],
  });
  const parsed = parseReviewDecision(reply, findings, part.key);
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.deepEqual(parsed.decision, {
      decision: "fix",
      hints: [
        { id: "R1", hint: "Fix the code." },
        { id: "R2", hint: "Fix the design." },
      ],
    });
  }
  const prompt = buildReviewDecisionPrompt({
    agent,
    part,
    findings,
    round: 1,
    maxRounds: 5,
  });
  assert.match(prompt, /R2 \(packages\/daemon\/src\/coordinator\/state.ts:40, design\)/);
  assert.doesNotMatch(prompt, /A nit\./);
});

test("the run usage is empty when the adapter sends no usage event", async () => {
  const adapter: HarnessAdapter = {
    id: "claude-code",
    start() {
      const result: RunResult = {
        status: "ok",
        exitCode: 0,
        durationMs: 1,
        tokens: emptyTokenUsage(),
        finalText: fixReply(),
        usageUnknown: true,
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
  const result = await decideReview(
    { part, findings: open, round: 1, maxRounds: 5 },
    deps(adapter),
  );
  assert.equal(result.usageUnknown, true);
  assert.deepEqual(result.tokens, emptyTokenUsage());
});
