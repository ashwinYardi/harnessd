import assert from "node:assert/strict";
import { test } from "node:test";
import type { Issue, LinkedIssue } from "@harnessd/shared";
import type { CreateSubIssueInput } from "../linear/client.ts";
import type { PlanPart } from "./plan.ts";
import {
  extractSection,
  formatSplitComment,
  partIds,
  partMarker,
  qaSize,
  readPartMarker,
  type SplitLinear,
  splitIssue,
} from "./split.ts";

const parent: Issue = {
  id: "parent",
  key: "MET-40",
  title: "Agents show avatars",
  description:
    "## Why\nPeople tell agents apart.\nAt a glance.\n\n## Done when\n- [ ] Avatars show\n- [x] Config has avatar\n\n**Size**: M",
  priority: 2,
  state: "Ready",
  labels: ["ui", "p1", "coordinator"],
  size: "M",
  doneWhen: [
    { text: "Avatars show", checked: false },
    { text: "Config has avatar", checked: true },
  ],
  url: "https://linear.test/MET-40",
  blockedBy: [],
};

const plan: PlanPart[] = [
  { role: "backend", title: "Serve avatars", prompt: "Add avatar to the API.", size: "S" },
  { role: "frontend", title: "Show avatars", prompt: "Render them.", size: "M" },
];

/** Records creates and relations; children are what Linear already has. */
function fakeLinear(children: LinkedIssue[] = []) {
  const creates: CreateSubIssueInput[] = [];
  const relations: Array<[string, string]> = [];
  let n = 50;
  const linear: SplitLinear = {
    async listChildren() {
      return children;
    },
    async createSubIssue(_parentId, input) {
      creates.push(input);
      n++;
      return child(`MET-${n}`, input.description, input.title);
    },
    async createBlocksRelation(blocker, blocked) {
      relations.push([blocker, blocked]);
    },
  };
  return { linear, creates, relations };
}

function child(
  key: string,
  description: string,
  title = key,
  blockers: string[] = [],
): LinkedIssue {
  return {
    id: `id-${key}`,
    key,
    title,
    description,
    priority: 2,
    state: "Ready",
    labels: [],
    size: /\*\*Size\*\*: (S|M)/.exec(description)?.[1] as "S" | "M" | undefined,
    doneWhen: [],
    url: `https://linear.test/${key}`,
    blockedBy: [],
    parentId: "parent",
    parentKey: "MET-40",
    blockers: blockers.map((b) => ({ id: `id-${b}`, key: b, state: "Ready" })),
  };
}

test("markers round-trip and number repeated roles", () => {
  assert.equal(partMarker("backend-2"), "harnessd part: backend-2");
  assert.deepEqual(readPartMarker("x\nharnessd part: backend-2\n"), {
    id: "backend-2",
    role: "backend",
  });
  assert.deepEqual(readPartMarker("harnessd part: qa"), { id: "qa", role: "qa" });
  assert.equal(readPartMarker("harnessd part: design"), undefined);
  assert.equal(readPartMarker("no marker"), undefined);
  assert.deepEqual(partIds([plan[0], plan[1], plan[0], plan[0]] as PlanPart[]), [
    "backend",
    "frontend",
    "backend-2",
    "backend-3",
  ]);
});

test("extractSection reads bold and heading sections up to the next one", () => {
  assert.equal(
    extractSection(parent.description, "Why"),
    "People tell agents apart.\nAt a glance.",
  );
  assert.equal(extractSection("**Why**\nBecause.\n**Size**: S", "why"), "Because.");
  assert.equal(extractSection("nothing here", "Why"), "");
});

test("qaSize is S for an S parent and M otherwise", () => {
  assert.equal(qaSize({ ...parent, size: "S" }), "S");
  assert.equal(qaSize(parent), "M");
  assert.equal(qaSize({ ...parent, size: "L" }), "M");
  assert.equal(qaSize({ ...parent, size: undefined }), "M");
});

