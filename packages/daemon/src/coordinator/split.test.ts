import assert from "node:assert/strict";
import { test } from "node:test";
import type { Issue, LinkedIssue } from "@harnessd/shared";
import type { CreateSubIssueInput } from "../linear/client.ts";
import type { PlanPart } from "./plan.ts";
import {
  extractSection,
  formatPartDescription,
  formatSplitComment,
  NO_LIVE_QA_NOTE,
  noLiveQaWarning,
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
  {
    role: "backend",
    title: "Serve avatars",
    size: "S",
    goal: "Serve the avatar field from the API.",
    doneWhen: [1],
    files: ["packages/daemon/src/api.ts"],
    steps: ["Add the avatar field.", "Return it in the issue payload."],
    verify: [{ run: "pnpm test", expect: "the API tests pass" }],
    outOfScope: "The board UI.",
  },
  {
    role: "frontend",
    title: "Show avatars",
    size: "M",
    goal: "Render the avatar on each agent card.",
    doneWhen: [2],
    files: ["packages/ui/src/board.tsx"],
    steps: ["Render the avatar."],
    verify: [{ run: "pnpm test", expect: "the UI tests pass" }],
    outOfScope: "The API field.",
  },
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
    "**Goal**\nServe the avatar field from the API.",
    "**Done when**\n- [ ] Avatars show",
    "**Files**\n- packages/daemon/src/api.ts",
    "**Steps**\n1. Add the avatar field.\n2. Return it in the issue payload.",
    "**Verify**\n- `pnpm test` → the API tests pass",
    "**Out of scope**\nThe board UI.",
    "**Why**\nPeople tell agents apart.\nAt a glance.",
    "**Spec links**\n- MET-40: https://linear.test/MET-40",
    "**Size**: S",
  ]) {
    assert.ok(backend.description.includes(text), text);
  }
  assert.doesNotMatch(backend.description, /\*\*Brief\*\*/);
  assert.doesNotMatch(
    backend.description,
    /Config has avatar/,
    "the part lists only the parent items it covers",
  );
  const order = [
    "**Goal**",
    "**Done when**",
    "**Files**",
    "**Steps**",
    "**Verify**",
    "**QA**",
    "**Out of scope**",
    "**Why**",
    "**Spec links**",
    "**Size**",
  ].map((section) => backend.description.indexOf(section));
  assert.deepEqual(
    order,
    [...order].sort((a, b) => a - b),
    backend.description,
  );

  assert.ok(qa.description.startsWith("harnessd part: qa\n"));
  assert.ok(qa.description.includes("Blocked by MET-51, MET-52."));
  assert.ok(qa.description.includes("- [ ] Avatars show (verified)"));
  assert.ok(
    qa.description.indexOf("- [ ] Avatars show") <
      qa.description.indexOf("- [ ] Config has avatar"),
  );
  assert.ok(qa.description.includes("**Size**: M"));

  assert.equal(
    formatSplitComment(result, "The UI needs the API first."),
    "**Coordinator split**: 3 sub-issues.\n\n" +
      "- MET-51 backend (S): Serve the avatar field from the API.\n" +
      "  Files: packages/daemon/src/api.ts\n" +
      "- MET-52 frontend (M): Render the avatar on each agent card.\n" +
      "  Files: packages/ui/src/board.tsx\n" +
      "- MET-53 qa (M): blocked by MET-51, MET-52\n" +
      "\nReason: The UI needs the API first.\n",
  );
});

test("a one-part split note lists its goal and files and ends with the reason (MET-162)", () => {
  const one = child("MET-51", formatPartDescription(parent, plan[0] as PlanPart, "backend"));
  const note = formatSplitComment(
    { parts: [one], qa: child("MET-53", `${partMarker("qa")}`, "QA"), created: [], related: 0 },
    "One area fits one part.",
  );
  assert.ok(
    note.includes(
      "- MET-51 backend (S): Serve the avatar field from the API.\n  Files: packages/daemon/src/api.ts",
    ),
    note,
  );
  assert.ok(note.endsWith("\nReason: One area fits one part.\n"), note);
  assert.ok(!note.includes("Reason for more than one part"), note);
});

test("the split note warns once that the repo runs no live app (MET-180)", () => {
  const one = child("MET-51", formatPartDescription(parent, plan[0] as PlanPart, "backend"));
  const result = {
    parts: [one],
    qa: child("MET-53", partMarker("qa"), "QA"),
    created: [],
    related: 0,
  };
  const first = noLiveQaWarning({}, undefined, "2026-11-24T10:00:00.000Z");
  assert.deepEqual(first, {
    line: NO_LIVE_QA_NOTE,
    warnedAt: "2026-11-24T10:00:00.000Z",
  });
  const note = formatSplitComment(result, "One area fits one part.", first?.line);
  assert.ok(note.includes(`${NO_LIVE_QA_NOTE}\nReason: One area fits one part.\n`), note);

  // The warning is once per repo: the recorded time, or a set kind, drops it.
  assert.equal(noLiveQaWarning({}, first?.warnedAt, "2026-11-24T11:00:00.000Z"), undefined);
  assert.equal(noLiveQaWarning({ kind: "web" }, undefined, "2026-11-24T11:00:00.000Z"), undefined);
  assert.ok(
    !formatSplitComment(result, "One area fits one part.").includes(NO_LIVE_QA_NOTE),
    "a note without the warning leaves it out",
  );
});

