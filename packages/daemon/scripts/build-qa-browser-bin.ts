// Writes an executable `qa-browser` shim beside the built script. A package manager links
// the bin before `dist` exists on a fresh checkout or self-update, so the QA runner also
// accepts this folder on PATH (MET-179). The shim resolves its own folder, so the dist copy
// works from any install location.
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(import.meta.dirname, "..", "dist", "qa-browser");

writeFileSync(
  join(dir, "qa-browser"),
  '#!/bin/sh\nexec node "$(dirname "$0")/qa-browser.js" "$@"\n',
);
chmodSync(join(dir, "qa-browser"), 0o755);

writeFileSync(join(dir, "qa-browser.cmd"), '@echo off\r\nnode "%~dp0qa-browser.js" %*\r\n');
