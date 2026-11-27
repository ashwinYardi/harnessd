import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { type TestContext, test } from "node:test";
import { fileURLToPath } from "node:url";

// The scripts run from a copied ROOT with a stub daemon, so a run never builds or starts
// a real harnessd (MET-239).
const REPO = fileURLToPath(new URL("../../../../", import.meta.url));
/** The scripts each case runs; home.sh and its resolver are copied too, because both use them. */
const SCRIPTS = ["start.sh", "seed.sh"];
const COPIES = [...SCRIPTS, "home.sh", "resolve-home.mjs"];

/** A stub `harnessd run`: it records its HARNESSD_HOME instead of starting a daemon. */
const STUB = `const { writeFileSync } = require("node:fs");\nwriteFileSync(process.env.STUB_OUT, process.env.HARNESSD_HOME ?? "");\n`;

interface Sandbox {
  root: string;
  home: string;
  temp: string;
  out: string;
}

/** A copied ROOT with the QA scripts, the stub daemon, and temp HOME and TMPDIR folders. */
function sandbox(t: TestContext): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), "harnessd-qa-scripts-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, "root");
  mkdirSync(join(root, "scripts", "qa"), { recursive: true });
  for (const name of COPIES)
    copyFileSync(join(REPO, "scripts", "qa", name), join(root, "scripts", "qa", name));
  mkdirSync(join(root, "packages", "cli", "dist"), { recursive: true });
  writeFileSync(join(root, "packages", "cli", "dist", "bin.js"), STUB);
  const home = join(dir, "home");
  const temp = join(dir, "temp");
  mkdirSync(home);
  mkdirSync(temp);
  return { root, home, temp, out: join(dir, "stub-home") };
}

/** Runs one script with only the environment this case names; nothing leaks from the owner. */
function run(s: Sandbox, name: string, extra: NodeJS.ProcessEnv = {}) {
  return spawnSync("sh", [join(s.root, "scripts", "qa", name)], {
    cwd: s.root,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: s.home,
      TMPDIR: s.temp,
      STUB_OUT: s.out,
      PORT: "43117",
      ...extra,
    },
  });
}

/** A harnessd home holding the two things the scripts must never delete. */
function realHome(dir: string): string {
  mkdirSync(join(dir, "secrets"), { recursive: true });
  mkdirSync(join(dir, "state"), { recursive: true });
  writeFileSync(join(dir, "secrets", "linear.json"), "{}");
  writeFileSync(join(dir, "state", "paused.json"), "{}");
  return dir;
}

function kept(home: string): void {
  assert.equal(existsSync(join(home, "secrets", "linear.json")), true, "secrets survive");
  assert.equal(existsSync(join(home, "state", "paused.json")), true, "the pause survives");
}

/** Writes the launchd plist under temp $HOME, so the guard reads the service's home. */
function writePlist(s: Sandbox, home: string): void {
  const agents = join(s.home, "Library", "LaunchAgents");
  mkdirSync(agents, { recursive: true });
  writeFileSync(
    join(agents, "dev.harnessd.daemon.plist"),
    [
      '<plist version="1.0">',
      "<dict>",
      "  <key>EnvironmentVariables</key>",
      "  <dict>",
      "    <key>HARNESSD_HOME</key>",
      `    <string>${home}</string>`,
      "  </dict>",
      "</dict>",
      "</plist>",
      "",
    ].join("\n"),
  );
}

const GUARD = /is the real harnessd home; set HARNESSD_QA_HOME to a scratch folder/;

test("case (a): with HARNESSD_QA_HOME unset, the scripts use a scratch home under TMPDIR", (t) => {
  const s = sandbox(t);
  const real = realHome(join(s.root, "real-home"));

  const seeded = run(s, "seed.sh", { HARNESSD_HOME: real });
  assert.equal(seeded.status, 0, seeded.stderr);
  const started = run(s, "start.sh", { HARNESSD_HOME: real, HARNESSD_QA_AREA: "backend" });
  assert.equal(started.status, 0, started.stderr);

  kept(real);
  assert.equal(existsSync(join(real, "fixtures")), false, "no fixtures land in the real home");

  const scratch = readFileSync(s.out, "utf8");
  assert.equal(dirname(scratch), realpathSync(s.temp), "the daemon's home is under TMPDIR");
  assert.match(basename(scratch), /^harnessd-qa-\d+$/);

  const seededHome = dirname(seeded.stdout.trim().replace(/^seeded /, ""));
  assert.equal(realpathSync(seededHome), scratch, "seed and start reach the same scratch home");
});

