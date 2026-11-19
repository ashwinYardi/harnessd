import assert from "node:assert/strict";
import { test } from "node:test";
import { isWorkflowStateName, LINEAR_API_KEY_SECRET, WORKFLOW_STATES } from "./index.ts";

test("isWorkflowStateName accepts the filing-rule states only", () => {
  for (const name of WORKFLOW_STATES) assert.equal(isWorkflowStateName(name), true);
  assert.equal(isWorkflowStateName("Canceled"), false);
  assert.equal(LINEAR_API_KEY_SECRET, "linear-api-key");
});
