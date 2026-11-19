import assert from "node:assert/strict";
import { test } from "node:test";
import { ESCALATION_TRIGGER_LABELS, ESCALATION_TRIGGERS, isEscalationTrigger } from "./index.ts";

test("isEscalationTrigger accepts the D-011 categories only", () => {
  assert.equal(ESCALATION_TRIGGERS.length, 5);
  for (const trigger of ESCALATION_TRIGGERS) {
    assert.equal(isEscalationTrigger(trigger), true);
    assert.ok(ESCALATION_TRIGGER_LABELS[trigger].length > 0);
  }
  assert.equal(isEscalationTrigger("unclear"), false);
  assert.equal(isEscalationTrigger("Money"), false);
});