test("case (b): HARNESSD_QA_HOME equal to $HOME/.harnessd is refused and left alone", (t) => {
  const s = sandbox(t);
  const real = realHome(join(s.home, ".harnessd"));

  for (const name of SCRIPTS) {
    const result = run(s, name, { HARNESSD_QA_HOME: real, HARNESSD_QA_AREA: "backend" });
    assert.equal(result.status, 1, `${name}: exits 1`);
    assert.match(result.stderr, new RegExp(`^scripts/qa/${name.replace(".", "\\.")}: `));
    assert.match(result.stderr, GUARD);
  }

  kept(real);
  assert.equal(existsSync(s.out), false, "the daemon never starts");
});

test("case (c): HARNESSD_QA_HOME equal to the plist's HARNESSD_HOME is refused", (t) => {
  const s = sandbox(t);
  const service = join(s.root, "service-home");
  mkdirSync(service, { recursive: true });
  writePlist(s, service);

  for (const name of SCRIPTS) {
    const result = run(s, name, { HARNESSD_QA_HOME: service, HARNESSD_QA_AREA: "backend" });
    assert.equal(result.status, 1, `${name}: exits 1`);
    assert.match(result.stderr, GUARD);
  }
});

test("the guard resolves homes as the daemon does: trimmed, relative and physical", (t) => {
  const s = sandbox(t);
  const real = realHome(join(s.home, ".harnessd"));

  // The daemon trims HARNESSD_HOME, so padding still names the real home.
  for (const name of SCRIPTS) {
    const padded = run(s, name, { HARNESSD_QA_HOME: ` ${real} `, HARNESSD_QA_AREA: "backend" });
    assert.equal(padded.status, 1, `${name}: a padded override is refused`);
    assert.match(padded.stderr, GUARD);
  }

  // A relative override that lands on the real home is compared as an absolute path.
  const relative = run(s, "seed.sh", { HARNESSD_QA_HOME: "../home/.harnessd" });
  assert.equal(relative.status, 1, "a relative override is resolved before comparing");
  assert.match(relative.stderr, GUARD);

  // A padded caller HARNESSD_HOME names the real home, but never becomes the sandbox.
  const started = run(s, "start.sh", { HARNESSD_HOME: ` ${real} `, HARNESSD_QA_AREA: "backend" });
  assert.equal(started.status, 0, started.stderr);
  kept(real);
  const scratch = readFileSync(s.out, "utf8");
  assert.equal(dirname(scratch), s.temp, "the scratch home is used");
  assert.equal(scratch, scratch.trim(), "the handed-off home survives the daemon's trim");
});

test("an unreadable plist is skipped and both scripts still run", (t) => {
  const s = sandbox(t);
  writePlist(s, join(s.root, "service-home"));
  chmodSync(join(s.home, "Library", "LaunchAgents", "dev.harnessd.daemon.plist"), 0o000);

  const seeded = run(s, "seed.sh");
  assert.equal(seeded.status, 0, seeded.stderr);
  const started = run(s, "start.sh", { HARNESSD_QA_AREA: "backend" });
  assert.equal(started.status, 0, started.stderr);
});

test("a leading newline and a trailing space are trimmed before the guard and the export", (t) => {
  const s = sandbox(t);
  const real = realHome(join(s.home, ".harnessd"));

  const refused = run(s, "seed.sh", { HARNESSD_QA_HOME: `\n${real} ` });
  assert.equal(refused.status, 1, "a newline-padded override is refused");
  assert.match(refused.stderr, GUARD);
  kept(real);

  const scratch = join(s.temp, "scratch-home");
  const started = run(s, "start.sh", {
    HARNESSD_QA_HOME: `\n${scratch} `,
    HARNESSD_QA_AREA: "backend",
  });
  assert.equal(started.status, 0, started.stderr);
  assert.equal(readFileSync(s.out, "utf8"), scratch, "the export carries no padding");
  assert.equal(existsSync(join(scratch, "config.toml")), true);
});

