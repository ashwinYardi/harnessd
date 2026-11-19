import assert from "node:assert/strict";
import { test } from "node:test";
import { VERSION } from "@harnessd/shared";
import { startDaemon } from "./index.ts";

test("daemon answers /health and 404s elsewhere", async () => {
  const daemon = await startDaemon();
  try {
    const health = await fetch(`${daemon.url}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true, version: VERSION });
    const missing = await fetch(`${daemon.url}/nope`);
    assert.equal(missing.status, 404);
  } finally {
    await daemon.close();
  }
});
