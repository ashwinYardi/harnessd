import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compareByPriority,
  compareQueueOrder,
  parseDoneWhen,
  parseIssue,
  parseSize,
  type RawIssue,
  replaceDoneWhen,
} from "./parse.ts";

test("parseSize reads the Size line in its common spellings", () => {
  assert.equal(parseSize("**Why**\nx\n\n**Size**: S"), "S");
  assert.equal(parseSize("**Size:** M"), "M");
  assert.equal(parseSize("- Size: L (split it)"), "L");
  assert.equal(parseSize("size: m"), "M");
  assert.equal(parseSize("**Size**: Small"), undefined);
  assert.equal(parseSize("no size here"), undefined);
});

test("parseDoneWhen collects the checklist up to the next section", () => {
  const body = [
    "**Why**",
    "- [ ] not part of done when",
    "",
    "## Done when",
    "Every item below:",
    "- [ ] Lists Ready issues",
    "- [x] Moves states  ",
    "* [X] Posts comments",
    "",
    "**Spec links**",
    "- [ ] after the section",
  ].join("\n");
  assert.deepEqual(parseDoneWhen(body), [
    { text: "Lists Ready issues", checked: false },
    { text: "Moves states", checked: true },
    { text: "Posts comments", checked: true },
  ]);
  assert.deepEqual(parseDoneWhen("**Done when:**\r\n- [ ] CRLF works\r\n"), [
    { text: "CRLF works", checked: false },
  ]);
  assert.deepEqual(parseDoneWhen("no checklist"), []);
});

test("replaceDoneWhen rewrites only the first Done when checklist", () => {
  const body = [
    "**Why**",
    "The old list was too long.",
    "",
    "## Done when",
    "Every item below:",
    "- [ ] Lists Ready issues",
    "- [x] Moves states",
    "",
    "**Spec links**",
    "- [ ] keep this after the section",
    "",
    "## Done when",
    "- [ ] a second section stays untouched",
  ].join("\n");
  const items = ["Lists Ready issues and moves states", "Posts comments", "Passes the tests"];
  const result = replaceDoneWhen(body, items);

  assert.equal(
    result,
    [
      "**Why**",
      "The old list was too long.",
      "",
      "## Done when",
      "Every item below:",
      "- [ ] Lists Ready issues and moves states",
      "- [ ] Posts comments",
      "- [ ] Passes the tests",
      "",
      "**Spec links**",
      "- [ ] keep this after the section",
      "",
      "## Done when",
      "- [ ] a second section stays untouched",
    ].join("\n"),
  );
  assert.deepEqual(
    parseDoneWhen(result),
    items.map((text) => ({ text, checked: false })),
  );
  assert.deepEqual(parseDoneWhen(body).length, 2, "the original body is not mutated");
});

test("replaceDoneWhen keeps CRLF line endings", () => {
  const body = "**Goal**\r\n\r\n**Done when:**\r\n- [ ] old\r\n\r\n**Verify**\r\npnpm test";
  assert.equal(
    replaceDoneWhen(body, ["new one", "new two"]),
    "**Goal**\r\n\r\n**Done when:**\r\n- [ ] new one\r\n- [ ] new two\r\n\r\n**Verify**\r\npnpm test",
  );
});

test("replaceDoneWhen adds items when the section has no checklist yet", () => {
  const body = "**Done when**\nNo list yet.\n\n**Verify**\nrun it";
  assert.equal(
    replaceDoneWhen(body, ["one"]),
    "**Done when**\nNo list yet.\n- [ ] one\n\n**Verify**\nrun it",
  );
});

test("replaceDoneWhen round-trips items and cannot hide later ones", () => {
  const body = [
    "**Goal**",
    "Ship the parser.",
    "",
    "**Done when**",
    "- [ ] an old item",
    "",
    "**Verify**",
    "pnpm test",
  ].join("\n");
  const items = ["# Starts with a heading", "Keeps  inner  spacing", "Covers A, B"];
  const result = replaceDoneWhen(body, items);

  assert.deepEqual(
    parseDoneWhen(result),
    items.map((text) => ({ text, checked: false })),
    "a heading-like first line stays an item and every later item is read",
  );
  assert.ok(result.includes("**Goal**\nShip the parser."), "text before the section stays");
  assert.ok(result.includes("**Verify**\npnpm test"), "every later section stays");

  assert.throws(() => replaceDoneWhen(body, ["One\n# Hidden"]), /item 0 must be one line/);
  assert.throws(() => replaceDoneWhen(body, ["One\r\nTwo"]), /item 0 must be one line/);
  for (const separator of ["\u2028", "\u2029"]) {
    assert.throws(
      () => replaceDoneWhen(body, [`One${separator}Two`]),
      /item 0 must be one line/,
      "U+2028 and U+2029 are line breaks to the checklist regex too",
    );
  }
  assert.throws(() => replaceDoneWhen(body, ["  "]), /item 0 must be a non-empty string/);
});

