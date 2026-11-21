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
  assert.deepEqual(keys(out), ["coder:coder/MET-3,coder/MET-2,coder/MET-1"]);
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
  assert.deepEqual(keys(out), ["coder:coder/MET-4,coder/MET-2,coder/MET-1"], "still pinned");
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
