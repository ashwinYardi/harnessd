import assert from "node:assert/strict";
import { test } from "node:test";
import type { Issue, LinkedIssue, ResolvedAgentConfig, Task } from "@harnessd/shared";
import { mergeLayers } from "../config/merge.ts";
import type { PullRequest } from "../github/client.ts";
import { maxTurns } from "./dispatch.ts";
import {
  buildReviewPrompt,
  buildReviewTask,
  formatReviewComment,
  parseReviewVerdict,
  type ReviewFinding,
  settleReview,
} from "./review.ts";
import { partMarker } from "./split.ts";

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
    qaFeedback: { [part.id]: qaFeedback },
  };

  assert.equal(await settleReview(state, input, deps), "approved");
  assert.equal(state.reviewFailures[part.id], 1, "an approval keeps the failure count");
  assert.deepEqual(state.qaFeedback[part.id], qaFeedback, "QA feedback stays");

  const reviewState = {
    reviewFailures: { [part.id]: 1 },
    qaFeedback: {
      [part.id]: { source: "review" as const, failing: ["R1 (src/a.ts:1) Fix it."] },
    },
  };
  assert.equal(await settleReview(reviewState, input, deps), "approved");
  assert.equal(
    reviewState.reviewFailures[part.id],
    1,
    "the count still waits for Done or escalation",
  );
  assert.equal(reviewState.qaFeedback[part.id], undefined, "its own review send-back is cleared");
});
