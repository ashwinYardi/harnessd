// Runs scripts/install.sh with a PATH of tiny sh stubs (node, npx, brew, curl, sudo, ...),
// so every branch is checked without installing anything. Each stub logs its argv.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const SCRIPT = join(import.meta.dirname, "..", "..", "..", "scripts", "install.sh");
const SH = "/bin/sh";
/** Real tools the script uses; linked in so nothing else from the host PATH leaks in. */
const REAL = ["grep", "head", "mktemp", "rm", "chmod"];

const roots: string[] = [];
after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

const nodeStub = (version: string) => `#!/bin/sh\necho ${version}\n`;

interface Setup {
  os?: string;
  node?: string;
  brew?: boolean;
  /** shasum prints this instead of the listed checksum. */
  badSum?: boolean;
}

async function setup(o: Setup) {
  const root = await mkdtemp(join(tmpdir(), "harnessd-install-sh-"));
  roots.push(root);
  const bin = join(root, "bin");
  const log = join(root, "log");
  await writeFile(log, "");
  await mkdir(bin);
  for (const tool of REAL) {
    const found = spawnSync(SH, ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim();
    assert.ok(found, `${tool} on the host`);
    await symlink(found, join(bin, tool));
  }
  const stub = async (name: string, body: string) => {
    const file = join(bin, name);
    await writeFile(file, `#!/bin/sh\necho "${name} $*" >> "${log}"\n${body}\n`);
    await chmod(file, 0o755);
  };
  // The node an install puts on PATH.
  const install24 = `printf '#!/bin/sh\\necho v24.9.0\\n' > "${bin}/node"; chmod +x "${bin}/node"`;
  await stub("uname", `echo ${o.os ?? "Darwin"}`);
  await stub("npx", "exit 0");
  if (o.node !== undefined) {
    await writeFile(join(bin, "node"), nodeStub(o.node));
    await chmod(join(bin, "node"), 0o755);
  }
  if (o.brew) {
    await stub("brew", `case $1 in install) ${install24} ;; --prefix) echo "${root}/keg" ;; esac`);
  }
  await stub(
    "curl",
    `for a; do out=$a; done
case $out in
  *SHASUMS256.txt) printf 'aaa  node-v24.9.0-darwin-arm64.tar.gz\\nfeed  node-v24.9.0.pkg\\n' > "$out" ;;
  *) echo pkg > "$out" ;;
esac`,
  );
  await stub("shasum", `echo "${o.badSum ? "bad" : "feed"}  $3"`);
  await stub("sudo", `"$@"`);
  await stub("installer", install24);
  return { root, bin, log };
}

/** Runs the script in a new session: no controlling terminal, so /dev/tty is unavailable. */
function runScript(s: { bin: string }, args: string[] = [], script = SCRIPT, shell = SH) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((done, fail) => {
    const child = spawn(shell, [script, ...args], {
      env: { PATH: s.bin, HOME: s.bin },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    // A failed spawn has no close event: reject instead of leaving the test's promise pending.
    child.on("error", fail);
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("close", (code) => done({ code: code ?? 1, stdout, stderr }));
  });
}

async function calls(log: string): Promise<string[]> {
  return (await readFile(log, "utf8")).split("\n").filter((l) => l !== "");
}

test("install.sh passes sh -n", () => {
  const res = spawnSync(SH, ["-n", SCRIPT], { encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
});

test("a shell that cannot start rejects instead of leaving the test pending", async () => {
  const s = await setup({ node: "v24.1.0" });
  await assert.rejects(runScript(s, [], SCRIPT, join(s.root, "missing-sh")), /ENOENT/);
});

test("node 24 present: runs init with the arguments, and again on a re-run", async () => {
  const s = await setup({ node: "v24.1.0", brew: true });
  for (let i = 0; i < 2; i++) {
    const res = await runScript(s, ["--no-service"]);
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /node v24.1.0 found/);
    assert.match(res.stdout, /\+ npx -y @harnessd\/cli@latest init --no-service/);
  }
  assert.deepEqual(await calls(s.log), [
    "npx -y @harnessd/cli@latest init --no-service",
    "npx -y @harnessd/cli@latest init --no-service",
  ]);
});

test("node missing with Homebrew: brew installs and links node@24", async () => {
  const s = await setup({ brew: true });
  const res = await runScript(s);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /node not found/);
  assert.match(res.stdout, /\+ brew install node@24\n/);
  assert.deepEqual(await calls(s.log), [
    "brew install node@24",
    "brew link --overwrite --force node@24",
    "npx -y @harnessd/cli@latest init",
  ]);
});

test("node too old on a Mac without Homebrew: the nodejs.org pkg with --yes", async () => {
  const s = await setup({ node: "v20.11.0" });
  const res = await runScript(s, ["--yes"]);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /node v20.11.0 is older than 24/);
  assert.match(res.stdout, /sudo installer -pkg .*node-v24.9.0.pkg -target \//);
  const log = await calls(s.log);
  assert.deepEqual(
    log.map((l) => l.replace(/ \/\S*\/(SHASUMS256.txt|node-v24.9.0.pkg)/g, " <tmp>/$1")),
    [
      "uname -s",
      "curl -fsSL https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt -o <tmp>/SHASUMS256.txt",
      "curl -fsSL https://nodejs.org/dist/latest-v24.x/node-v24.9.0.pkg -o <tmp>/node-v24.9.0.pkg",
      "shasum -a 256 <tmp>/node-v24.9.0.pkg",
      "sudo installer -pkg <tmp>/node-v24.9.0.pkg -target /",
      "installer -pkg <tmp>/node-v24.9.0.pkg -target /",
      "npx -y @harnessd/cli@latest init --yes",
    ],
  );
});

test("no sudo without consent: no --yes and no terminal stops before installer", async () => {
  const s = await setup({});
  const res = await runScript(s);
  assert.equal(res.code, 1);
  assert.match(res.stdout, /needs sudo/);
  assert.match(res.stderr, /Node not installed\. Re-run with --yes/);
  const log = await calls(s.log);
  assert.ok(!log.some((l) => l.startsWith("sudo") || l.startsWith("npx")), log.join("\n"));
});

test("a checksum mismatch installs nothing", async () => {
  const s = await setup({ badSum: true });
  const res = await runScript(s, ["--yes"]);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /checksum mismatch/);
  assert.ok(!(await calls(s.log)).some((l) => l.startsWith("sudo")));
});

test("Linux without node or Homebrew: asks for a manual Node install", async () => {
  const s = await setup({ os: "Linux" });
  const res = await runScript(s);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /Install Node 24 .*then re-run/);
  assert.deepEqual(await calls(s.log), ["uname -s"]);
});