test("parts that share a file are chained, and the backend part blocks the frontend part (MET-161)", async () => {
  const shared = "docs/LOOP.md";
  const parts: PlanPart[] = [
    { ...(plan[0] as PlanPart), files: ["packages/daemon/src/api.ts", shared] },
    { ...(plan[1] as PlanPart), files: ["packages/ui/app/src/board.tsx", shared] },
  ];
  const { linear, relations } = fakeLinear();
  const result = await splitIssue(parent, parts, linear);

  assert.deepEqual(
    relations,
    [
      ["id-MET-51", "id-MET-53"],
      ["id-MET-52", "id-MET-53"],
      ["id-MET-51", "id-MET-52"],
    ],
    "the backend part blocks the frontend part that lists the same file",
  );
  assert.deepEqual(
    result.parts.map((part) => part.key),
    ["MET-51", "MET-52"],
    "the backend part comes first",
  );
});

test("a part with no parsed parent item says 'as written'", () => {
  const body = formatPartDescription({ ...parent, doneWhen: [] }, plan[0] as PlanPart, "backend");
  assert.match(body, /\*\*Done when\*\*\n- \[ \] Matches MET-40 as written/);
});

test("the part body carries its QA line right after the Verify section", () => {
  const backend = plan[0] as PlanPart;
  const expected =
    "**Verify**\n- `pnpm test` → the API tests pass\n\n" +
    "**QA**: tests\n\n**Out of scope**\nThe board UI.";

  const tests = formatPartDescription(parent, { ...backend, qa: "tests" }, "backend");
  assert.ok(tests.includes(expected), tests);

  const agent = formatPartDescription(parent, { ...backend, qa: "agent" }, "backend");
  assert.ok(agent.includes("**QA**: agent"), agent);

  // A part from a plan before the field existed, or from a hand-made plan, gets agent QA.
  const missing = formatPartDescription(parent, backend, "backend");
  assert.ok(missing.includes("**QA**: agent"), missing);

  for (const body of [tests, agent, missing]) {
    assert.ok(body.indexOf("**Verify**") < body.indexOf("**QA**"), body);
    assert.ok(body.indexOf("**QA**") < body.indexOf("**Out of scope**"), body);
  }
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

test("splitIssue never reuses a canceled or done child, even when it is in the reuse set (MET-216)", async () => {
  const canceled = { ...child("MET-41", partMarker("backend")), state: "Canceled" };
  const done = { ...child("MET-42", partMarker("frontend")), state: "Done" };
  const { linear, creates, relations } = fakeLinear([canceled, done]);

  const result = await splitIssue(parent, plan, linear, [canceled, done]);

  assert.deepEqual(
    creates.map((c) => c.title),
    ["Serve avatars", "Show avatars", "QA: Agents show avatars"],
    "a closed child is not reused",
  );
  assert.deepEqual(
    result.parts.map((part) => part.key),
    ["MET-51", "MET-52"],
  );
  assert.equal(result.qa.key, "MET-53");
  assert.ok(
    result.parts.every((part) => part.id !== canceled.id && part.id !== done.id),
    "the closed children stay out of the split",
  );
  assert.deepEqual(
    relations,
    [
      ["id-MET-51", "id-MET-53"],
      ["id-MET-52", "id-MET-53"],
      ["id-MET-51", "id-MET-52"],
    ],
    "only the new parts block the new QA and each other",
  );
});

test("splitIssue does not reuse an old QA child outside the reuse set; it creates a new one (MET-216)", async () => {
  const oldQa = child("MET-42", partMarker("qa"), "QA", ["MET-41"]);
  const late = child("MET-41", partMarker("backend"));
  const { linear, creates } = fakeLinear([oldQa, late]);

  // The no-record path passes only this tick's planned children, so an old QA is not in it.
  const result = await splitIssue(parent, plan, linear, [late]);

  assert.deepEqual(
    creates.map((c) => c.title),
    ["Show avatars", "QA: Agents show avatars"],
    "only the missing part and the new QA are created",
  );
  assert.deepEqual(
    result.parts.map((part) => part.key),
    ["MET-41", "MET-51"],
    "the planned child in the reuse set is kept",
  );
  assert.equal(result.qa.key, "MET-52", "a new QA sub-issue is created");
  assert.notEqual(result.qa.id, oldQa.id, "the old QA child is left alone");
});

test("a part body lists its decision IDs and the grill calls it follows (D-044)", async () => {
  const calls = [
    { question: "Where?", answer: "daemon", basis: "SPEC" },
    { question: "How?", answer: "one part", basis: "D-040" },
  ];
  const parts: PlanPart[] = [
    {
      ...(plan[0] as PlanPart),
      decisions: [{ id: "D-014", line: "Sets the part sizes." }],
      calls: [1, "How?"],
    },
  ];
  const { linear, creates } = fakeLinear();
  await splitIssue(parent, parts, linear, undefined, calls);
  const body = creates[0]?.description ?? "";
  assert.ok(
    body.includes(
      "**Out of scope**\nThe board UI.\n\n**Decisions**\n- D-014: Sets the part sizes.\n\n" +
        "**Grill calls**\n- Where? → daemon\n- How? → one part\n\n**Why**\nPeople tell agents apart.",
    ),
    body,
  );
  assert.ok(body.indexOf("**Decisions**") < body.indexOf("**Why**"));
  assert.ok(body.indexOf("**Grill calls**") < body.indexOf("**Why**"));
});

test("splitIssue refuses an empty plan when nothing exists yet", async () => {
  await assert.rejects(splitIssue(parent, [], fakeLinear().linear), /nothing to split/);
});