test("a configured home with a symlink followed by .. still matches the sandbox", (t) => {
  const s = sandbox(t);
  const real = realHome(s.root);
  mkdirSync(join(s.root, "target", "real"), { recursive: true });
  symlinkSync(join(s.root, "target", "real"), join(s.root, "link"));

  // The daemon's path.resolve() collapses "link/.." to s.root, the real home.
  writePlist(s, `${s.root}/link/..`);

  for (const name of SCRIPTS) {
    const result = run(s, name, { HARNESSD_QA_HOME: s.root, HARNESSD_QA_AREA: "backend" });
    assert.equal(result.status, 1, `${name}: the symlinked .. home is refused`);
    assert.match(result.stderr, GUARD);
  }
  kept(real);
});

test("U+00A0 padding is trimmed before the guard and the export", (t) => {
  const s = sandbox(t);
  const real = realHome(join(s.home, ".harnessd"));

  const refused = run(s, "seed.sh", {
    HARNESSD_QA_HOME: `\u00a0${real}\u00a0`,
    HARNESSD_HOME: `\u00a0${real}\u00a0`,
  });
  assert.equal(refused.status, 1, "a non-breaking-space-padded override is refused");
  assert.match(refused.stderr, GUARD);
  kept(real);

  const scratch = join(s.temp, "scratch-home");
  const started = run(s, "start.sh", {
    HARNESSD_QA_HOME: `\u00a0${scratch}\u00a0`,
    HARNESSD_QA_AREA: "backend",
  });
  assert.equal(started.status, 0, started.stderr);
  assert.equal(readFileSync(s.out, "utf8"), scratch, "the export carries no padding");
});

test("a symlink followed by .. resolves as the daemon does for both homes", (t) => {
  const s = sandbox(t);
  const real = realHome(join(s.root, "real-home"));
  mkdirSync(join(real, "target", "real"), { recursive: true });
  symlinkSync(join(real, "target", "real"), join(real, "link"));

  // The shell reaches real/target; path.resolve() reaches real, which is the daemon's home.
  const both = `${real}/link/..`;
  for (const name of SCRIPTS) {
    const result = run(s, name, { HARNESSD_HOME: both, HARNESSD_QA_HOME: both });
    assert.equal(result.status, 1, `${name}: refused before any cleanup`);
    assert.match(result.stderr, GUARD);
  }
  kept(real);
});

test("a space before a trailing /. is refused", (t) => {
  const s = sandbox(t);
  const real = realHome(join(s.home, ".harnessd"));
  const dotted = `${real} /.`;

  for (const name of SCRIPTS) {
    const result = run(s, name, { HARNESSD_QA_HOME: dotted });
    assert.equal(result.status, 1, `${name}: refused before any cleanup`);
    assert.match(result.stderr, GUARD);
    assert.ok(
      result.stderr.includes(`the sandbox home ${realpathSync(real)} is the real harnessd home`),
    );
  }
  kept(real);
});

test("a symlink to a padded real home is refused", (t) => {
  const s = sandbox(t);
  const real = realHome(join(s.home, ".harnessd"));
  const padded = join(s.home, ".harnessd ");
  mkdirSync(padded);
  const link = join(s.root, "padded-link");
  symlinkSync(padded, link);

  for (const name of SCRIPTS) {
    const result = run(s, name, { HARNESSD_QA_HOME: link });
    assert.equal(result.status, 1, `${name}: refused before any cleanup`);
    assert.match(result.stderr, GUARD);
  }
  kept(real);
});

test("a padded caller HARNESSD_HOME with an unrelated sandbox still runs", (t) => {
  const s = sandbox(t);
  const real = realHome(join(s.root, "real-home"));

  const seeded = run(s, "seed.sh", { HARNESSD_HOME: `${real} /.` });
  assert.equal(seeded.status, 0, seeded.stderr);
  const started = run(s, "start.sh", { HARNESSD_HOME: `${real} /.`, HARNESSD_QA_AREA: "backend" });
  assert.equal(started.status, 0, started.stderr);

  kept(real);
  assert.equal(dirname(readFileSync(s.out, "utf8")), realpathSync(s.temp));
});

test("a trailing slash and space after the real home are refused", (t) => {
  const s = sandbox(t);
  const real = realHome(join(s.home, ".harnessd"));

  for (const name of SCRIPTS) {
    const result = run(s, name, { HARNESSD_QA_HOME: `${real}/ ` });
    assert.equal(result.status, 1, `${name}: refused before any cleanup`);
    assert.match(result.stderr, GUARD);
  }
  kept(real);
});
