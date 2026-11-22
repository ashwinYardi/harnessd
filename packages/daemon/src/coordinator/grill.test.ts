import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  type AdapterEvent,
  type AdapterRun,
  type DecisionNote,
  emptyTokenUsage,
  type HarnessAdapter,
  type Issue,
  type ResolvedAgentConfig,
  type RunResult,
  type Task,
  type WorkflowStateName,
} from "@harnessd/shared";
import type { DecisionSink } from "./decisions.ts";
import { extractJson, type GrillDeps, grillIssue, parseGrillReply } from "./grill.ts";
import { formatNotice, type Notifier } from "./notifier.ts";
import type { GrillContext } from "./prompt.ts";

const issues = JSON.parse(
  readFileSync(new URL("./fixtures/issues.json", import.meta.url), "utf8"),
) as Record<"clear" | "secret" | "taste", Issue>;

/** A scripted reply: final text, or a run that fails. */
type Reply = string | { status: RunResult["status"]; error: string };

/** In-memory HarnessAdapter that answers each run with the next scripted reply. */
function fakeAdapter(replies: Reply[]) {
  const tasks: Task[] = [];
  const cwds: string[] = [];
  const queue = [...replies];
  const adapter: HarnessAdapter = {
    id: "claude-code",
    start(task, worktree): AdapterRun {
      tasks.push(task);
      cwds.push(worktree);
      const reply = queue.shift() ?? "";
      const result: RunResult = {
        status: typeof reply === "string" ? "ok" : reply.status,
        exitCode: typeof reply === "string" ? 0 : 1,
        durationMs: 5,
        tokens: emptyTokenUsage(),
      };
      if (typeof reply === "string") result.finalText = reply;
      else result.error = reply.error;
      const events: AdapterEvent[] = [
        { type: "start", taskId: task.id, pid: 1, argv: [], cwd: worktree },
        { type: "tool", name: "Read", summary: "docs/SPEC.md" },
        ...(typeof reply === "string" ? [{ type: "text" as const, text: reply }] : []),
        { type: "end", result },
      ];
      return {
        events: (async function* () {
          yield* events;
        })(),
        result: Promise.resolve(result),
        cancel: async () => {},
      };
    },
  };
  return { adapter, tasks, cwds };
}

function recorder() {
  const comments: Array<{ issueId: string; body: string }> = [];
  const moves: Array<{ issueId: string; state: WorkflowStateName }> = [];
  const pings: string[] = [];
  const notes: DecisionNote[] = [];
  const linear = {
    async comment(issueId: string, body: string) {
      comments.push({ issueId, body });
      return `comment-${comments.length}`;
    },
    async moveTo(issueId: string, state: WorkflowStateName) {
      moves.push({ issueId, state });
    },
  };
  const notifier: Notifier = {
    async notify(notice) {
      pings.push(formatNotice(notice));
    },
  };
  const decisions: DecisionSink = {
    async write(note) {
      notes.push(note);
      return `/vault/decisions/${note.issue}-${notes.length}.md`;
    },
  };
  return { linear, notifier, decisions, comments, moves, pings, notes };
}

const agent: ResolvedAgentConfig = {
  name: "coordinator",
  role: "coordinator",
  harness: "claude-code",
  model: "opus",
  instructions: "Keep the board honest.",
  rules: [],
  skills: [],
};

const context: GrillContext = {
  spec: "# harnessd: spec v0.1\nSlack #harnessd: one line per merge or block.",
  decisions: [
    { name: "D-011-autopilot-escalation.md", text: "# D-011 Autopilot; ask only when worth it" },
  ],
};

function setup(replies: Reply[]) {
  const fake = fakeAdapter(replies);
  const rec = recorder();
  const deps: GrillDeps = {
    adapter: fake.adapter,
    agent,
    context,
    cwd: "/repo",
    linear: rec.linear,
    notifier: rec.notifier,
    decisions: rec.decisions,
  };
  return { ...fake, ...rec, deps };
}

const reply = (value: unknown) => JSON.stringify(value);

