#!/usr/bin/env node
// Resolve a QA sandbox home the way the daemon resolves HARNESSD_HOME (MET-239):
// String.trim(), path.resolve(), then the real folder when it exists, repeated on the
// real path until it stops changing. A symlink to a padded path therefore names the
// folder the daemon would open.
//
// Usage: node resolve-home.mjs <cwd> <home>

import { realpathSync } from "node:fs";
import { resolve } from "node:path";

function resolveHome(value, cwd) {
  let current = String(value);
  if (current.trim() === "") return "";
  for (let i = 0; i < 32; i += 1) {
    const resolved = resolve(cwd, current.trim());
    let next = resolved;
    try {
      next = realpathSync(resolved);
    } catch {
      // A path that does not exist stays the resolved string.
    }
    if (next === current) return next;
    current = next;
  }
  return current;
}

const [cwd = process.cwd(), value = ""] = process.argv.slice(2);
process.stdout.write(resolveHome(value, cwd));
