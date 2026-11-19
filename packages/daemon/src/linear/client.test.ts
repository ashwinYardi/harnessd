import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { SecretSource } from "@harnessd/shared";
import {
  LINEAR_ENDPOINT,
  LinearClient,
  LinearError,
  MISSING_KEY_MESSAGE,
  parseRetryAfter,
} from "./client.ts";

const KEY = "lin_api_test_0000";
const TEAM_ID = "5b3e4a0c-2f1d-4a8e-9c61-7d2b8f0e3a11";
const MET12_ID = "9f1c2d3e-0a4b-4c5d-8e6f-112233445512";

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
}

interface Reply {
  fixture?: string;
  body?: unknown;
  status?: number;
  headers?: Record<string, string>;
}

interface Sent {
  url: string;
  headers: Record<string, string>;
  query: string;
  variables: Record<string, unknown>;
}

/** A recorded-fixture fetch: replies in order and records every request. */
function replay(replies: Reply[]) {
  const sent: Sent[] = [];
  const queue = [...replies];
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const payload = JSON.parse(String(init?.body));
    sent.push({
      url: String(input),
      headers: init?.headers as Record<string, string>,
      query: payload.query,
      variables: payload.variables,
    });
    const reply = queue.shift();
    if (!reply) throw new Error(`unexpected request: ${payload.query}`);
    const body = reply.fixture ? fixture(reply.fixture) : reply.body;
    return new Response(JSON.stringify(body), {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json", ...reply.headers },
    });
  }) as typeof fetch;
  return { fetch: fakeFetch, sent, remaining: () => queue.length };
}

function secrets(value: string | undefined): SecretSource & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    get: async (name) => {
      reads.push(name);
      return value;
    },
  };
}

function client(replies: Reply[], extra: { sleep?: (ms: number) => Promise<void> } = {}) {
  const fake = replay(replies);
  const source = secrets(KEY);
  const linear = new LinearClient({ apiKey: source, fetch: fake.fetch, ...extra });
  return { linear, source, ...fake };
}