test("parseIssue maps a raw node and tolerates nulls", () => {
  const raw: RawIssue = {
    id: "u1",
    identifier: "MET-1",
    title: "T",
    description: null,
    priority: 7,
    sortOrder: 7.5,
    url: "https://linear.app/x/issue/met-1",
    createdAt: "2026-11-01T00:00:00.000Z",
    state: { name: "Ready" },
    labels: null,
    projectMilestone: null,
    inverseRelations: {
      nodes: [
        { type: "blocks", issue: { identifier: "MET-2", state: { type: "unstarted" } } },
        { type: "blocks", issue: { identifier: "MET-3", state: { type: "completed" } } },
        { type: "duplicate", issue: { identifier: "MET-4", state: { type: "started" } } },
      ],
    },
  };
  const issue = parseIssue(raw);
  assert.equal(issue.description, "");
  assert.equal(issue.priority, 0);
  assert.deepEqual(issue.labels, []);
  assert.equal(issue.size, undefined);
  assert.deepEqual(issue.blockedBy, ["MET-2"]);
  assert.equal(issue.sortOrder, 7.5);
  assert.equal("milestone" in issue, false);
});

test("parseIssue leaves sortOrder undefined when Linear sends none", () => {
  const issue = parseIssue({
    id: "u2",
    identifier: "MET-2",
    title: "T",
    url: "https://linear.app/x/issue/met-2",
    createdAt: "2026-11-01T00:00:00.000Z",
  });
  assert.equal(issue.sortOrder, undefined);
});

test("compareByPriority puts urgent first, none last, then oldest", () => {
  const items = [
    { k: "none", priority: 0 as const, createdAt: "2026-01-01T00:00:00Z" },
    { k: "low", priority: 4 as const, createdAt: "2026-01-01T00:00:00Z" },
    { k: "high-new", priority: 2 as const, createdAt: "2026-03-01T00:00:00Z" },
    { k: "high-old", priority: 2 as const, createdAt: "2026-02-01T00:00:00Z" },
    { k: "urgent", priority: 1 as const, createdAt: "2026-04-01T00:00:00Z" },
  ];
  assert.deepEqual(
    items.sort(compareByPriority).map((i) => i.k),
    ["urgent", "high-old", "high-new", "low", "none"],
  );
});

test("compareQueueOrder follows sortOrder, then priority, oldest, key number", () => {
  const items = [
    { k: "no-order", priority: 1 as const, createdAt: "2026-01-01T00:00:00Z", key: "MET-90" },
    {
      k: "later",
      priority: 4 as const,
      createdAt: "2026-01-01T00:00:00Z",
      key: "MET-91",
      sortOrder: 2,
    },
    {
      k: "first-newer",
      priority: 4 as const,
      createdAt: "2026-05-01T00:00:00Z",
      key: "MET-92",
      sortOrder: 1,
    },
    {
      k: "tie-none",
      priority: 0 as const,
      createdAt: "2026-01-01T00:00:00Z",
      key: "MET-93",
      sortOrder: 3,
    },
    {
      k: "tie-high-old",
      priority: 2 as const,
      createdAt: "2026-02-01T00:00:00Z",
      key: "MET-94",
      sortOrder: 3,
    },
    {
      k: "tie-high-new",
      priority: 2 as const,
      createdAt: "2026-04-01T00:00:00Z",
      key: "MET-95",
      sortOrder: 3,
    },
    {
      k: "tie-high-key-2",
      priority: 2 as const,
      createdAt: "2026-04-01T00:00:00Z",
      key: "MET-2",
      sortOrder: 3,
    },
  ];
  assert.deepEqual(
    items.sort(compareQueueOrder).map((i) => i.k),
    [
      "first-newer",
      "later",
      "tie-high-old",
      "tie-high-key-2",
      "tie-high-new",
      "tie-none",
      "no-order",
    ],
    "no sortOrder sorts last; priority breaks a sortOrder tie before age",
  );
});
