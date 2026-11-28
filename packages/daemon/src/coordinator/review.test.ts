import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  HarnessAdapter,
  Issue,
  LinkedIssue,
  ResolvedAgentConfig,
  RunResult,
  Task,
} from "@harnessd/shared";
import { emptyTokenUsage } from "@harnessd/shared";
import { mergeLayers } from "../config/merge.ts";
import type { PullRequest } from "../github/client.ts";
import { maxTurns } from "./dispatch.ts";
import {
  buildReReviewPrompt,
  buildReviewPrompt,
  buildReviewTask,
  diffFiles,
  formatReviewComment,
  parseReReviewVerdict,
  parseReviewVerdict,
  type ReviewEscalation,
  type ReviewFinding,
  type ReviewSettleDeps,
  resetReviewNotJudged,
  runReview,
  settleReview,
} from "./review.ts";
import { partMarker } from "./split.ts";
import { parseLoopState } from "./state.ts";

const agent: ResolvedAgentConfig = {
  name: "reviewer",
  role: "reviewer",
  harness: "codex",
  instructions: "Review the code like a senior developer.",
  rules: [],
  skills: [],
};

const parent: Issue = {
  id: "id-165",
  key: "MET-165",
  title: "A reviewer reviews every part PR",
  description: "Parent body: the reviewer reviews each PR before QA.",
  priority: 2,
  state: "In Progress",
  labels: [],
  size: "M",
  doneWhen: [{ text: "A reviewer reviews each PR", checked: false }],
  url: "https://linear.test/MET-165",
  blockedBy: [],
};

const part: LinkedIssue = {
  ...parent,
  id: "id-223",
  key: "MET-223",
  title: "Review run module",
  parentId: parent.id,
  parentKey: parent.key,
  blockers: [],
  description: [
    partMarker("backend-2"),
    "",
    "**Goal**",
    "Build the review run.",
    "",
    "**Done when**",
    "- [ ] The review run works",
    "",
    "**Files**",
    "- packages/daemon/src/coordinator/review.ts",
    "",
    "**Steps**",
    "1. Write the prompt.",
    "",
    "**Verify**",
    "- `pnpm --filter @harnessd/daemon test` → exit 0",
    "",
    "**Out of scope**",
    "Starting a review from the loop.",
    "",
    "**Decisions**",
    "- D-041: The review reuses the QA checkout.",
    "- D-052: The parser reuses the backslash repair.",
    "",
    "**Grill calls**",
    "- Where does the reviewer run? → In a scratch PR-head checkout.",
  ].join("\n"),
  size: "S",
};

function pr(): PullRequest {
  return {
    number: 223,
    title: "MET-223: Review run module",
    url: "https://github.test/o/r/pull/223",
    headRefName: "met-223-review-run",
    headRefOid: "sha223",
    baseRefName: "main",
    isDraft: false,
  };
}

test("the review prompt carries the PR, diff, parent, brief and rubric (MET-223, D-041, D-044)", () => {
  const prompt = buildReviewPrompt({
    agent,
    part,
    parent,
    pr: pr(),
    diff: "diff --git a/src/a.ts b/src/a.ts\n+export const reviewed = true;",
  });
  for (const text of [
    "You are reviewer, the harnessd reviewer agent.",
    "## PR under review",
    "https://github.test/o/r/pull/223",
    "sha223",
    "+export const reviewed = true;",
    "Parent body: the reviewer reviews each PR before QA.",
    "**Goal**\nBuild the review run.",
    "**Decisions**\n- D-041: The review reuses the QA checkout.",
    "**Grill calls**\n- Where does the reviewer run? → In a scratch PR-head checkout.",
    "## Senior-dev rubric",
    "Architecture and layering",
    "Scalability",
    "Hot paths",
    "Repeated I/O",
    "Unbounded growth",
    "Blocking calls",
    "Trade-offs",
    "Best practices",
    "Error handling",
    "Duplication",
    "Dead code",
    "Edit nothing",
    "Do not read all of docs/SPEC.md.",
    '"decision": "approve" | "changes_requested"',
    '"severity": "blocking" | "nit"',
  ]) {
    assert.ok(prompt.includes(text), text);
  }
});

test("a delta replaces the full diff and earlier blocking findings are listed (MET-223)", () => {
  const earlier: ReviewFinding = {
    file: "src/cache.ts",
    line: 42,
    severity: "blocking",
    kind: "code",
    text: "The cache grows without a limit.",
  };
  const prompt = buildReviewPrompt({
    agent,
    part,
    parent,
    pr: pr(),
    diff: "FULL DIFF",
    delta: "+const cache = new Map();",
    earlierFindings: [earlier],
  });
  assert.ok(prompt.includes("## Delta since the last review"));
  assert.ok(prompt.includes("+const cache = new Map();"));
  assert.ok(!prompt.includes("FULL DIFF"));
  assert.ok(prompt.includes("src/cache.ts:42"));
  assert.ok(prompt.includes("The cache grows without a limit."));
});

const savedFindings: ReviewFinding[] = [
  {
    file: "src/cache.ts",
    line: 42,
    severity: "blocking",
    kind: "code",
    text: "The cache grows without a limit.",
  },
  {
    file: "src/api.ts",
    line: 7,
    severity: "blocking",
    kind: "design",
    text: "The seam sits in the wrong module.",
  },
];

const doneWhen = ["The review run works", "A re-review checks only the saved findings"];

const reReviewDelta = [
  "diff --git a/src/cache.ts b/src/cache.ts",
  "@@ -1 +1 @@",
  "-const cache = [];",
  "+const cache = new Map();",
  "diff --git a/src/new.ts b/src/new.ts",
  "@@ -0,0 +1 @@",
  "+export const reviewed = true;",
].join("\n");