test("clear issue: calls posted and noted, proceeds, no state change, no ping", async () => {
  const s = setup([
    reply({
      calls: [
        {
          question: "What does /health return?",
          answer: "{ ok: true, version } with VERSION from @harnessd/shared",
          basis: "packages/daemon/src/index.ts",
        },
        {
          question: "Which status for unknown paths?",
          answer: "404 with a JSON error body",
          basis: "issue Done when",
        },
      ],
      escalation: null,
    }),
  ]);
  const result = await grillIssue(issues.clear, s.deps);

  assert.equal(result.outcome, "proceed");
  assert.equal(result.escalation, null);
  assert.equal(result.calls.length, 2);
  assert.equal(s.tasks.length, 1);
  assert.equal(s.tasks[0]?.model, "opus");
  assert.equal(s.tasks[0]?.id, "grill-MET-40-1");
  assert.equal(s.tasks[0]?.maxTurns, 50);
  assert.deepEqual(s.cwds, ["/repo"]);

  assert.equal(s.notes.length, 2);
  assert.deepEqual(s.notes[0], {
    issue: "MET-40",
    title: "What does /health return",
    question: "What does /health return?",
    decision: "{ ok: true, version } with VERSION from @harnessd/shared",
    basis: "packages/daemon/src/index.ts",
  });

  assert.equal(s.comments.length, 1);
  assert.equal(s.comments[0]?.issueId, issues.clear.id);
  const body = s.comments[0]?.body ?? "";
  assert.match(body, /^\*\*Coordinator grill\*\*: proceeding, 2 calls\./);
  assert.match(
    body,
    /- What does \/health return\? → \{ ok: true, version \} with VERSION from @harnessd\/shared \(basis: packages\/daemon\/src\/index\.ts\)/,
  );
  assert.match(body, /- Which status for unknown paths\? → 404 with a JSON error body/);
  assert.doesNotMatch(body, /Question for the human/);

  assert.deepEqual(s.moves, []);
  assert.deepEqual(s.pings, []);
});

