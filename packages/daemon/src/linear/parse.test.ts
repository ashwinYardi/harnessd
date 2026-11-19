import assert from "node:assert/strict";
import { test } from "node:test";
import { compareByPriority, parseDoneWhen, parseIssue, parseSize, type RawIssue } from "./parse.ts";

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

test("parseIssue maps a raw node and tolerates nulls", () => {
  const raw: RawIssue = {
    id: "u1",
    identifier: "MET-1",
    title: "T",
    description: null,
    priority: 7,
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
  assert.equal("milestone" in issue, false);
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