test("a re-review prompt lists the saved findings and the delta-only rules (MET-234, D-061)", () => {
  const prompt = buildReReviewPrompt({
    agent,
    part,
    pr: pr(),
    delta: reReviewDelta,
    savedFindings,
  });
  for (const text of [
    "You are reviewer, the harnessd reviewer agent.",
    "## PR under review",
    "sha223",
    "## Delta since the last review",
    "+export const reviewed = true;",
    "- R1 (src/cache.ts:42) The cache grows without a limit.",
    "- R2 (src/api.ts:7) The seam sits in the wrong module.",
    "Judge only the saved findings above and the delta since the last review.",
    "Raise a new blocking finding only for code in the delta that breaks a named Done-when item.",
    "Mark any other new finding as a nit.",
    "**Goal**\nBuild the review run.",
    "**Done when**\n- [ ] The review run works",
    "**Verify**\n- `pnpm --filter @harnessd/daemon test` → exit 0",
    '"id": "R1"',
    "exactly one entry for each saved id (R1, R2)",
  ]) {
    assert.ok(prompt.includes(text), text);
  }
  assert.ok(!prompt.includes("## Diff"), "no full-diff heading");
  assert.ok(
    !prompt.includes("Parent body: the reviewer reviews each PR before QA."),
    "no parent body",
  );
  assert.ok(!prompt.includes("## Senior-dev rubric"), "no senior-dev rubric");
});