test("splitIssue creates the parts and a QA sub-issue that every part blocks", async () => {
  const { linear, creates, relations } = fakeLinear();
  const result = await splitIssue(parent, plan, linear);

  assert.deepEqual(result.created, ["MET-51", "MET-52", "MET-53"]);
  assert.equal(result.related, 3);
  assert.deepEqual(relations, [
    ["id-MET-51", "id-MET-53"],
    ["id-MET-52", "id-MET-53"],
    ["id-MET-51", "id-MET-52"],
  ]);
  assert.deepEqual(
    creates.map((c) => [c.title, c.state, c.labels]),
    [
      ["Serve avatars", "Ready", ["ui", "coordinator"]],
      ["Show avatars", "Ready", ["ui", "coordinator"]],
      ["QA: Agents show avatars", "Ready", ["ui", "coordinator"]],
    ],
  );
  const [backend, , qa] = creates as [
    CreateSubIssueInput,
    CreateSubIssueInput,
    CreateSubIssueInput,
  ];
  assert.ok(backend.description.startsWith("harnessd part: backend\n"));
  for (const text of [
    "Part of [MET-40](https://linear.test/MET-40): Agents show avatars. Role: backend.",
    "**Why**\nPeople tell agents apart.\nAt a glance.",
    "**Done when**\n- [ ] Avatars show\n- [ ] Config has avatar",
    "**Size**: S",
    "**Brief**\nAdd avatar to the API.",
  ]) {
    assert.ok(backend.description.includes(text), text);
  }
  assert.ok(qa.description.startsWith("harnessd part: qa\n"));
  assert.ok(qa.description.includes("Blocked by MET-51, MET-52."));
  assert.ok(qa.description.includes("- [ ] Avatars show (verified)"));
  assert.ok(qa.description.includes("**Size**: M"));

  assert.equal(
    formatSplitComment(result, "model", "The UI needs the API first."),
    "**Coordinator split**: 3 sub-issues.\n\n" +
      "- MET-51 backend (S): Serve avatars\n" +
      "- MET-52 frontend (M): Show avatars\n" +
      "- MET-53 qa (M): blocked by MET-51, MET-52\n" +
      "\nReason for more than one part: The UI needs the API first.\n",
  );
});

test("splitIssue reuses children by marker and only adds what is missing", async () => {
  const backend = child("MET-41", `${partMarker("backend")}\n**Size**: S`);
  const qa = child("MET-42", `${partMarker("qa")}\n**Size**: M`, "QA", ["MET-41"]);
  const { linear, creates, relations } = fakeLinear([backend, qa]);

  const result = await splitIssue(parent, plan, linear);
  assert.deepEqual(result.created, ["MET-51"]);
  assert.deepEqual(
    creates.map((c) => c.title),
    ["Show avatars"],
  );
  assert.deepEqual(
    relations,
    [
      ["id-MET-51", "id-MET-42"],
      ["id-MET-41", "id-MET-51"],
    ],
    "MET-41 already blocks QA; the new part is serial after it",
  );
  assert.equal(result.qa.key, "MET-42");

  const again = fakeLinear([backend, qa, child("MET-51", `${partMarker("frontend")}`, "x", [])]);
  const second = await splitIssue(parent, [], again.linear);
  assert.deepEqual(second.created, []);
  assert.deepEqual(
    second.parts.map((p) => p.key),
    ["MET-41", "MET-51"],
  );
  assert.deepEqual(again.relations, [
    ["id-MET-51", "id-MET-42"],
    ["id-MET-41", "id-MET-51"],
  ]);
});

test("splitIssue refuses an empty plan when nothing exists yet", async () => {
  await assert.rejects(splitIssue(parent, [], fakeLinear().linear), /nothing to split/);
});

test("the fallback split comment says so", async () => {
  const result = await splitIssue(parent, [plan[0] as PlanPart], fakeLinear().linear);
  assert.match(formatSplitComment(result, "fallback"), /one-part fallback/);
});
