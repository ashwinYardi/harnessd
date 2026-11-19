#!/usr/bin/env node
import { run } from "./index.ts";

process.exitCode = await run(process.argv.slice(2), {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
});