test("a re-review whose delta paths cannot be read falls back to the full review (MET-234, D-061)", async () => {
  const prompts: string[] = [];
  const logs: string[] = [];
  const adapter: HarnessAdapter = {
    id: "claude-code",
    start(task) {
      prompts.push(task.prompt);
      const result: RunResult = {
        status: "ok",
        exitCode: 0,
        durationMs: 1,
        tokens: emptyTokenUsage(),
        finalText: JSON.stringify({ decision: "approve", findings: [] }),
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
  const blocking: ReviewFinding = {
    file: "src/api.ts",
    line: 1,
    severity: "blocking",
    kind: "code",
    text: "The loop reads the file on every tick.",
  };
  const result = await runReview(
    {
      part,
      parent,
      pr: pr(),
      budgetMs: 1_000,
      since: { sha: "old", findings: [blocking] },
      reReview: true,
    },
    {
      github: {
        async prDiff() {
          return "FULL DIFF";
        },
        async findPrByHead() {
          return pr();
        },
      },
      worktrees: {
        async checkout() {
          return { path: "/wt/review", branch: "b", resumed: false };
        },
        async remove() {
          return { removed: true };
        },
      },
      adapter,
      agent,
      deltaDiff: async () => "DELTA",
      deltaFiles: async () => undefined,
      log: (line) => logs.push(line),
    },
  );

  assert.equal(result.verdict?.decision, "approve");
  assert.equal(prompts.length, 1);
  const prompt = prompts[0] ?? "";
  assert.match(prompt, /## Diff/);
  assert.match(prompt, /FULL DIFF/);
  assert.doesNotMatch(prompt, /## Delta since the last review/);
  assert.doesNotMatch(prompt, /DELTA/);
  assert.match(prompt, /## Earlier blocking findings \(1\)/);
  assert.match(prompt, /src\/api\.ts:1/);
  assert.deepEqual(logs, [`${part.key}: no review delta, full review`]);
});

test("parseReReviewVerdict carries open saved findings and drops out-of-delta blocking findings (MET-234, D-061)", () => {
  const log: string[] = [];
  const value = {
    decision: "changes_requested",
    saved: [
      { id: "R1", fixed: true, evidence: "The cache is bounded now." },
      { id: "R2", fixed: false, evidence: "The seam still sits in the wrong module." },
    ],
    findings: [
      {
        file: "src/new.ts",
        line: 3,
        severity: "blocking",
        kind: "code",
        text: "It breaks the second item.",
        item: "A re-review checks only the saved findings",
      },
      {
        file: "src/out.ts",
        line: 4,
        severity: "blocking",
        kind: "code",
        text: "Outside the delta.",
        item: "The review run works",
      },
      {
        file: "src/new.ts",
        line: 5,
        severity: "blocking",
        kind: "design",
        text: "No Done-when item.",
      },
      {
        file: "src/new.ts",
        line: 6,
        severity: "nit",
        kind: "code",
        text: "Polish.",
      },
    ],
  };
  const parsed = parseReReviewVerdict(
    JSON.stringify(value),
    savedFindings,
    doneWhen,
    reReviewDelta,
    (line) => log.push(line),
  );
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.verdict.saved, value.saved);
  assert.deepEqual(parsed.verdict.findings, [
    {
      ...savedFindings[1],
      severity: "blocking",
      evidence: "The seam still sits in the wrong module.",
    },
    {
      file: "src/new.ts",
      line: 3,
      severity: "blocking",
      kind: "code",
      text: "It breaks the second item.",
      item: "A re-review checks only the saved findings",
    },
    { file: "src/out.ts", line: 4, severity: "nit", kind: "code", text: "Outside the delta." },
    { file: "src/new.ts", line: 5, severity: "nit", kind: "design", text: "No Done-when item." },
    { file: "src/new.ts", line: 6, severity: "nit", kind: "code", text: "Polish." },
  ]);
  assert.equal(log.length, 2, "one line per new blocking finding changed to a nit");

  const approved = parseReReviewVerdict(
    JSON.stringify({
      decision: "approve",
      saved: [
        { id: "R1", fixed: true, evidence: "Fixed." },
        { id: "R2", fixed: true, evidence: "Fixed too." },
      ],
      findings: [
        {
          file: "src/out.ts",
          line: 4,
          severity: "blocking",
          kind: "code",
          text: "Outside the delta.",
          item: "The review run works",
        },
      ],
    }),
    savedFindings,
    doneWhen,
    reReviewDelta,
  );
  assert.equal(
    approved.ok,
    true,
    "an out-of-delta blocking finding becomes a nit, so approve holds",
  );
  assert.deepEqual(approved.ok ? approved.verdict.findings : undefined, [
    { file: "src/out.ts", line: 4, severity: "nit", kind: "code", text: "Outside the delta." },
  ]);
});

test("parseReReviewVerdict is strict about saved ids and the decision (MET-234, D-061)", () => {
  const savedOk = [
    { id: "R1", fixed: true, evidence: "Fixed." },
    { id: "R2", fixed: false, evidence: "Not fixed." },
  ];
  const finding = {
    file: "src/new.ts",
    line: 1,
    severity: "blocking",
    kind: "code",
    text: "It breaks an item.",
    item: "The review run works",
  };
  const bad = (value: unknown) => {
    const r = parseReReviewVerdict(JSON.stringify(value), savedFindings, doneWhen, reReviewDelta);
    assert.equal(r.ok, false, JSON.stringify(value));
    return r.ok ? "" : r.error;
  };
  const notJson = parseReReviewVerdict("not json", savedFindings, doneWhen, reReviewDelta);
  assert.equal(!notJson.ok && notJson.kind, "not_json");
  assert.match(!notJson.ok ? notJson.error : "", /not JSON/);
  assert.match(bad([]), /expected a JSON object/);
  assert.match(
    bad({ decision: "approve", saved: savedOk, findings: [], extra: true }),
    /unknown key "extra"/,
  );
  assert.match(bad({ decision: "approved", saved: savedOk, findings: [] }), /decision: expected/);
  assert.match(bad({ decision: "approve", findings: [] }), /saved: expected an array/);
  assert.match(bad({ decision: "approve", saved: savedOk }), /findings: expected an array/);
  assert.match(
    bad({ decision: "approve", saved: [savedOk[0]], findings: [] }),
    /saved: missing saved finding "R2"/,
  );
  assert.match(
    bad({ decision: "approve", saved: [savedOk[0], savedOk[0]], findings: [] }),
    /saved\[1\]\.id: duplicate "R1"/,
  );
  assert.match(
    bad({ decision: "approve", saved: [savedOk[0], { ...savedOk[1], id: "R9" }], findings: [] }),
    /saved\[1\]\.id: not a saved finding "R9"/,
  );
  assert.match(
    bad({ decision: "approve", saved: [savedOk[0], { ...savedOk[1], extra: true }], findings: [] }),
    /saved\[1\]: unknown key "extra"/,
  );
  assert.match(
    bad({
      decision: "approve",
      saved: [savedOk[0], { ...savedOk[1], evidence: " " }],
      findings: [],
    }),
    /saved\[1\]\.evidence: expected a non-empty string/,
  );
  assert.match(
    bad({
      decision: "approve",
      saved: [savedOk[0], { ...savedOk[1], fixed: "no" }],
      findings: [],
    }),
    /saved\[1\]\.fixed: expected true or false/,
  );
  assert.match(
    bad({ decision: "approve", saved: savedOk, findings: [{ ...finding, severity: "nit" }] }),
    /findings\[0\]\.item: only a new blocking finding names an item/,
  );
  assert.match(
    bad({ decision: "approve", saved: savedOk, findings: [finding] }),
    /approve had a blocking finding/,
  );
  assert.match(
    bad({
      decision: "changes_requested",
      saved: savedOk.map((s) => ({ ...s, fixed: true })),
      findings: [],
    }),
    /changes_requested needs at least one blocking finding/,
  );
  assert.match(
    bad({ decision: "changes_requested", saved: savedOk, findings: [{ ...finding, note: "x" }] }),
    /findings\[0\]: unknown key "note"/,
  );
});

test("the delta file scan reads headers, not hunk content, and unquotes paths (MET-234, D-061)", () => {
  const delta = [
    'diff --git "a/src/path with space.ts" "b/src/path with space.ts"',
    "@@ -1 +1 @@",
    "--- a/src/path with space.ts",
    "+++ b/src/path with space.ts",
    "+export const touched = true;",
    "diff --git a/src/real.ts b/src/real.ts",
    "@@ -1,2 +1,2 @@",
    " const keep = true;",
    "+const source = '++ b/untouched.ts';",
    "+++ b/untouched.ts",
  ].join("\n");
  const files = diffFiles(delta);
  assert.equal(files.has("src/path with space.ts"), true);
  assert.equal(files.has("src/real.ts"), true);
  assert.equal(files.has("untouched.ts"), false, "hunk content is not a changed file");

  const parsed = parseReReviewVerdict(
    JSON.stringify({
      decision: "changes_requested",
      saved: [
        { id: "R1", fixed: true, evidence: "Fixed." },
        { id: "R2", fixed: false, evidence: "Still open." },
      ],
      findings: [
        {
          file: "untouched.ts",
          line: 1,
          severity: "blocking",
          kind: "code",
          text: "Hunk content tricked the scan.",
          item: "The review run works",
        },
      ],
    }),
    savedFindings,
    doneWhen,
    files,
  );
  assert.equal(parsed.ok, true);
  assert.deepEqual(
    parsed.ok ? parsed.verdict.findings.filter((finding) => finding.severity === "nit") : [],
    [
      {
        file: "untouched.ts",
        line: 1,
        severity: "nit",
        kind: "code",
        text: "Hunk content tricked the scan.",
      },
    ],
    "a finding on an unchanged file is a nit",
  );
});

test("parseReReviewVerdict keeps exact changed file names with trailing whitespace (MET-234, D-061)", () => {
  const exact = "src/ends-with-space.ts ";
  const parsed = parseReReviewVerdict(
    JSON.stringify({
      decision: "changes_requested",
      saved: [
        { id: "R1", fixed: true, evidence: "Fixed." },
        { id: "R2", fixed: true, evidence: "Fixed too." },
      ],
      findings: [
        {
          file: exact,
          line: 1,
          severity: "blocking",
          kind: "code",
          text: "This file is in the delta.",
          item: "The review run works",
        },
        {
          file: "src/ends-with-space.ts",
          line: 2,
          severity: "blocking",
          kind: "code",
          text: "This name is not in the delta.",
          item: "The review run works",
        },
      ],
    }),
    savedFindings,
    doneWhen,
    new Set([exact]),
  );
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const blocking = parsed.verdict.findings.filter((finding) => finding.severity === "blocking");
  const nits = parsed.verdict.findings.filter((finding) => finding.severity === "nit");
  assert.equal(blocking.length, 1);
  assert.equal(blocking[0]?.file, exact, "the exact path is kept for membership and storage");
  assert.equal(nits.length, 1);
  assert.equal(nits[0]?.file, "src/ends-with-space.ts");
});

test("a carried saved finding keeps its new evidence in the send-back and across a reload (MET-234, D-061)", async () => {
  const evidence = "The seam still sits in the wrong module.";
  const open: ReviewFinding = {
    file: "src/api.ts",
    line: 7,
    severity: "blocking",
    kind: "code",
    text: "The seam sits in the wrong module.",
    evidence,
  };
  const comments: string[] = [];
  const deps: ReviewSettleDeps = {
    linear: {
      async comment(_issueId, body) {
        comments.push(body);
        return "comment-1";
      },
      async moveTo() {},
    },
    notifier: { async notify() {} },
    maxFailures: 3,
    maxReviewRounds: 6,
  };
  const state: Parameters<typeof settleReview>[0] = {
    reviewFailures: {},
    reviewRunFailures: {},
    qaFeedback: {},
  };
  const verdict = {
    decision: "changes_requested" as const,
    saved: [
      { id: "R1", fixed: true, evidence: "Fixed." },
      { id: "R2", fixed: false, evidence },
    ],
    findings: [open],
  };

  assert.equal(await settleReview(state, { part, parent, pr: pr(), verdict }, deps), "sent_back");
  const line = `R1 (src/api.ts:7) The seam sits in the wrong module. (not fixed: ${evidence})`;
  assert.deepEqual(state.qaFeedback[part.id]?.failing, [line]);
  assert.match(comments[0] ?? "", new RegExp(`not fixed: ${evidence}`));

  const reloaded = parseLoopState(
    JSON.stringify({
      inFlight: [],
      qaFeedback: state.qaFeedback,
      reviewerHeads: {
        [part.id]: {
          sha: "sha223",
          verdict: "changes_requested",
          findings: [open],
          at: "2026-11-27T10:00:00.000Z",
        },
      },
    }),
  );
  assert.equal(reloaded.reviewerHeads?.[part.id]?.findings[0]?.evidence, evidence);
  assert.deepEqual(reloaded.qaFeedback[part.id]?.failing, [line]);
});

test("a re-review settle sends back only the open blocking findings and counts one failure (MET-234, D-061)", async () => {
  const comments: string[] = [];
  const deps: ReviewSettleDeps = {
    linear: {
      async comment(_issueId, body) {
        comments.push(body);
        return "comment-1";
      },
      async moveTo() {},
    },
    notifier: { async notify() {} },
    maxFailures: 3,
    maxReviewRounds: 6,
  };
  const state: Parameters<typeof settleReview>[0] = {
    reviewFailures: { [part.id]: 1 },
    reviewRunFailures: {},
    qaFeedback: {},
  };
  const open: ReviewFinding = {
    file: "src/api.ts",
    line: 7,
    severity: "blocking",
    kind: "code",
    text: "The seam sits in the wrong module.",
  };
  const verdict = {
    decision: "changes_requested" as const,
    saved: [
      { id: "R1", fixed: true, evidence: "The cache is bounded now." },
      { id: "R2", fixed: false, evidence: "The seam still sits in the wrong module." },
    ],
    findings: [
      open,
      {
        file: "src/new.ts",
        line: 3,
        severity: "blocking" as const,
        kind: "code" as const,
        text: "It breaks the second item.",
      },
      {
        file: "src/new.ts",
        line: 6,
        severity: "nit" as const,
        kind: "code" as const,
        text: "Polish.",
      },
    ],
  };

  assert.equal(await settleReview(state, { part, parent, pr: pr(), verdict }, deps), "sent_back");
  assert.equal(state.reviewFailures[part.id], 2, "one more review round");
  assert.equal(state.reviewRunFailures[part.id], undefined, "no failed run is counted");
  assert.deepEqual(state.qaFeedback[part.id]?.failing, [
    "R1 (src/api.ts:7) The seam sits in the wrong module.",
    "R2 (src/new.ts:3) It breaks the second item.",
  ]);
  assert.match(comments[0] ?? "", /R1 \(src\/api\.ts:7\) The seam sits in the wrong module\./);
  assert.match(comments[0] ?? "", /R2 \(src\/new\.ts:3\) It breaks the second item\./);
  assert.doesNotMatch(comments[0] ?? "", /Polish\./, "nits are not sent back");
});

test("parseReviewVerdict accepts an approve or a changes_requested verdict", () => {
  const approved = parseReviewVerdict(
    `Here it is:\n\`\`\`json\n${JSON.stringify({ decision: "approve", findings: [] })}\n\`\`\``,
  );
  assert.equal(approved.ok, true);
  assert.deepEqual(approved.ok ? approved.verdict : undefined, {
    decision: "approve",
    findings: [],
  });

  const good = JSON.stringify({
    decision: "changes_requested",
    findings: [
      {
        file: "src/a.ts",
        line: 12,
        severity: "blocking",
        kind: "code",
        text: "The loop reads the file on every tick.",
      },
      {
        file: "src/b.ts",
        line: 3,
        severity: "nit",
        kind: "design",
        text: "The name hides the seam.",
      },
    ],
  });
  const parsed = parseReviewVerdict(good);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.ok ? parsed.verdict : undefined, {
    decision: "changes_requested",
    findings: [
      {
        file: "src/a.ts",
        line: 12,
        severity: "blocking",
        kind: "code",
        text: "The loop reads the file on every tick.",
      },
      {
        file: "src/b.ts",
        line: 3,
        severity: "nit",
        kind: "design",
        text: "The name hides the seam.",
      },
    ],
  });
});

test("parseReviewVerdict is strict", () => {
  const finding = {
    file: "src/a.ts",
    line: 1,
    severity: "blocking",
    kind: "code",
    text: "A fault.",
  };
  const bad = (value: unknown) => {
    const r = parseReviewVerdict(JSON.stringify(value));
    assert.equal(r.ok, false, JSON.stringify(value));
    return r.ok ? "" : r.error;
  };
  const notJson = parseReviewVerdict("not json");
  assert.equal(!notJson.ok && notJson.kind, "not_json");
  assert.match(!notJson.ok ? notJson.error : "", /not JSON/);
  assert.match(bad([]), /expected a JSON object/);
  assert.match(bad({ decision: "approve", findings: [], extra: true }), /unknown key "extra"/);
  assert.match(bad({ decision: "approved", findings: [] }), /decision: expected/);
  assert.match(bad({ decision: "approve" }), /findings: expected an array/);
  assert.match(bad({ decision: "approve", findings: [finding] }), /approve had a blocking finding/);
  assert.match(
    bad({ decision: "changes_requested", findings: [] }),
    /changes_requested needs at least one blocking finding/,
  );
  assert.match(
    bad({ decision: "changes_requested", findings: [{ ...finding, severity: "nit" }] }),
    /changes_requested needs at least one blocking finding/,
  );
  assert.match(
    bad({ decision: "approve", findings: [{ ...finding, severity: "nit", note: "x" }] }),
    /findings\[0\]: unknown key "note"/,
  );
  for (const [key, value] of [
    ["file", " "],
    ["text", ""],
  ] as const) {
    assert.match(
      bad({ decision: "approve", findings: [{ ...finding, severity: "nit", [key]: value }] }),
      new RegExp(`findings\\[0\\]\\.${key}: expected a non-empty string`),
    );
  }
  for (const line of [0, 1.5, "1"]) {
    assert.match(
      bad({ decision: "approve", findings: [{ ...finding, severity: "nit", line }] }),
      /findings\[0\]\.line: expected an integer of at least 1/,
    );
  }
  assert.match(
    bad({ decision: "approve", findings: [{ ...finding, severity: "major" }] }),
    /findings\[0\]\.severity: expected "blocking" or "nit"/,
  );
  assert.match(
    bad({ decision: "approve", findings: [{ ...finding, severity: "nit", kind: "style" }] }),
    /findings\[0\]\.kind: expected "code" or "design"/,
  );
  assert.match(
    bad({ decision: "approve", findings: ["src/a.ts:1"] }),
    /findings\[0\]: expected an object/,
  );
});

test("parseReviewVerdict repairs a stray backslash and keeps not_json for a parse failure (D-052)", () => {
  const b = "\\";
  const text = `{"decision":"approve","findings":[{"file":"src/a.ts","line":1,"severity":"nit","kind":"code","text":"ran ${b}\`pnpm test\`"}]}`;
  const parsed = parseReviewVerdict(text);
  assert.equal(parsed.ok, true);
  assert.equal(
    parsed.ok ? parsed.verdict.findings[0]?.text : undefined,
    `ran ${b}\`pnpm test\``,
    "a stray backslash is kept as an escaped backslash",
  );

  const notJson = parseReviewVerdict("no json");
  assert.equal(notJson.ok, false);
  assert.equal(!notJson.ok && notJson.kind, "not_json");
  assert.match(!notJson.ok ? notJson.error : "", /^not JSON: /);
});

test("the review comment lists every blocking finding and nit with file:line (MET-224, D-060)", () => {
  const body = formatReviewComment({
    part,
    parent,
    pr: pr(),
    verdict: {
      decision: "changes_requested",
      findings: [
        {
          file: "src/a.ts",
          line: 12,
          severity: "blocking",
          kind: "code",
          text: "The loop reads the file on every tick.",
        },
        {
          file: "src/b.ts",
          line: 3,
          severity: "nit",
          kind: "design",
          text: "The name hides the seam.",
        },
      ],
    },
  });
  assert.match(body, /changes requested/);
  assert.match(body, /sha223/);
  assert.match(body, /- src\/a\.ts:12 \(blocking, code\): The loop reads the file on every tick\./);
  assert.match(body, /- src\/b\.ts:3 \(nit, design\): The name hides the seam\./);
  assert.match(body, /Blocking \(1\):/);
  assert.match(body, /Nits \(1\):/);

  const approved = formatReviewComment({
    part,
    parent,
    pr: pr(),
    verdict: { decision: "approve", findings: [] },
  });
  assert.match(approved, /approved/);
  assert.match(approved, /No blocking finding/);
  assert.doesNotMatch(approved, /Nits:/);
});

test("the reviewer task is read-only and carries its size cap (MET-223, D-047, D-059)", () => {
  const limits = mergeLayers([]).limits;
  const task: Task = buildReviewTask({
    id: "review-MET-223-1",
    title: "Review MET-223: PR #223",
    prompt: "Review it.",
    budgetMs: 60_000,
    maxTurns: maxTurns("reviewer", part.size, limits),
    model: "gpt-6.2-sol",
  });
  assert.equal(task.readOnly, true);
  assert.equal(task.role, "reviewer");
  assert.equal(task.maxTurns, 15);
  assert.equal(task.model, "gpt-6.2-sol");
});

test("an approval keeps review failures and QA feedback that is not a review send-back (MET-230)", async () => {
  const deps = {
    linear: {
      async comment(_issueId: string, _body: string) {
        return "comment-1";
      },
      async moveTo(_issueId: string, _state: string) {},
    },
    notifier: { async notify() {} },
    maxFailures: 2,
    maxReviewRounds: 6,
  };
  const input = {
    part,
    parent,
    pr: pr(),
    verdict: { decision: "approve" as const, findings: [] },
  };
  const qaFeedback = { source: "qa" as const, failing: ["Works: no test"] };
  const state = {
    reviewFailures: { [part.id]: 1 },
    reviewRunFailures: { [part.id]: 1 },
    qaFeedback: { [part.id]: qaFeedback },
  };

  assert.equal(await settleReview(state, input, deps), "approved");
  assert.equal(state.reviewRunFailures[part.id], 1, "an approval keeps the failure count");
  assert.equal(state.reviewFailures[part.id], 1, "an approval keeps the round count");
  assert.deepEqual(state.qaFeedback[part.id], qaFeedback, "QA feedback stays");

  const reviewState = {
    reviewFailures: { [part.id]: 1 },
    reviewRunFailures: { [part.id]: 1 },
    qaFeedback: {
      [part.id]: { source: "review" as const, failing: ["R1 (src/a.ts:1) Fix it."] },
    },
  };
  assert.equal(await settleReview(reviewState, input, deps), "approved");
  assert.equal(
    reviewState.reviewRunFailures[part.id],
    1,
    "the count still waits for Done or escalation",
  );
  assert.equal(reviewState.reviewFailures[part.id], 1, "the round count waits too");
  assert.equal(reviewState.qaFeedback[part.id], undefined, "its own review send-back is cleared");
});

test("a not-judged escalation decides before its first write and a replay applies it (MET-232)", async () => {
  resetReviewNotJudged();
  const calls: string[] = [];
  const deps: ReviewSettleDeps = {
    linear: {
      async comment(issueId) {
        calls.push(`comment ${issueId}`);
        return "comment-1";
      },
      async moveTo(issueId, state) {
        calls.push(`move ${issueId} ${state}`);
      },
    },
    notifier: {
      async notify() {
        calls.push("notice");
      },
    },
    maxFailures: 2,
    maxReviewRounds: 6,
  };
  const state: Parameters<typeof settleReview>[0] = {
    reviewFailures: {},
    reviewRunFailures: {},
    qaFeedback: {},
  };
  const input = { part, parent, pr: pr(), notJudged: "timeout" as const, error: "timed out" };

  assert.equal(await settleReview(state, input, deps), "requeued");
  assert.equal(calls.length, 0, "the first run writes nothing");

  let decided: ReviewEscalation | undefined;
  const steps = {
    done: [] as string[],
    async mark(step: string) {
      steps.done.push(step);
    },
    async decide(escalation: ReviewEscalation) {
      decided = escalation;
      calls.push("decide");
    },
  };
  assert.equal(await settleReview(state, input, { ...deps, steps }), "escalated");
  assert.deepEqual(decided, { reasons: ["timed out", "timed out"] });
  assert.equal(calls[0], "decide", "the decision is saved before the first write");
  assert.deepEqual(calls.slice(1), [
    `comment ${parent.id}`,
    `move ${parent.id} Needs input`,
    `move ${part.id} Needs input`,
    "notice",
  ]);

  // A restart emptied the in-memory count. The saved decision finishes the escalation
  // without counting the run again or deciding twice.
  resetReviewNotJudged();
  calls.length = 0;
  const replaySteps = {
    done: [`comment on ${parent.key}`],
    async mark(step: string) {
      replaySteps.done.push(step);
    },
    async decide() {
      throw new Error("a replay must not decide again");
    },
  };
  assert.equal(
    await settleReview(
      { reviewFailures: {}, reviewRunFailures: {}, qaFeedback: {} },
      { ...input, escalation: decided },
      { ...deps, steps: replaySteps },
    ),
    "escalated",
  );
  assert.deepEqual(calls, [
    `move ${parent.id} Needs input`,
    `move ${part.id} Needs input`,
    "notice",
  ]);

  // A decide that cannot save keeps every Linear write back, so the retry decides again.
  resetReviewNotJudged();
  assert.equal(await settleReview(state, input, deps), "requeued");
  calls.length = 0;
  const unsaved = {
    done: [] as string[],
    async mark() {},
    async decide() {
      throw new Error("state write failed");
    },
  };
  assert.equal(await settleReview(state, input, { ...deps, steps: unsaved }), "pending");
  assert.equal(calls.length, 0, "no write when the decision did not save");
});

test("a design finding takes the coordinator's fix and keeps each hint with its finding (MET-243, D-059)", async () => {
  const comments: Array<{ id: string; body: string }> = [];
  const moves: Array<{ id: string; state: string }> = [];
  const deps: ReviewSettleDeps = {
    linear: {
      async comment(id, body) {
        comments.push({ id, body });
        return "comment-1";
      },
      async moveTo(id, state) {
        moves.push({ id, state });
      },
    },
    notifier: { async notify() {} },
    maxFailures: 3,
    maxReviewRounds: 6,
  };
  const state: Parameters<typeof settleReview>[0] = {
    reviewFailures: {},
    reviewRunFailures: {},
    qaFeedback: {},
  };
  const design: ReviewFinding = {
    file: "src/shape.ts",
    line: 4,
    severity: "blocking",
    kind: "design",
    text: "This belongs in the review module, not the loop.",
  };
  const code: ReviewFinding = {
    file: "src/api.ts",
    line: 12,
    severity: "blocking",
    kind: "code",
    text: "The loop reads the file on every tick.",
  };
  const input = {
    part,
    parent,
    pr: pr(),
    verdict: { decision: "changes_requested" as const, findings: [design, code] },
    decision: {
      decision: "fix" as const,
      hints: [
        { id: "R1", hint: "Move the seam into the review module." },
        { id: "R2", hint: "Read the file once per part run." },
      ],
    },
  };

  assert.equal(await settleReview(state, input, deps), "sent_back");
  assert.deepEqual(state.reviewFailures, { [part.id]: 1 }, "a fix counts its round");
  assert.equal(state.reviewRunFailures[part.id], undefined, "a round is not a failed run");
  assert.equal(state.qaFeedback[part.id]?.source, "review");
  assert.deepEqual(state.qaFeedback[part.id]?.failing, [
    "R1 (src/shape.ts:4) This belongs in the review module, not the loop.",
    "R2 (src/api.ts:12) The loop reads the file on every tick.",
  ]);
  assert.deepEqual(state.qaFeedback[part.id]?.hints, [
    { id: "R1", hint: "Move the seam into the review module." },
    { id: "R2", hint: "Read the file once per part run." },
  ]);
  assert.deepEqual(moves, [{ id: part.id, state: "Ready" }], "the part goes back to Ready");
  const parentComment = comments.find((comment) => comment.id === parent.id)?.body ?? "";
  assert.match(parentComment, /^\*\*harnessd review\*\*: round 1 of 6 on MET-223 PR #223: fix/);
  assert.match(parentComment, /R1 \(src\/shape\.ts:4\) This belongs in the review module/);
  assert.match(parentComment, /\n {2}hint: Move the seam into the review module\./);
  assert.match(parentComment, /\n {2}hint: Read the file once per part run\./);
  const partComment = comments.find((comment) => comment.id === part.id)?.body ?? "";
  assert.match(partComment, /changes requested on \[PR #223\]/);
  assert.match(partComment, /- R1 \(src\/shape\.ts:4\)/);
});

test("an escalate decision moves both issues and posts the D-011 question on the parent (MET-243)", async () => {
  const comments: Array<{ id: string; body: string }> = [];
  const moves: Array<{ id: string; state: string }> = [];
  let notices = 0;
  const deps: ReviewSettleDeps = {
    linear: {
      async comment(id, body) {
        comments.push({ id, body });
        return "comment-1";
      },
      async moveTo(id, state) {
        moves.push({ id, state });
      },
    },
    notifier: {
      async notify() {
        notices += 1;
      },
    },
    maxFailures: 2,
    maxReviewRounds: 6,
  };
  const state: Parameters<typeof settleReview>[0] = {
    reviewFailures: { [part.id]: 1 },
    reviewRunFailures: { [part.id]: 1 },
    qaFeedback: {},
  };
  const input = {
    part,
    parent,
    pr: pr(),
    verdict: {
      decision: "changes_requested" as const,
      findings: [
        {
          file: "src/shape.ts",
          line: 4,
          severity: "blocking" as const,
          kind: "design" as const,
          text: "This changes the public API.",
        },
      ],
    },
    decision: {
      decision: "escalate" as const,
      trigger: "public_api_data_model_or_protected_path" as const,
      question: "May the change alter the public API?",
      options: ["Alter it", "Keep it internal"],
      recommendation: "Keep it internal.",
    },
  };

  assert.equal(await settleReview(state, input, deps), "escalated");
  assert.deepEqual(state.qaFeedback, {}, "nothing goes to the builder");
  assert.deepEqual(state.reviewRunFailures, {}, "the escalation clears the failed runs");
  assert.deepEqual(state.reviewFailures, {}, "the escalation clears the round count");
  assert.deepEqual(moves, [
    { id: parent.id, state: "Needs input" },
    { id: part.id, state: "Needs input" },
  ]);
  assert.equal(notices, 1, "one notice");
  const body = comments.find((comment) => comment.id === parent.id)?.body ?? "";
  assert.match(
    body,
    /round 2 of 6 on MET-223 PR #223: escalate \(`public_api_data_model_or_protected_path`\)/,
  );
  assert.match(body, /Trigger: changes a public API, the data model or a protected path/);
  assert.match(body, /Question: May the change alter the public API\?/);
  assert.match(body, /Options:\n- Alter it\n- Keep it internal/);
  assert.match(body, /Recommendation: Keep it internal\./);
});

test("a changes_requested verdict with no decision is a fix send-back with no hints (MET-243)", async () => {
  const comments: string[] = [];
  const deps: ReviewSettleDeps = {
    linear: {
      async comment(_id, body) {
        comments.push(body);
        return "comment-1";
      },
      async moveTo() {},
    },
    notifier: { async notify() {} },
    maxFailures: 2,
    maxReviewRounds: 6,
  };
  const state: Parameters<typeof settleReview>[0] = {
    reviewFailures: {},
    reviewRunFailures: {},
    qaFeedback: {},
  };
  const verdict = {
    decision: "changes_requested" as const,
    findings: [
      {
        file: "src/a.ts",
        line: 1,
        severity: "blocking" as const,
        kind: "design" as const,
        text: "A design fault.",
      },
    ],
  };

  assert.equal(await settleReview(state, { part, parent, pr: pr(), verdict }, deps), "sent_back");
  assert.equal(state.qaFeedback[part.id]?.hints, undefined);
  assert.match(comments[1] ?? "", /round 1 of 6 on MET-223 PR #223: fix/);
});

test("round 6 at limits.max_review_rounds escalates with one notice and no send-back (MET-244, D-062)", async () => {
  const comments: Array<{ id: string; body: string }> = [];
  const moves: Array<{ id: string; state: string }> = [];
  const notices: Array<{ reason: string; detail: string }> = [];
  const deps: ReviewSettleDeps = {
    linear: {
      async comment(id, body) {
        comments.push({ id, body });
        return "comment-1";
      },
      async moveTo(id, state) {
        moves.push({ id, state });
      },
    },
    notifier: {
      async notify(notice) {
        notices.push({ reason: notice.reason ?? "", detail: notice.detail ?? "" });
      },
    },
    maxFailures: 2,
    maxReviewRounds: 6,
  };
  const state: Parameters<typeof settleReview>[0] = {
    reviewFailures: { [part.id]: 5 },
    reviewRunFailures: {},
    qaFeedback: { [part.id]: { source: "review", failing: ["R1 (src/a.ts:1) Fix it."] } },
  };
  const verdict = {
    decision: "changes_requested" as const,
    findings: [
      {
        file: "src/a.ts",
        line: 1,
        severity: "blocking" as const,
        kind: "design" as const,
        text: "The seam sits in the loop.",
      },
      {
        file: "src/b.ts",
        line: 2,
        severity: "blocking" as const,
        kind: "code" as const,
        text: "The file is read on every tick.",
      },
    ],
  };
  // The loop saves the cap before its first write; a decision saved with it does not win.
  const input = {
    part,
    parent,
    pr: pr(),
    verdict,
    roundCap: true,
    decision: { decision: "fix" as const, hints: [] },
  };

  assert.equal(await settleReview(state, input, deps), "escalated");
  assert.deepEqual(state.reviewFailures, {}, "the cap escalation clears the round count");
  assert.deepEqual(state.reviewRunFailures, {}, "the cap escalation clears failed runs too");
  assert.deepEqual(state.qaFeedback, {}, "the review feedback is cleared");
  assert.deepEqual(moves, [
    { id: parent.id, state: "Needs input" },
    { id: part.id, state: "Needs input" },
  ]);
  assert.equal(notices.length, 1, "one notice");
  assert.equal(notices[0]?.reason, "review round cap reached");
  const parentComment = comments.find((comment) => comment.id === parent.id)?.body ?? "";
  assert.match(
    parentComment,
    /round 6 of 6 on MET-223 \[PR #223\]\(https:\/\/github\.test\/o\/r\/pull\/223\): review round cap reached/,
  );
  assert.match(parentComment, /sent MET-223 back 6 times/);
  assert.match(parentComment, /`limits\.max_review_rounds` \(6\)/);
  assert.match(parentComment, /- R1 \(src\/a\.ts:1\) The seam sits in the loop\./);
  assert.match(parentComment, /- R2 \(src\/b\.ts:2\) The file is read on every tick\./);
  assert.equal(
    comments.filter((comment) => comment.id === part.id).length,
    0,
    "nothing is sent back to the builder",
  );
});

test("a failed review run still escalates at maxFailures, not the review round cap (MET-244, D-062)", async () => {
  let notices = 0;
  const deps: ReviewSettleDeps = {
    linear: {
      async comment() {
        return "comment-1";
      },
      async moveTo() {},
    },
    notifier: {
      async notify() {
        notices += 1;
      },
    },
    maxFailures: 2,
    maxReviewRounds: 6,
  };
  const state: Parameters<typeof settleReview>[0] = {
    reviewFailures: {},
    reviewRunFailures: { [part.id]: 1 },
    qaFeedback: {},
  };

  assert.equal(
    await settleReview(state, { part, parent, pr: pr(), error: "no verdict" }, deps),
    "escalated",
  );
  assert.equal(notices, 1);
  assert.deepEqual(state.reviewRunFailures, {}, "the failed-run escalation clears the count");
});

test("failed review runs and changes_requested rounds have separate caps (MET-244, D-062)", async () => {
  const notices: string[] = [];
  const deps: ReviewSettleDeps = {
    linear: {
      async comment() {
        return "comment-1";
      },
      async moveTo() {},
    },
    notifier: {
      async notify(notice) {
        notices.push(notice.reason ?? "");
      },
    },
    maxFailures: 2,
    maxReviewRounds: 6,
  };
  const finding = {
    file: "src/a.ts",
    line: 1,
    severity: "blocking" as const,
    kind: "code" as const,
    text: "A blocking fault.",
  };
  const fix = { decision: "fix" as const, hints: [{ id: "R1", hint: "Fix it." }] };
  const verdict = { decision: "changes_requested" as const, findings: [finding] };
  const state: Parameters<typeof settleReview>[0] = {
    reviewFailures: {},
    reviewRunFailures: {},
    qaFeedback: {},
  };

  // One no-verdict run first does not consume a review round.
  assert.equal(
    await settleReview(state, { part, parent, pr: pr(), error: "no verdict" }, deps),
    "requeued",
  );
  assert.equal(state.reviewRunFailures[part.id], 1, "the failed run counts once");
  assert.equal(state.reviewFailures[part.id], undefined, "no round is counted");

  // Five blocking verdicts stay below the cap, then the sixth escalates with the cap reason.
  for (let round = 1; round <= 5; round++) {
    assert.equal(
      await settleReview(state, { part, parent, pr: pr(), verdict, decision: fix }, deps),
      "sent_back",
    );
    assert.equal(state.reviewFailures[part.id], round);
    assert.equal(state.reviewRunFailures[part.id], 1, "the failed run keeps its own count");
  }
  assert.deepEqual(notices, [], "no cap escalation before round 6");
  assert.equal(
    await settleReview(state, { part, parent, pr: pr(), verdict, roundCap: true }, deps),
    "escalated",
  );
  assert.deepEqual(notices, ["review round cap reached"]);
  assert.deepEqual(state.reviewFailures, {}, "the cap clears the rounds");
  assert.deepEqual(state.reviewRunFailures, {}, "the cap clears the failed runs too");

  // One blocking verdict does not consume a failed-run failure: the first failed run retries.
  const failed: Parameters<typeof settleReview>[0] = {
    reviewFailures: { [part.id]: 1 },
    reviewRunFailures: {},
    qaFeedback: {},
  };
  assert.equal(
    await settleReview(failed, { part, parent, pr: pr(), error: "no verdict" }, deps),
    "requeued",
  );
  assert.equal(failed.reviewRunFailures[part.id], 1, "the first failed run retries");
  assert.equal(failed.reviewFailures[part.id], 1, "the round count is untouched");

  // The second failed run escalates under D-014, whatever the round count is.
  notices.length = 0;
  assert.equal(
    await settleReview(failed, { part, parent, pr: pr(), error: "no verdict" }, deps),
    "escalated",
  );
  assert.deepEqual(notices, ["review failed twice"], "the round count does not change the cap");
});

test("a saved fix is honored when the round count is at or over a lowered cap (MET-244, D-062)", async () => {
  const notices: string[] = [];
  const deps: ReviewSettleDeps = {
    linear: {
      async comment() {
        return "comment-1";
      },
      async moveTo() {},
    },
    notifier: {
      async notify(notice) {
        notices.push(notice.reason ?? "");
      },
    },
    maxFailures: 2,
    maxReviewRounds: 3,
  };
  const state: Parameters<typeof settleReview>[0] = {
    reviewFailures: { [part.id]: 5 },
    reviewRunFailures: {},
    qaFeedback: {},
  };
  const finding = {
    file: "src/a.ts",
    line: 1,
    severity: "blocking" as const,
    kind: "code" as const,
    text: "A blocking fault.",
  };

  assert.equal(
    await settleReview(
      state,
      {
        part,
        parent,
        pr: pr(),
        verdict: { decision: "changes_requested", findings: [finding] },
        decision: { decision: "fix", hints: [{ id: "R1", hint: "Fix it." }] },
      },
      deps,
    ),
    "sent_back",
    "a saved fix keeps the route it already started",
  );
  assert.equal(state.reviewFailures?.[part.id], 6, "the replayed send-back counts its round");
  assert.deepEqual(state.qaFeedback[part.id]?.hints, [{ id: "R1", hint: "Fix it." }]);
  assert.deepEqual(notices, [], "a saved fix does not escalate at the lowered cap");
});
