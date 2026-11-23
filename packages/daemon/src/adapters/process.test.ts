import assert from "node:assert/strict";
import { test } from "node:test";
import { parseProcessTree } from "./process.ts";

// pid ppid pgid. 500 is the daemon (group 500). 600 is a run that leads group 600.
// 601 is its child. 700 is a nested run, detached into group 700. 702 slipped into
// the daemon's own group. 900 is unrelated.
const PS = [
  "  1     0   1",
  "500     1 500",
  "600   500 600",
  "601   600 600",
  "700   601 700",
  "702   601 500",
  "900     1 900",
].join("\n");

test("parseProcessTree finds every descendant and each one's group (D-048)", () => {
  const tree = parseProcessTree(PS, 600, 500);
  assert.deepEqual([...tree.pids].sort(), [601, 700, 702]);
  assert.deepEqual([...tree.groups].sort(), [600, 700]);
});

test("parseProcessTree never returns the caller's own process or group", () => {
  const tree = parseProcessTree(PS, 600, 500);
  assert.ok(!tree.groups.includes(500), "the daemon's group is never signalled");
  assert.ok(!tree.pids.includes(500));
  const self = parseProcessTree(PS, 500, 500);
  assert.ok(!self.groups.includes(500));
  assert.ok(!self.pids.includes(500));
});

test("parseProcessTree skips malformed lines and never returns group 1 or 0", () => {
  const tree = parseProcessTree(`${PS}\nnot a row\n  42`, 1, 500);
  assert.ok(!tree.groups.includes(1));
  assert.ok(!tree.groups.includes(0));
});