test("listReady pages through Ready issues, drops blocked ones and sorts by priority", async () => {
  const { linear, sent, source } = client([
    { fixture: "ready-page-1" },
    { fixture: "ready-page-2" },
  ]);
  const issues = await linear.listReady({ teamId: TEAM_ID, projectId: "proj-1" });

  assert.deepEqual(
    issues.map((i) => i.key),
    ["MET-17", "MET-16", "MET-12", "MET-18", "MET-14"],
  );
  assert.equal(
    issues.some((i) => i.key === "MET-15"),
    false,
    "MET-15 is blocked by MET-13",
  );

  assert.deepEqual(source.reads, ["linear-api-key"]);
  assert.equal(sent.length, 2);
  for (const req of sent) {
    assert.equal(req.url, LINEAR_ENDPOINT);
    assert.equal(req.headers.Authorization, KEY, "personal keys carry no Bearer prefix");
    assert.equal(req.headers["Content-Type"], "application/json");
    assert.match(req.query, /query ReadyIssues\(/);
    assert.match(req.query, /inverseRelations \{ nodes \{ type issue \{ identifier state \{ type/);
    assert.match(req.query, /pageInfo \{ hasNextPage endCursor \}/);
    assert.deepEqual(req.variables.filter, {
      team: { id: { eq: TEAM_ID } },
      state: { name: { eqIgnoreCase: "Ready" } },
      project: { id: { eq: "proj-1" } },
    });
    assert.equal(req.variables.first, 50);
  }
  assert.equal(sent[0]?.variables.after, null);
  assert.equal(sent[1]?.variables.after, "WyIyMDI2LTExLTAxVDEwOjMwOjAwLjAwMFoiXQ==");
});

test("listReady omits the project filter when no project is given", async () => {
  const { linear, sent } = client([{ fixture: "ready-page-2" }]);
  await linear.listReady({ teamId: TEAM_ID });
  assert.deepEqual(Object.keys(sent[0]?.variables.filter ?? {}), ["team", "state"]);
});

test("listReady parses size, Done when, labels, milestone and finished blockers", async () => {
  const { linear } = client([{ fixture: "ready-page-1" }, { fixture: "ready-page-2" }]);
  const issues = await linear.listReady({ teamId: TEAM_ID });
  const met12 = issues.find((i) => i.key === "MET-12");
  assert.deepEqual(met12, {
    id: MET12_ID,
    key: "MET-12",
    title: "Coordinator picks the highest-priority Ready issue",
    description: met12?.description,
    priority: 2,
    state: "Ready",
    labels: ["coordinator"],
    size: "M",
    doneWhen: [
      { text: "Picks the urgent Ready issue first", checked: false },
      { text: "Skips blocked issues", checked: true },
      { text: "Records the pick as a comment", checked: false },
    ],
    url: "https://linear.app/meta-harness/issue/met-12",
    blockedBy: [],
    milestone: "v0.1 MVP",
  });
  const met14 = issues.find((i) => i.key === "MET-14");
  assert.equal(met14?.size, undefined);
  assert.deepEqual(met14?.doneWhen, []);
  assert.equal(met14?.milestone, undefined);
  assert.equal(issues.find((i) => i.key === "MET-18")?.size, "L");
});

test("getIssue reads one issue by key", async () => {
  const { linear, sent } = client([{ fixture: "issue" }]);
  const issue = await linear.getIssue("MET-12");
  assert.equal(issue.id, MET12_ID);
  assert.equal(issue.size, "M");
  assert.match(sent[0]?.query ?? "", /query Issue\(\$id: String!\)/);
  assert.deepEqual(sent[0]?.variables, { id: "MET-12" });
});

test("getIssue surfaces a missing issue as a LinearError", async () => {
  const { linear } = client([{ fixture: "error-not-found", status: 400 }]);
  await assert.rejects(linear.getIssue("MET-999"), {
    name: "LinearError",
    code: "graphql",
    message: "Linear error: Could not find referenced Issue.",
  });
});

test("moveTo resolves the state id by name and caches the team's states", async () => {
  const { linear, sent, remaining } = client([
    { fixture: "issue-team" },
    { fixture: "team-states" },
    { fixture: "issue-update" },
    { fixture: "issue-update" },
  ]);
  await linear.moveTo(MET12_ID, "In Progress");
  await linear.moveTo(MET12_ID, "Needs input");

  assert.equal(remaining(), 0);
  assert.deepEqual(
    sent.map((r) => /^(?:query|mutation) (\w+)/.exec(r.query)?.[1]),
    ["IssueTeam", "TeamStates", "IssueUpdate", "IssueUpdate"],
  );
  assert.deepEqual(sent[0]?.variables, { id: MET12_ID });
  assert.deepEqual(sent[1]?.variables, { teamId: TEAM_ID });
  assert.deepEqual(sent[2]?.variables, {
    id: MET12_ID,
    input: { stateId: "0c7e1b2a-3d4f-4e5a-9b6c-000000000003" },
  });
  assert.deepEqual(sent[3]?.variables, {
    id: MET12_ID,
    input: { stateId: "0c7e1b2a-3d4f-4e5a-9b6c-000000000005" },
  });
});

test("moveTo skips the team lookup for issues the client has already read", async () => {
  const { linear, sent } = client([
    { fixture: "issue" },
    { fixture: "team-states" },
    { fixture: "issue-update" },
  ]);
  await linear.getIssue("MET-12");
  await linear.moveTo("MET-12", "Done");
  assert.deepEqual(
    sent.map((r) => /^(?:query|mutation) (\w+)/.exec(r.query)?.[1]),
    ["Issue", "TeamStates", "IssueUpdate"],
  );
  assert.deepEqual(sent[2]?.variables, {
    id: "MET-12",
    input: { stateId: "0c7e1b2a-3d4f-4e5a-9b6c-000000000006" },
  });
});

test("moveTo fails clearly when the team lacks the state", async () => {
  const states = fixture("team-states") as {
    data: { team: { states: { nodes: { name: string }[] } } };
  };
  states.data.team.states.nodes = states.data.team.states.nodes.filter(
    (s) => s.name !== "Needs input",
  );
  const { linear } = client([{ fixture: "issue-team" }, { body: states }]);
  await assert.rejects(linear.moveTo(MET12_ID, "Needs input"), (error: unknown) => {
    assert.ok(error instanceof LinearError);
    assert.equal(error.code, "not_found");
    assert.match(error.message, /no workflow state "Needs input"/);
    return true;
  });
});

test("comment posts a commentCreate mutation and returns the comment id", async () => {
  const { linear, sent } = client([{ fixture: "comment-create" }]);
  const id = await linear.comment(MET12_ID, "Picked up by the coordinator.");
  assert.equal(id, "c4d5e6f7-1a2b-4c3d-8e9f-aabbccddeeff");
  assert.match(sent[0]?.query ?? "", /mutation CommentCreate\(\$input: CommentCreateInput!\)/);
  assert.match(sent[0]?.query ?? "", /commentCreate\(input: \$input\)/);
  assert.deepEqual(sent[0]?.variables, {
    input: { issueId: MET12_ID, body: "Picked up by the coordinator." },
  });
});

test("a missing API key fails before any request", async () => {
  for (const apiKey of [secrets(undefined), secrets("  "), async () => undefined]) {
    const fake = replay([]);
    const linear = new LinearClient({ apiKey, fetch: fake.fetch });
    await assert.rejects(linear.listReady({ teamId: TEAM_ID }), {
      name: "LinearError",
      code: "missing_key",
      message: 'Linear API key not set. Run "harnessd secrets set linear-api-key".',
    });
    assert.equal(fake.sent.length, 0);
  }
  assert.equal(
    MISSING_KEY_MESSAGE,
    'Linear API key not set. Run "harnessd secrets set linear-api-key".',
  );
});

test("a function key source is accepted", async () => {
  const fake = replay([{ fixture: "comment-create" }]);
  const linear = new LinearClient({ apiKey: async () => "lin_api_fn", fetch: fake.fetch });
  await linear.comment(MET12_ID, "hi");
  assert.equal(fake.sent[0]?.headers.Authorization, "lin_api_fn");
});

test("HTTP 401 and Linear auth errors map to an auth LinearError and drop the cached key", async () => {
  const { linear, source } = client([
    { body: { errors: [{ message: "Unauthorized" }] }, status: 401 },
    { fixture: "error-auth", status: 400 },
    { fixture: "comment-create" },
  ]);
  await assert.rejects(linear.comment(MET12_ID, "x"), { code: "auth", status: 401 });
  await assert.rejects(linear.comment(MET12_ID, "x"), (error: unknown) => {
    assert.ok(error instanceof LinearError);
    assert.equal(error.code, "auth");
    assert.match(error.message, /Linear rejected the API key/);
    return true;
  });
  await linear.comment(MET12_ID, "x");
  assert.equal(source.reads.length, 3, "key is re-read after each auth failure");
});

test("GraphQL errors surface the user-presentable message", async () => {
  const { linear } = client([{ fixture: "error-graphql", status: 400 }]);
  await assert.rejects(linear.comment(MET12_ID, "x"), {
    name: "LinearError",
    code: "graphql",
    status: 400,
    message: "Linear error: stateId must be a UUID.",
  });
});

test("other HTTP failures map to an http LinearError", async () => {
  const { linear } = client([{ body: "upstream down", status: 502 }]);
  await assert.rejects(linear.comment(MET12_ID, "x"), {
    code: "http",
    status: 502,
    message: "Linear request failed with HTTP 502.",
  });
});

test("network failures map to a network LinearError", async () => {
  const linear = new LinearClient({
    apiKey: async () => KEY,
    fetch: (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch,
  });
  await assert.rejects(linear.comment(MET12_ID, "x"), {
    code: "network",
    message: "Linear request failed: fetch failed",
  });
});

test("429 is retried once after Retry-After", async () => {
  const waits: number[] = [];
  const { linear, sent } = client(
    [
      { fixture: "error-ratelimited", status: 429, headers: { "Retry-After": "2" } },
      { fixture: "comment-create" },
    ],
    { sleep: async (ms) => void waits.push(ms) },
  );
  assert.equal(await linear.comment(MET12_ID, "x"), "c4d5e6f7-1a2b-4c3d-8e9f-aabbccddeeff");
  assert.deepEqual(waits, [2000]);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0]?.variables, sent[1]?.variables);
});

test("a second rate limit surfaces as a rate_limited LinearError", async () => {
  const waits: number[] = [];
  const { linear, sent } = client(
    [
      { fixture: "error-ratelimited", status: 429 },
      { fixture: "error-ratelimited", status: 400 },
    ],
    { sleep: async (ms) => void waits.push(ms) },
  );
  await assert.rejects(linear.comment(MET12_ID, "x"), {
    name: "LinearError",
    code: "rate_limited",
    message: "Linear rate limit hit.",
  });
  assert.deepEqual(waits, [1000], "no Retry-After falls back to 1 s");
  assert.equal(sent.length, 2);
});

test("a Retry-After beyond the cap is not waited out", async () => {
  const waits: number[] = [];
  const { linear, sent } = client(
    [{ fixture: "error-ratelimited", status: 429, headers: { "Retry-After": "3600" } }],
    { sleep: async (ms) => void waits.push(ms) },
  );
  await assert.rejects(linear.comment(MET12_ID, "x"), { code: "rate_limited" });
  assert.deepEqual(waits, []);
  assert.equal(sent.length, 1);
});

test("parseRetryAfter reads seconds and HTTP dates", () => {
  const now = Date.parse("2026-11-19T10:00:00Z");
  assert.equal(parseRetryAfter("5", now), 5000);
  assert.equal(parseRetryAfter("0.5", now), 500);
  assert.equal(parseRetryAfter("Thu, 19 Nov 2026 10:00:30 GMT", now), 30_000);
  assert.equal(parseRetryAfter("Thu, 19 Nov 2026 09:00:00 GMT", now), 0);
  assert.equal(parseRetryAfter(null, now), undefined);
  assert.equal(parseRetryAfter("soon", now), undefined);
});
