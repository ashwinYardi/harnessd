import assert from "node:assert/strict";
import { test } from "node:test";
import { pin } from "./pin.ts";

interface Run {
  key: string;
  lastAction: string;
}
const run = (key: string, lastAction = "Read"): Run => ({ key, lastAction });
const group = (id: string, ...rows: Run[]) => ({ id, rows });
const key = (r: Run) => r.key;
const keys = (groups: ReturnType<typeof pin<Run, ReturnType<typeof group>>>) =>
  groups.map((g) => `${g.id}:${g.rows.map(key).join(",")}`);

test("with no pinned row, a new snapshot shows at once", () => {
  const shown = [group("a", run("a1"), run("a2"))];
  const next = [group("a", run("a2"), run("a3"))];
  assert.deepEqual(pin(shown, next, key, []), next);
});

test("a pinned run keeps its index while a run is added above it, and its contents update", () => {
  const shown = [group("coder", run("coder/MET-1"), run("coder/MET-2"))];
  const next = [group("coder", run("coder/MET-3"), run("coder/MET-1"), run("coder/MET-2", "Edit"))];
  const out = pin(shown, next, key, ["coder/MET-2"]);
  assert.deepEqual(keys(out), ["coder:coder/MET-1,coder/MET-2,coder/MET-3"]);
  assert.equal(out[0]?.rows[1]?.lastAction, "Edit");
});

test("a pinned Board card stays in its old column at its old index after a state change", () => {
  const shown = [group("ready", run("MET-1"), run("MET-2")), group("in-progress", run("MET-3"))];
  const next = [
    group("ready", run("MET-1")),
    group("in-progress", run("MET-2", "Started"), run("MET-3")),
  ];
  const out = pin(shown, next, key, ["MET-2"]);
  assert.deepEqual(keys(out), ["ready:MET-1,MET-2", "in-progress:MET-3"]);
  assert.equal(out[0]?.rows[1]?.lastAction, "Started");
});

test("a pinned row that left the data keeps its slot and last contents until release", () => {
  const shown = [group("coder", run("coder/MET-1"), run("coder/MET-2", "Edit"))];
  const next = [group("coder", run("coder/MET-1"))];
  let out = pin(shown, next, key, ["coder/MET-2"]);
  assert.deepEqual(keys(out), ["coder:coder/MET-1,coder/MET-2"]);
  assert.equal(out[0]?.rows[1]?.lastAction, "Edit");
  out = pin(out, [group("coder", run("coder/MET-4"), run("coder/MET-1"))], key, ["coder/MET-2"]);
  assert.deepEqual(keys(out), ["coder:coder/MET-1,coder/MET-2,coder/MET-4"], "still pinned");
  assert.deepEqual(keys(pin(out, next, key, [])), ["coder:coder/MET-1"]);
});

test("release restores the true order", () => {
  const shown = [group("ready", run("MET-1"), run("MET-2")), group("done")];
  const next = [group("ready", run("MET-1")), group("done", run("MET-2"))];
  const held = pin(shown, next, key, ["MET-2"]);
  assert.deepEqual(keys(held), ["ready:MET-1,MET-2", "done:"]);
  assert.deepEqual(keys(pin(held, next, key, [])), ["ready:MET-1", "done:MET-2"]);
});

test("a pinned row whose group left the data keeps its group at its index", () => {
  const shown = [group("coder", run("coder/MET-1")), group("qa", run("qa"))];
  const next = [group("qa", run("qa"))];
  assert.deepEqual(keys(pin(shown, next, key, ["coder/MET-1"])), ["coder:coder/MET-1", "qa:qa"]);
});

test("a pinned key that is not shown changes nothing", () => {
  const next = [group("a", run("a1"))];
  assert.deepEqual(pin([group("a")], next, key, ["a9"]), next);
});

test("the row under the pointer and the focused row both keep their places", () => {
  const shown = [group("ready", run("MET-1"), run("MET-2")), group("done", run("MET-3"))];
  const next = [group("ready"), group("done", run("MET-3"), run("MET-1"), run("MET-2"))];
  assert.deepEqual(keys(pin(shown, next, key, ["MET-2", "MET-1"])), [
    "ready:MET-1,MET-2",
    "done:MET-3",
  ]);
});

test("a row under both the pointer and focus shows once", () => {
  const shown = [group("ready", run("MET-1"), run("MET-2"))];
  const next = [group("ready", run("MET-2"), run("MET-1"))];
  assert.deepEqual(keys(pin(shown, next, key, ["MET-2", "MET-2"])), ["ready:MET-1,MET-2"]);
});

