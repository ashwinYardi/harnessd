import assert from "node:assert/strict";
import { test } from "node:test";
import { VERSION } from "@harnessd/shared";
import { run } from "./index.ts";

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
}

test("version prints VERSION", async () => {
  const c = capture();
  assert.equal(await run(["version"], c.io), 0);
  assert.deepEqual(c.out, [VERSION]);
});

test("unknown command exits 2 with a hint", async () => {
  const c = capture();
  assert.equal(await run(["frobnicate"], c.io), 2);
  assert.match(c.err[0] ?? "", /unknown command "frobnicate"/);
});
