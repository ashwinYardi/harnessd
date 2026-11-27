import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { type TestContext, test } from "node:test";
import { fileURLToPath } from "node:url";

// The scripts run from a copied ROOT with a stub daemon, so a run never builds or starts
// a real harnessd (MET-239).
const REPO = fileURLToPath(new URL("../../../../", import.meta.url));
/** The scripts each case runs; home.sh is copied too, because both source it. */
const SCRIPTS = ["start.sh", "seed.sh"];
const COPIES = [...SCRIPTS, "home.sh"];

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
  assert.equal(dirname(scratch), s.temp, "the daemon's home is the scratch folder under TMPDIR");
  assert.match(basename(scratch), /^harnessd-qa-\d+$/);

  const seededHome = dirname(seeded.stdout.trim().replace(/^seeded /, ""));
  assert.equal(seededHome, scratch, "seed and start agree on the scratch home");
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
      `    <string>${service}</string>`,
      "  </dict>",
      "</dict>",
      "</plist>",
      "",
    ].join("\n"),
  );

  for (const name of SCRIPTS) {
    const result = run(s, name, { HARNESSD_QA_HOME: service, HARNESSD_QA_AREA: "backend" });
    assert.equal(result.status, 1, `${name}: exits 1`);
    assert.match(result.stderr, GUARD);
  }
});