test("a pinned card keeps its index when the cards above it leave its column", () => {
  const shown = [group("ready", run("MET-1"), run("MET-2"), run("MET-3")), group("done")];
  const next = [group("ready", run("MET-3", "Edit")), group("done", run("MET-1"), run("MET-2"))];
  const out = pin(shown, next, key, ["MET-3"]);
  assert.deepEqual(keys(out), ["ready:MET-1,MET-2,MET-3", "done:"]);
  assert.equal(out[0]?.rows[2]?.lastAction, "Edit");
  assert.deepEqual(keys(pin(out, next, key, [])), ["ready:MET-3", "done:MET-1,MET-2"]);
});

test("in stacked groups, a change in a group above does not move the pinned row", () => {
  const shown = [group("coder", run("coder")), group("qa", run("qa/MET-1"))];
  const next = [
    group("coder", run("coder/MET-2"), run("coder/MET-3")),
    group("qa", run("qa/MET-1", "Edit")),
  ];
  const out = pin(shown, next, key, ["qa/MET-1"], { stacked: true });
  assert.deepEqual(keys(out), ["coder:coder", "qa:qa/MET-1"]);
  assert.equal(out[1]?.rows[0]?.lastAction, "Edit");
  assert.deepEqual(keys(pin(out, next, key, [], { stacked: true })), keys(next));
});

test("in side-by-side groups, a change in another group applies at once", () => {
  const shown = [group("ready", run("MET-1")), group("done", run("MET-2"))];
  const next = [group("ready", run("MET-1"), run("MET-3")), group("done", run("MET-2"))];
  assert.deepEqual(keys(pin(shown, next, key, ["MET-2"])), ["ready:MET-1,MET-3", "done:MET-2"]);
});

test("a pinned Idle row keeps its place when its agent starts a run", () => {
  const shown = [group("coder", run("coder"))];
  const next = [group("coder", run("coder/MET-1"))];
  assert.deepEqual(keys(pin(shown, next, key, ["coder"], { stacked: true })), [
    "coder:coder,coder/MET-1",
  ]);
});

test("with holdSizes, a card above the pinned card keeps its contents, so its height holds", () => {
  const shown = [group("ready", run("MET-1"), run("MET-2"))];
  const next = [group("ready", run("MET-1", "Gains an agent label"), run("MET-2", "Edit"))];
  const out = pin(shown, next, key, ["MET-2"], { holdSizes: true });
  assert.deepEqual(keys(out), ["ready:MET-1,MET-2"]);
  assert.equal(out[0]?.rows[0]?.lastAction, "Read", "the card above holds its contents");
  assert.equal(out[0]?.rows[1]?.lastAction, "Edit", "the pinned card updates");
  const released = pin(out, next, key, [], { holdSizes: true });
  assert.equal(released[0]?.rows[0]?.lastAction, "Gains an agent label", "release applies it");
});

test("without holdSizes, a row above the pinned row updates its contents", () => {
  const shown = [group("coder", run("coder/MET-1"), run("coder/MET-2"))];
  const next = [group("coder", run("coder/MET-1", "Edit"), run("coder/MET-2"))];
  const out = pin(shown, next, key, ["coder/MET-2"]);
  assert.equal(out[0]?.rows[0]?.lastAction, "Edit");
});

test("a card above the pinned card that turns loud holds its slot until release", () => {
  const shown = [group("needs-you"), group("ready", run("MET-1"), run("MET-2"))];
  const next = [group("needs-you", run("MET-1", "Blocked")), group("ready", run("MET-2"))];
  const out = pin(shown, next, key, ["MET-2"], { holdSizes: true });
  assert.deepEqual(keys(out), ["needs-you:", "ready:MET-1,MET-2"], "the pinned card keeps index 1");
  assert.deepEqual(
    keys(pin(out, next, key, [], { holdSizes: true })),
    keys(next),
    "release moves it",
  );
});

test("a pinned card in Needs you keeps its index when a new loud card arrives", () => {
  const shown = [group("needs-you", run("MET-1", "Blocked"), run("MET-2", "Blocked"))];
  const next = [group("needs-you", run("MET-9", "Blocked"), ...(shown[0]?.rows ?? []))];
  const out = pin(shown, next, key, ["MET-2"], { holdSizes: true });
  assert.deepEqual(keys(out), ["needs-you:MET-1,MET-2,MET-9"], "a new loud card goes below");
});
