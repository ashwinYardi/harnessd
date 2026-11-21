#!/usr/bin/env node
import { run } from "./index.ts";

process.exitCode = await run(process.argv.slice(2), {
  cliUrl: import.meta.url,
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
});
