import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { SecretReader } from "@harnessd/shared";
import { Agent } from "undici";
import {
  LINEAR_ENDPOINT,
  LinearClient,
  LinearError,
  MISSING_KEY_MESSAGE,
  parseRetryAfter,
  readyFilter,
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

function secrets(value: string | undefined): SecretReader & { reads: string[] } {
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

test("listReady pages through Ready issues, drops blocked ones and follows Linear's order", async () => {
  const { linear, sent, source } = client([
    { fixture: "ready-page-1" },
    { fixture: "ready-page-2" },
  ]);
  const issues = await linear.listReady({ teamId: TEAM_ID, projectId: "proj-1" });

  assert.deepEqual(
    issues.map((i) => i.key),
    ["MET-14", "MET-17", "MET-16", "MET-12", "MET-18"],
    "sortOrder wins over creation order and priority",
  );
  assert.equal(
    issues.some((i) => i.key === "MET-15"),
    false,
    "MET-15 is blocked by MET-13",
  );

  assert.deepEqual(source.reads, ["linear-api-key", "linear-api-key"], "read once per request");
  assert.equal(sent.length, 2);
  for (const req of sent) {
    assert.equal(req.url, LINEAR_ENDPOINT);
    assert.equal(req.headers.Authorization, KEY, "personal keys carry no Bearer prefix");
    assert.equal(req.headers["Content-Type"], "application/json");
    assert.match(req.query, /query ReadyIssues\(/);
    assert.match(req.query, /inverseRelations \{ nodes \{ type issue \{ identifier state \{ type/);
    assert.match(req.query, /sortOrder/, "the queue order needs sortOrder");
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

test("listReady takes a newer low sortOrder first and breaks a tie by priority", async () => {
  const node = (n: number, extra: Record<string, unknown>) => ({
    id: `queue-${n}`,
    identifier: `MET-${n}`,
    title: `Queue ${n}`,
    description: null,
    priority: 2,
    url: `https://linear.app/meta-harness/issue/met-${n}`,
    createdAt: "2026-11-01T00:00:00.000Z",
    state: { name: "Ready" },
    team: { id: TEAM_ID, key: "MET" },
    labels: { nodes: [] },
    inverseRelations: { nodes: [] },
    ...extra,
  });
  const { linear } = client([
    {
      body: page([
        node(60, { sortOrder: 3, priority: 1, createdAt: "2026-11-05T00:00:00.000Z" }),
        node(61, { sortOrder: 1, priority: 4, createdAt: "2026-10-01T00:00:00.000Z" }),
        node(62, { sortOrder: 2, priority: 4, createdAt: "2026-09-01T00:00:00.000Z" }),
        node(63, { sortOrder: 2, priority: 2, createdAt: "2026-11-04T00:00:00.000Z" }),
        node(64, { priority: 1, createdAt: "2026-08-01T00:00:00.000Z" }),
      ]),
    },
  ]);
  const issues = await linear.listReady({ teamId: TEAM_ID });
  assert.deepEqual(
    issues.map((i) => i.key),
    ["MET-61", "MET-63", "MET-62", "MET-60", "MET-64"],
    "no sortOrder sorts last even when urgent and old",
  );
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
    sortOrder: 4,
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

function rawChild(n: number, extra: Record<string, unknown> = {}) {
  return {
    id: `child-${n}`,
    identifier: `MET-${n}`,
    title: `Child ${n}`,
    description: `harnessd part: backend\n**Size**: S`,
    priority: 2,
    url: `https://linear.app/meta-harness/issue/met-${n}`,
    createdAt: `2026-11-0${n % 9}T09:00:00.000Z`,
    state: { name: "Ready" },
    team: { id: TEAM_ID, key: "MET" },
    labels: { nodes: [] },
    parent: { id: MET12_ID, identifier: "MET-12" },
    inverseRelations: { nodes: [] },
    ...extra,
  };
}

const page = (nodes: unknown[]) => ({
  data: { issues: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } },
});

test("readyFilter takes a team key or UUID and a project id or name", () => {
  assert.deepEqual(readyFilter({ teamId: "MET", projectName: "harnessd" }), {
    team: { key: { eqIgnoreCase: "MET" } },
    state: { name: { eqIgnoreCase: "Ready" } },
    project: { name: { eqIgnoreCase: "harnessd" } },
  });
  assert.deepEqual(readyFilter({ teamId: TEAM_ID, projectId: "p", projectName: "ignored" }), {
    team: { id: { eq: TEAM_ID } },
    state: { name: { eqIgnoreCase: "Ready" } },
    project: { id: { eq: "p" } },
  });
});

test("listReadyContaining filters on the description and keeps blocked issues with their blockers", async () => {
  const blocked = rawChild(31, {
    priority: 1,
    inverseRelations: {
      nodes: [
        {
          type: "blocks",
          issue: {
            id: "child-30",
            identifier: "MET-30",
            state: { type: "started", name: "In Progress" },
          },
        },
      ],
    },
  });
  const { linear, sent } = client([{ body: page([rawChild(30, { priority: 3 }), blocked]) }]);
  const issues = await linear.listReadyContaining({ teamId: "MET" }, "harnessd part: ");
  assert.deepEqual(
    issues.map((i) => i.key),
    ["MET-31", "MET-30"],
  );
  assert.deepEqual(issues[0]?.blockers, [{ id: "child-30", key: "MET-30", state: "In Progress" }]);
  assert.deepEqual(issues[0]?.blockedBy, ["MET-30"]);
  assert.equal(issues[0]?.parentId, MET12_ID);
  assert.equal(issues[0]?.parentKey, "MET-12");
  assert.match(sent[0]?.query ?? "", /query ReadyIssuesContaining\(/);
  assert.match(sent[0]?.query ?? "", /parent \{ id identifier \}/);
  assert.deepEqual(sent[0]?.variables.filter, {
    team: { key: { eqIgnoreCase: "MET" } },
    state: { name: { eqIgnoreCase: "Ready" } },
    description: { contains: "harnessd part: " },
  });
});

test("listChildren returns sub-issues in creation order", async () => {
  const { linear, sent } = client([
    {
      body: {
        data: { issue: { id: MET12_ID, children: { nodes: [rawChild(42), rawChild(41)] } } },
      },
    },
  ]);
  const children = await linear.listChildren(MET12_ID);
  assert.deepEqual(
    children.map((c) => c.key),
    ["MET-41", "MET-42"],
  );
  assert.match(sent[0]?.query ?? "", /query IssueChildren\(\$id: String!\)/);
  assert.deepEqual(sent[0]?.variables, { id: MET12_ID });
});

test("listChildren fails clearly for a missing parent", async () => {
  const { linear } = client([{ body: { data: { issue: null } } }]);
  await assert.rejects(linear.listChildren("nope"), { name: "LinearError", code: "not_found" });
});

const PARENT_META = {
  data: {
    issue: {
      id: MET12_ID,
      team: { id: TEAM_ID },
      project: { id: "proj-1" },
      labels: {
        nodes: [
          { id: "label-coord", name: "coordinator" },
          { id: "label-p1", name: "p1" },
        ],
      },
    },
  },
};

test("createSubIssue creates a child in the parent's team and project with its labels", async () => {
  const { linear, sent, remaining } = client([
    { body: PARENT_META },
    { fixture: "team-states" },
    { body: { data: { issueCreate: { success: true, issue: rawChild(50) } } } },
  ]);
  const child = await linear.createSubIssue(MET12_ID, {
    title: "Child 50",
    description: "body",
    state: "Ready",
    labels: ["coordinator"],
  });
  assert.equal(remaining(), 0);
  assert.equal(child.key, "MET-50");
  assert.equal(child.parentKey, "MET-12");
  assert.deepEqual(
    sent.map((r) => /^(?:query|mutation) (\w+)/.exec(r.query)?.[1]),
    ["IssueParentMeta", "TeamStates", "IssueCreate"],
  );
  assert.deepEqual(sent[2]?.variables, {
    input: {
      teamId: TEAM_ID,
      parentId: MET12_ID,
      title: "Child 50",
      description: "body",
      stateId: "0c7e1b2a-3d4f-4e5a-9b6c-000000000002",
      projectId: "proj-1",
      labelIds: ["label-coord"],
    },
  });
});

test("createSubIssue refuses a label the parent does not carry", async () => {
  const { linear, sent } = client([{ body: PARENT_META }]);
  await assert.rejects(
    linear.createSubIssue(MET12_ID, {
      title: "t",
      description: "d",
      state: "Ready",
      labels: ["ui"],
    }),
    { name: "LinearError", code: "not_found", message: /has no label "ui"/ },
  );
  assert.equal(sent.length, 1);
});

test("createBlocksRelation posts a blocks relation from blocker to blocked", async () => {
  const { linear, sent } = client([{ body: { data: { issueRelationCreate: { success: true } } } }]);
  await linear.createBlocksRelation("child-41", "child-43");
  assert.match(sent[0]?.query ?? "", /mutation IssueRelationCreate\(/);
  assert.deepEqual(sent[0]?.variables, {
    input: { issueId: "child-41", relatedIssueId: "child-43", type: "blocks" },
  });
});

test("createBlocksRelation fails when Linear reports no success", async () => {
  const { linear } = client([{ body: { data: { issueRelationCreate: { success: false } } } }]);
  await assert.rejects(linear.createBlocksRelation("a", "b"), { code: "graphql" });
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

test("updateDescription sends the description in an issueUpdate mutation", async () => {
  const { linear, sent } = client([{ fixture: "issue-update" }]);
  const description = "**Goal**\n\n**Done when**\n- [ ] One";
  await linear.updateDescription(MET12_ID, description);

  assert.match(
    sent[0]?.query ?? "",
    /mutation IssueUpdate\(\$id: String!, \$input: IssueUpdateInput!\)/,
  );
  assert.deepEqual(sent[0]?.variables, { id: MET12_ID, input: { description } });
});

test("updateDescription fails clearly when Linear does not update the issue", async () => {
  const { linear } = client([{ body: { data: { issueUpdate: { success: false, issue: null } } } }]);
  await assert.rejects(linear.updateDescription(MET12_ID, "new body"), (error: unknown) => {
    assert.ok(error instanceof LinearError);
    assert.equal(error.code, "graphql");
    assert.match(error.message, /did not update the description/);
    return true;
  });
});

test("a missing API key fails before any request", async () => {
  for (const apiKey of [secrets(undefined), secrets("  "), async () => undefined]) {
    const fake = replay([]);
    const linear = new LinearClient({ apiKey, fetch: fake.fetch });
    await assert.rejects(linear.listReady({ teamId: TEAM_ID }), {
      name: "LinearError",
      code: "missing_key",
      message:
        "Linear API key not set. Paste it in Settings, Connections, Linear, or set LINEAR_API_KEY.",
    });
    assert.equal(fake.sent.length, 0);
  }
  assert.equal(
    MISSING_KEY_MESSAGE,
    "Linear API key not set. Paste it in Settings, Connections, Linear, or set LINEAR_API_KEY.",
  );
});

test("the key is read on each request, so a replaced or removed key applies at once", async () => {
  const fake = replay([{ fixture: "comment-create" }, { fixture: "comment-create" }]);
  let key: string | undefined = "lin_api_first";
  const linear = new LinearClient({ apiKey: async () => key, fetch: fake.fetch });
  await linear.comment(MET12_ID, "a");
  key = "lin_api_second";
  await linear.comment(MET12_ID, "b");
  key = undefined;
  await assert.rejects(linear.comment(MET12_ID, "c"), { code: "missing_key" });
  assert.deepEqual(
    fake.sent.map((r) => r.headers.Authorization),
    ["lin_api_first", "lin_api_second"],
  );
});

test("a function key source is accepted", async () => {
  const fake = replay([{ fixture: "comment-create" }]);
  const linear = new LinearClient({ apiKey: async () => "lin_api_fn", fetch: fake.fetch });
  await linear.comment(MET12_ID, "hi");
  assert.equal(fake.sent[0]?.headers.Authorization, "lin_api_fn");
});

test("HTTP 401 and Linear auth errors map to an auth LinearError", async () => {
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
  assert.equal(source.reads.length, 3, "the key is read on each request");
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

test("each request carries a timeout signal that maps an abort to a network error", async () => {
  let signal: AbortSignal | undefined;
  const linear = new LinearClient({
    apiKey: async () => KEY,
    fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    }) as typeof fetch,
  });
  await assert.rejects(linear.comment(MET12_ID, "x"), {
    code: "network",
    message: "Linear request timed out",
  });
  assert.ok(signal instanceof AbortSignal, "the fetch got an AbortSignal");
});

test("a request that outlives timeoutMs is aborted and maps to a network timeout", async () => {
  let aborted = false;
  const linear = new LinearClient({
    apiKey: async () => KEY,
    timeoutMs: 10,
    fetch: ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(init.signal?.reason ?? new DOMException("aborted", "AbortError"));
        });
      })) as typeof fetch,
  });
  await assert.rejects(linear.comment(MET12_ID, "x"), {
    code: "network",
    message: "Linear request timed out",
  });
  assert.equal(aborted, true);
});

test("a network error replaces the connection pool before the next request", async () => {
  const dispatchers: unknown[] = [];
  const seen: unknown[] = [];
  const replies = [
    () => {
      throw new TypeError("fetch failed");
    },
    () =>
      new Response(JSON.stringify(fixture("comment-create")), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  ];
  const linear = new LinearClient({
    apiKey: async () => KEY,
    newDispatcher: () => {
      const agent = new Agent();
      dispatchers.push(agent);
      return agent;
    },
    fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
      seen.push(init?.dispatcher);
      const reply = replies.shift();
      if (!reply) throw new Error("unexpected request");
      return reply();
    }) as typeof fetch,
  });

  await assert.rejects(linear.comment(MET12_ID, "x"), { code: "network" });
  assert.equal(dispatchers.length, 2, "the client built a fresh pool after the network error");

  await linear.comment(MET12_ID, "x");
  assert.equal(dispatchers.length, 2, "a success reuses the pool");
  assert.equal(seen[0], dispatchers[0], "the first request used the initial pool");
  assert.equal(seen[1], dispatchers[1], "the retry used the fresh pool");
});

test("an HTTP 5xx answer also replaces the connection pool", async () => {
  let dispatchers = 0;
  const linear = new LinearClient({
    apiKey: async () => KEY,
    newDispatcher: () => {
      dispatchers++;
      return new Agent();
    },
    fetch: (async () => new Response("upstream down", { status: 502 })) as typeof fetch,
  });
  await assert.rejects(linear.comment(MET12_ID, "x"), { code: "http", status: 502 });
  assert.equal(dispatchers, 2, "a 5xx is network-class and resets the pool");
});

test("an auth error keeps the connection pool", async () => {
  let dispatchers = 0;
  const linear = new LinearClient({
    apiKey: async () => KEY,
    newDispatcher: () => {
      dispatchers++;
      return new Agent();
    },
    fetch: (async () =>
      new Response(JSON.stringify({ errors: [{ message: "Unauthorized" }] }), {
        status: 401,
        headers: { "content-type": "application/json" },
      })) as typeof fetch,
  });
  await assert.rejects(linear.comment(MET12_ID, "x"), { code: "auth" });
  assert.equal(dispatchers, 1, "an auth error is not network-class");
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

const boardNode = (fields: Record<string, unknown>) => ({
  id: `id-${fields.identifier}`,
  title: "Work",
  description: "**Size**: S",
  priority: 3,
  url: `https://linear.app/met/issue/${fields.identifier}`,
  createdAt: "2026-11-01T10:00:00.000Z",
  updatedAt: "2026-11-20T09:00:00.000Z",
  state: { name: "Ready" },
  team: { id: TEAM_ID, key: "MET" },
  labels: { nodes: [{ name: "ui" }] },
  projectMilestone: null,
  parent: null,
  inverseRelations: { nodes: [] },
  ...fields,
});

test("listBoard reads open issues and recent Done ones, sorted by priority then key", async () => {
  const { linear, sent } = client([
    {
      body: {
        data: {
          issues: {
            nodes: [
              boardNode({ identifier: "MET-9", priority: 0 }),
              boardNode({
                identifier: "MET-41",
                priority: 2,
                state: { name: "In Progress" },
                parent: { id: "id-MET-40", identifier: "MET-40" },
                inverseRelations: {
                  nodes: [
                    {
                      type: "blocks",
                      issue: { id: "b", identifier: "MET-39", state: { type: "started" } },
                    },
                  ],
                },
              }),
              boardNode({ identifier: "MET-12", priority: 2, description: "" }),
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    },
  ]);
  const issues = await linear.listBoard({ teamId: "MET", projectName: "harnessd" });
  assert.deepEqual(
    issues.map((i) => i.key),
    ["MET-12", "MET-41", "MET-9"],
    "no priority sorts last; keys sort by number",
  );
  assert.deepEqual(issues[1], {
    id: "id-MET-41",
    key: "MET-41",
    title: "Work",
    state: "In Progress",
    priority: 2,
    labels: ["ui"],
    size: "S",
    url: "https://linear.app/met/issue/MET-41",
    parentKey: "MET-40",
    blockedBy: ["MET-39"],
    updatedAt: "2026-11-20T09:00:00.000Z",
  });
  assert.equal(issues[0]?.size, undefined);
  assert.match(sent[0]?.query ?? "", /query BoardIssues\(/);
  assert.match(sent[0]?.query ?? "", /updatedAt/);
  assert.deepEqual(sent[0]?.variables.filter, {
    team: { key: { eqIgnoreCase: "MET" } },
    project: { name: { eqIgnoreCase: "harnessd" } },
    state: { type: { neq: "canceled" } },
    or: [{ state: { type: { neq: "completed" } } }, { completedAt: { gt: "-P7D" } }],
  });
});
