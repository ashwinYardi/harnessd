import assert from "node:assert/strict";
import { test } from "node:test";
import { startDaemon } from "../server/daemon.ts";
import { statusRoutes } from "./route.ts";
import type { Check } from "./status.ts";

test("GET /api/status returns the checks, and concurrent calls share one run", async () => {
  let runs = 0;
  const checks: Check[] = [{ id: "node", state: "ok", detail: "v24.11.0 (/bin/node)", fix: "" }];
  const daemon = await startDaemon({
    routes: statusRoutes(async () => {
      runs++;
      await new Promise((r) => setTimeout(r, 20));
      return checks;
    }),
  });
  try {
    const [a, b] = await Promise.all([
      fetch(`${daemon.url}/api/status`),
      fetch(`${daemon.url}/api/status`),
    ]);
    assert.equal(a.status, 200);
    assert.deepEqual(await a.json(), { checks });
    assert.deepEqual(await b.json(), { checks });
    assert.equal(runs, 1);
    await fetch(`${daemon.url}/api/status`);
    assert.equal(runs, 2, "a later call runs the checks again");
  } finally {
    await daemon.close();
  }
});
