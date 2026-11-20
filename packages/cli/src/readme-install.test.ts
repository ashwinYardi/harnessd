// Runs the README "Install" block's guard and wrapper lines with sh, so the test fails
// when the README drifts. The wrapper must name its Node by an absolute path (MET-37),
// because launchd does not load nvm or the shell profile.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const README = join(import.meta.dirname, "..", "..", "..", "README.md");
const SH = "/bin/sh";

const roots: string[] = [];
after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

/** The lines of the first bash block under "## Install". */
async function installBlock(): Promise<string[]> {
  const text = await readFile(README, "utf8");
  const section = text.split(/^## Install$/m)[1];
  assert.ok(section, "README has an Install section");
  const block = /```bash\n([\s\S]*?)```/.exec(section);
  assert.ok(block, "Install section has a bash block");
  return (block[1] ?? "").split("\n").filter((l) => l.trim() !== "");
}

const line = (lines: string[], start: string) => {
  const found = lines.find((l) => l.startsWith(start));
  assert.ok(found, `Install block has a line that starts with ${start}`);
  return found;
};

test("the Install block starts with a Node 24 guard that passes on this Node", async () => {
  const [guard = ""] = await installBlock();
  assert.match(
    guard,
    /^node -e .*< 24 \? 1 : 0\)' \|\| \{ echo 'harnessd needs Node 24 or newer'; exit 1; \}$/,
  );
  const run = spawnSync(SH, ["-c", guard], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stdout + run.stderr);
});

test("the README wrapper names Node and bin.js by quoted absolute paths", async () => {
  const lines = await installBlock();
  const printf = line(lines, "printf ");
  const root = await realpath(await mkdtemp(join(tmpdir(), "harnessd-readme-")));
  roots.push(root);
  // A space in the clone path checks the quoting.
  const repo = join(root, "my clone");
  const dist = join(repo, "packages", "cli", "dist");
  await mkdir(dist, { recursive: true });
  await mkdir(join(root, ".local", "bin"), { recursive: true });
  await writeFile(join(dist, "bin.js"), "console.log(JSON.stringify(process.argv.slice(2)));\n");

  const env = { ...process.env, HOME: root, PWD: repo };
  const write = spawnSync(SH, ["-c", printf], { cwd: repo, env, encoding: "utf8" });
  assert.equal(write.status, 0, write.stderr);

  const node = spawnSync(SH, ["-c", "command -v node"], { encoding: "utf8" }).stdout.trim();
  assert.ok(node.startsWith("/"), `command -v node is absolute: ${node}`);
  const wrapper = await readFile(join(root, ".local", "bin", "harnessd"), "utf8");
  assert.equal(wrapper, `#!/bin/sh\nexec "${node}" "${repo}/packages/cli/dist/bin.js" "$@"\n`);

  const run = spawnSync(SH, [join(root, ".local", "bin", "harnessd"), "doctor", "a b"], {
    env: { ...env, PATH: "/usr/bin:/bin" },
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), ["doctor", "a b"]);
});