test("secret-needed issue: Needs input plus exactly one ping", async () => {
  const s = setup([
    reply({
      calls: [
        {
          question: "Which channel?",
          answer: "#harnessd",
          basis: "SPEC Visibility; config slack.channel",
        },
      ],
      escalation: {
        trigger: "secret_or_account",
        question: "Which Slack workspace and bot token should harnessd post with?",
        why: "Posting needs a Slack app token that is not in the secret store.",
      },
    }),
  ]);
  const result = await grillIssue(issues.secret, s.deps);

  assert.equal(result.outcome, "needs_input");
  assert.deepEqual(result.escalation, {
    trigger: "secret_or_account",
    question: "Which Slack workspace and bot token should harnessd post with?",
    why: "Posting needs a Slack app token that is not in the secret store.",
  });
  assert.deepEqual(s.moves, [{ issueId: issues.secret.id, state: "Needs input" }]);
  assert.equal(s.pings.length, 1);
  assert.equal(
    s.pings[0],
    "MET-41 needs input (secret_or_account): Which Slack workspace and bot token should harnessd post with? https://linear.app/meta-harness/issue/met-41",
  );

  assert.equal(s.comments.length, 1);
  const body = s.comments[0]?.body ?? "";
  assert.match(body, /^\*\*Coordinator grill\*\*: needs input, 1 call\./);
  assert.match(body, /- Which channel\? → #harnessd/);
  assert.match(
    body,
    /\*\*Question for the human:\*\* Which Slack workspace and bot token should harnessd post with\?/,
  );
  assert.match(body, /D-011 trigger: `secret_or_account` \(needs a secret or an account\)/);
  // Only the settled call becomes a decision note; the open question is not a decision.
  assert.equal(s.notes.length, 1);
});

test("taste call with no precedent: escalates", async () => {
  const s = setup([
    reply({
      calls: [],
      escalation: {
        trigger: "taste_no_precedent",
        question: "Generated initials or uploaded images for agent avatars?",
        why: "SPEC puts avatars in v0.2 and sets no style for them.",
      },
    }),
  ]);
  const result = await grillIssue(issues.taste, s.deps);

  assert.equal(result.outcome, "needs_input");
  assert.equal(result.escalation?.trigger, "taste_no_precedent");
  assert.deepEqual(s.moves, [{ issueId: issues.taste.id, state: "Needs input" }]);
  assert.equal(s.pings.length, 1);
  assert.match(s.comments[0]?.body ?? "", /- No open questions\./);
  assert.equal(s.notes.length, 0);
});

test("escalation with a non-D-011 reason is not escalated but recorded as a call", async () => {
  const s = setup([
    reply({
      calls: [{ question: "Port?", answer: "Free port by default", basis: "startDaemon" }],
      escalation: {
        trigger: "unclear_requirements",
        question: "Should /health also report uptime?",
        why: "The issue does not say.",
      },
    }),
  ]);
  const result = await grillIssue(issues.clear, s.deps);

  assert.equal(result.outcome, "proceed");
  assert.equal(result.escalation, null);
  assert.equal(result.calls.length, 2);
  const downgraded = result.calls[1];
  assert.equal(downgraded?.question, "Should /health also report uptime?");
  assert.match(downgraded?.answer ?? "", /"unclear_requirements" is not a D-011 trigger/);
  assert.match(downgraded?.basis ?? "", /The issue does not say\./);
  assert.equal(s.notes.length, 2);
  assert.match(s.comments[0]?.body ?? "", /proceeding, 2 calls/);
  assert.deepEqual(s.moves, []);
  assert.deepEqual(s.pings, []);
});

test("invalid JSON twice: error, one retry, no side effects", async () => {
  const s = setup(["Sure! Here are my thoughts on the issue.", '{"calls": [}']);
  const result = await grillIssue(issues.secret, s.deps);

  assert.equal(result.outcome, "error");
  assert.equal(result.escalation, null);
  assert.equal(s.tasks.length, 2);
  assert.equal(s.tasks[1]?.id, "grill-MET-41-2");
  assert.match(s.tasks[1]?.prompt ?? "", /Your previous reply was rejected \(not JSON/);
  assert.equal(result.calls.length, 1);
  assert.match(result.calls[0]?.answer ?? "", /no comment, no state change and no ping/);
  assert.deepEqual(s.comments, []);
  assert.deepEqual(s.moves, []);
  assert.deepEqual(s.pings, []);
  assert.deepEqual(s.notes, []);
});

test("invalid first reply, valid retry: proceeds", async () => {
  const s = setup([
    { status: "timeout", error: "budget of 600000ms exceeded" },
    reply({ calls: [], escalation: null }),
  ]);
  const result = await grillIssue(issues.clear, s.deps);
  assert.equal(result.outcome, "proceed");
  assert.equal(s.tasks.length, 2);
  assert.match(s.tasks[1]?.prompt ?? "", /harness run timeout/);
  assert.equal(s.comments.length, 1);
});

test("fenced JSON reply is parsed", async () => {
  const fenced = `Here is the grill.\n\n\`\`\`json\n${reply({
    calls: [{ question: "Q?", answer: "A", basis: "D-011" }],
    escalation: null,
  })}\n\`\`\`\n`;
  const s = setup([fenced]);
  const result = await grillIssue(issues.clear, s.deps);
  assert.equal(result.outcome, "proceed");
  assert.deepEqual(result.calls, [{ question: "Q?", answer: "A", basis: "D-011" }]);
  assert.equal(s.tasks.length, 1);
});

test("a failed side effect stops before the ping", async () => {
  const s = setup([
    reply({
      calls: [],
      escalation: { trigger: "money", question: "Buy the Apple cert?", why: "$99/yr" },
    }),
  ]);
  s.deps.linear = {
    comment: s.linear.comment,
    async moveTo() {
      throw new Error("no such state");
    },
  };
  const result = await grillIssue(issues.taste, s.deps);
  assert.equal(result.outcome, "error");
  assert.equal(result.error, "could not move the issue to Needs input: no such state");
  assert.equal(s.comments.length, 1);
  assert.deepEqual(s.pings, []);
});

test("adapter that does not match the coordinator harness is an error", async () => {
  const s = setup([]);
  s.deps.agent = { ...agent, harness: "codex" };
  const result = await grillIssue(issues.clear, s.deps);
  assert.equal(result.outcome, "error");
  assert.equal(s.tasks.length, 0);
});

test("parseGrillReply validates strictly", () => {
  const ok = parseGrillReply('{"calls":[],"escalation":null}');
  assert.deepEqual(ok, { ok: true, calls: [], escalation: null });
  const bad = (text: string) => {
    const r = parseGrillReply(text);
    assert.equal(r.ok, false, text);
    return r.ok ? "" : r.error;
  };
  assert.match(bad('{"calls":[]}'), /escalation: missing/);
  assert.match(bad('{"calls":{},"escalation":null}'), /calls: expected an array/);
  assert.match(bad('{"calls":[],"escalation":null,"notes":1}'), /unknown key "notes"/);
  assert.match(bad('{"calls":[{"question":"Q","answer":""}],"escalation":null}'), /answer/);
  assert.match(
    bad('{"calls":[{"question":"Q","answer":"A","basis":"B","x":1}],"escalation":null}'),
    /unknown key "x"/,
  );
  assert.match(bad('{"calls":[],"escalation":{"trigger":"money"}}'), /escalation\.question/);
  assert.match(bad('{"calls":[],"escalation":"money"}'), /expected null or an object/);
  assert.match(bad("[]"), /expected a JSON object/);
});

test("extractJson tolerates a json or bare fence", () => {
  assert.equal(extractJson('```json\n{"a":1}\n```'), '{"a":1}');
  assert.equal(extractJson('```\n{"a":1}\n```'), '{"a":1}');
  assert.equal(extractJson('  {"a":1}  '), '{"a":1}');
});

test("terms and precedents go to the vault sink and the comment", async () => {
  const s = setup([
    reply({
      calls: [
        { question: "Where do new terms go?", answer: "The workspace vault", basis: "D-017" },
      ],
      escalation: null,
      terms: [
        { term: "Work part", definition: "A sub-issue the split creates.", avoid: ["chunk"] },
      ],
      precedents: [
        {
          title: "Terms go to the workspace vault",
          decision: "The loop never writes GLOSSARY.md.",
          why: "GLOSSARY.md stays human-reviewed.",
        },
      ],
    }),
  ]);
  const terms: unknown[] = [];
  const drafts: unknown[] = [];
  s.deps.decisions = {
    write: s.decisions.write,
    async term(t) {
      terms.push(t);
      return "glossary/work-part.md";
    },
    async draft(d) {
      drafts.push(d);
      return "decision-drafts/MET-40-terms.md";
    },
  };
  const result = await grillIssue(issues.clear, s.deps);

  assert.equal(result.outcome, "proceed");
  assert.equal(s.notes.length, 1, "each call is still a decision note");
  assert.deepEqual(terms, [
    {
      issue: "MET-40",
      term: "Work part",
      definition: "A sub-issue the split creates.",
      avoid: ["chunk"],
    },
  ]);
  assert.deepEqual(drafts, [
    {
      issue: "MET-40",
      title: "Terms go to the workspace vault",
      decision: "The loop never writes GLOSSARY.md.",
      why: "GLOSSARY.md stays human-reviewed.",
    },
  ]);
  assert.deepEqual(result.terms, [
    { term: "Work part", definition: "A sub-issue the split creates.", avoid: ["chunk"] },
  ]);
  assert.equal(result.precedents?.length, 1);
  const body = s.comments[0]?.body ?? "";
  assert.match(
    body,
    /\*\*New terms\*\* \(workspace glossary\):\n- Work part: A sub-issue the split creates\./,
  );
  assert.match(
    body,
    /\*\*Draft decision records\*\* \(for a docs PR\):\n- Terms go to the workspace vault: The loop never writes GLOSSARY\.md\./,
  );
});

test("a sink without term or draft still posts them in the comment", async () => {
  const s = setup([
    reply({
      calls: [],
      escalation: null,
      terms: [{ term: "Frontier", definition: "Open questions whose prerequisites are settled." }],
      precedents: [],
    }),
  ]);
  const result = await grillIssue(issues.clear, s.deps);
  assert.equal(result.outcome, "proceed");
  assert.match(s.comments[0]?.body ?? "", /- Frontier: Open questions/);
  assert.doesNotMatch(s.comments[0]?.body ?? "", /Draft decision records/);
});

test("parseGrillReply validates terms and precedents", () => {
  const ok = parseGrillReply(
    '{"calls":[],"escalation":null,"terms":[{"term":"T","definition":"D"}],"precedents":[]}',
  );
  assert.deepEqual(ok, {
    ok: true,
    calls: [],
    escalation: null,
    terms: [{ term: "T", definition: "D", avoid: [] }],
    precedents: [],
  });
  const bad = (text: string) => {
    const r = parseGrillReply(text);
    assert.equal(r.ok, false, text);
    return r.ok ? "" : r.error;
  };
  assert.match(bad('{"calls":[],"escalation":null,"terms":{}}'), /terms: expected an array/);
  assert.match(
    bad('{"calls":[],"escalation":null,"terms":[{"term":"T"}]}'),
    /terms\[0\]\.definition/,
  );
  assert.match(
    bad('{"calls":[],"escalation":null,"terms":[{"term":"T","definition":"D","avoid":"x"}]}'),
    /terms\[0\]\.avoid: expected an array of non-empty strings/,
  );
  assert.match(
    bad('{"calls":[],"escalation":null,"precedents":[{"title":"T","decision":"D"}]}'),
    /precedents\[0\]\.why/,
  );
});

test("a term or draft that already exists is not announced as new", async () => {
  const s = setup([
    reply({
      calls: [],
      escalation: null,
      terms: [{ term: "Pin", definition: "A commit." }],
      precedents: [{ title: "Old", decision: "D.", why: "W." }],
    }),
  ]);
  s.deps.decisions = {
    write: s.decisions.write,
    term: async () => undefined,
    draft: async () => undefined,
  };
  const result = await grillIssue(issues.clear, s.deps);
  assert.equal(result.outcome, "proceed");
  assert.doesNotMatch(s.comments[0]?.body ?? "", /New terms|Draft decision records/);
});

test("a limited run ends the grill at once: no retry, no note, no comment, no escalation (MET-70)", async () => {
  const s = setup([{ status: "limited", error: "usage limit reached" }]);
  const result = await grillIssue(issues.secret, s.deps);
  assert.equal(result.outcome, "limited");
  assert.equal(result.escalation, null);
  assert.equal(s.tasks.length, 1, "no retry while the harness is limited");
  assert.deepEqual(s.comments, []);
  assert.deepEqual(s.moves, []);
  assert.deepEqual(s.pings, []);
  assert.deepEqual(s.notes, []);
});
