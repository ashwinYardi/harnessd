import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { loadConfig, syncRepo } from "@harnessd/daemon";
import { run } from "./index.ts";
import {
  CONFIG_TEMPLATE,
  type ExecResult,
  type InitSystem,
  LAUNCHD_LABEL,
  nodeSystem,
  parseInitArgs,
  renderPlist,
  runInit,
} from "./init.ts";
import { buildPack } from "./pack.ts";

const HOME = "/Users/ada";
const PLIST = `${HOME}/Library/LaunchAgents/dev.harnessd.daemon.plist`;
const CONFIG = `${HOME}/.harnessd/config.toml`;
const REPO = `${HOME}/code/app`;
const BIN = "/opt/homebrew/bin";
const PACK_DIR = "/pack";
const SKILLS = `${HOME}/.harnessd/skills`;
const A = "a".repeat(40);
const B = "b".repeat(40);

/** A two-skill pack as the build lays it out, shipping `commit` for tdd. */
function pack(commit = A): Record<string, string> {
  const marker = (upstream: string, c: string) => `${JSON.stringify({ upstream, commit: c })}\n`;
  return {
    [`${PACK_DIR}/pack.json`]: JSON.stringify([
      { name: "tdd", upstream: "mattpocock/skills", commit },
      { name: "impeccable", upstream: "pbakaus/impeccable", commit: B, version: "4.10.0" },
    ]),
    [`${PACK_DIR}/tdd/SKILL.md`]: `tdd at ${commit}`,
    [`${PACK_DIR}/tdd/LICENSE`]: "MIT",
    [`${PACK_DIR}/tdd/.harnessd-pack`]: marker("mattpocock/skills", commit),
    [`${PACK_DIR}/impeccable/SKILL.md`]: "impeccable",
    [`${PACK_DIR}/impeccable/LICENSE`]: "Apache",
    [`${PACK_DIR}/impeccable/.harnessd-pack`]: marker("pbakaus/impeccable", B),
  };
}

const PINS = `
# Default skill pack (docs/CONFIG.md "Skills"). init installs only the pinned commit.
[skills.tdd]
upstream = "mattpocock/skills"
commit = "${A}"

[skills.impeccable]
upstream = "pbakaus/impeccable"
commit = "${B}"
version = "4.10.0"
`;

interface FakeOptions {
  platform?: NodeJS.Platform;
  /** Binaries already in /opt/homebrew/bin. npm is always there. */
  installed?: string[];
  files?: Record<string, string>;
  confirm?: boolean;
  /** Labels launchd has loaded. */
  loaded?: boolean;
  failInstall?: string;
  /** The pack this harnessd ships; defaults to pack(). */
  pack?: Record<string, string>;
}

/** An in-memory Mac (or Linux box): files in a map, commands recorded, npm and launchctl faked. */
function fake(o: FakeOptions = {}) {
  const files = new Map<string, string>(Object.entries({ ...(o.pack ?? pack()), ...o.files }));
  const bins = new Set(["npm", ...(o.installed ?? [])]);
  const calls: string[] = [];
  const asked: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  let loaded = o.loaded ?? false;
  const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
  const versions: Record<string, string> = {
    harnessd: "0.1.0",
    claude: "2.1.0 (Claude Code)",
    codex: "codex-cli 0.50.0",
  };
  const sys: InitSystem = {
    platform: o.platform ?? "darwin",
    homedir: HOME,
    uid: 501,
    cwd: REPO,
    env: { PATH: `/Users/ada/.npm/_npx/abc/node_modules/.bin:${BIN}:/usr/bin` },
    nodePath: "/opt/homebrew/Cellar/node@24/24.1.0/bin/node",
    packDir: PACK_DIR,
    fs: {
      read: async (p) => files.get(p),
      write: async (p, d) => {
        files.set(p, d);
      },
      mkdirp: async () => {},
      exists: async (p) =>
        files.has(p) ||
        p === `${REPO}/.git` ||
        [...files.keys()].some((k) => k.startsWith(`${p}/`)),
      copyDir: async (from, to) => {
        for (const k of [...files.keys()]) if (k.startsWith(`${to}/`)) files.delete(k);
        for (const [k, v] of [...files]) {
          if (k.startsWith(`${from}/`)) files.set(`${to}${k.slice(from.length)}`, v);
        }
      },
      isExecutable: async (p) => p.startsWith(`${BIN}/`) && bins.has(p.slice(BIN.length + 1)),
    },
    exec: async (cmd, args) => {
      const line = [cmd, ...args].join(" ");
      if (args[0] === "--version") return ok(`${versions[cmd.split("/").pop() ?? ""]}\n`);
      calls.push(line);
      if (cmd === `${BIN}/npm`) {
        const pkg = args[2] ?? "";
        if (pkg === o.failInstall) return { code: 1, stdout: "", stderr: "EACCES" };
        const bin = { "@harnessd/cli": "harnessd", "@anthropic-ai/claude-code": "claude" }[pkg];
        bins.add(bin ?? "codex");
        return ok();
      }
      if (cmd === "launchctl" && args[0] === "print") return { ...ok(), code: loaded ? 0 : 113 };
      if (cmd === "launchctl" && args[0] === "bootout") loaded = false;
      if (cmd === "launchctl" && args[0] === "bootstrap") loaded = true;
      return ok();
    },
    ...(o.confirm === undefined
      ? {}
      : {
          confirm: async (q: string) => {
            asked.push(q);
            return o.confirm ?? false;
          },
        }),
    sleep: async () => {},
  };
  const io = { out: (l: string) => out.push(l), err: (l: string) => err.push(l) };
  return { sys, io, files, calls, asked, out, err };
}

const ALL = ["harnessd", "claude", "codex"];

test("fresh Mac with --yes: installs the CLIs, writes config and plist, bootstraps", async () => {
  const f = fake();
  assert.equal(await runInit(["--yes"], f.io, f.sys), 0);
  assert.deepEqual(f.calls, [
    `${BIN}/npm i -g @harnessd/cli`,
    `${BIN}/npm i -g @anthropic-ai/claude-code`,
    `${BIN}/npm i -g @openai/codex`,
    `launchctl print gui/501/${LAUNCHD_LABEL}`,
    `launchctl bootstrap gui/501 ${PLIST}`,
  ]);
  // What it runs is printed before it runs.
  assert.ok(f.out.includes("  npm i -g @anthropic-ai/claude-code"));
  assert.ok(f.out.includes(`run: ${BIN}/npm i -g @openai/codex`));
  assert.ok(f.out.includes(`run: launchctl bootstrap gui/501 ${PLIST}`));
  assert.ok(f.out.includes("Claude Code: 2.1.0 (Claude Code) (/opt/homebrew/bin/claude)"));
  assert.equal(f.files.get(CONFIG), CONFIG_TEMPLATE + PINS);
  assert.ok(f.out.includes(`config: wrote ${CONFIG}`));
  assert.equal(f.files.get(`${SKILLS}/tdd/SKILL.md`), `tdd at ${A}`);
  assert.equal(f.files.get(`${SKILLS}/tdd/LICENSE`), "MIT");
  assert.equal(f.files.get(`${SKILLS}/impeccable/LICENSE`), "Apache");
  assert.ok(f.out.includes(`skills: installed tdd, impeccable in ${SKILLS}`));
  assert.ok(f.out.includes(`skills: pinned tdd, impeccable in ${CONFIG}`));
  assert.match(f.files.get(PLIST) ?? "", /<string>\/opt\/homebrew\/bin\/harnessd<\/string>/);
  assert.equal(f.out.at(-1), "init: done");
  assert.deepEqual(f.err, []);
});

test("re-run with nothing changed: no installs, config kept, service left alone", async () => {
  const f = fake({ installed: ALL });
  assert.equal(await runInit([], f.io, f.sys), 0);
  const first = new Map(f.files);
  const again = fake({ installed: ALL, files: Object.fromEntries(first), loaded: true });
  assert.equal(await runInit([], again.io, again.sys), 0);
  assert.deepEqual(again.calls, [`launchctl print gui/501/${LAUNCHD_LABEL}`]);
  assert.deepEqual(again.files, first);
  assert.ok(again.out.includes(`config: kept existing ${CONFIG}`));
  assert.ok(again.out.includes(`service: unchanged, ${LAUNCHD_LABEL} already loaded (${PLIST})`));
  assert.ok(!again.out.some((l) => l.startsWith("To install")));
});

test("an existing config.toml is never overwritten", async () => {
  const f = fake({ installed: ALL, files: { [CONFIG]: "[linear]\nteam_id = 'MET'\n" } });
  assert.equal(await runInit(["--no-service"], f.io, f.sys), 0);
  assert.ok(f.out.includes(`config: kept existing ${CONFIG}`));
  // Pins are appended; the user's text stays as it was.
  assert.equal(f.files.get(CONFIG), `[linear]\nteam_id = 'MET'\n${PINS}`);
});

test("re-run keeps installed skills and pins; an upgraded pack waits for a pin change", async () => {
  const first = fake({ installed: ALL });
  assert.equal(await runInit(["--no-service"], first.io, first.sys), 0);
  const state = Object.fromEntries([...first.files].filter(([k]) => !k.startsWith(PACK_DIR)));

  // A newer harnessd ships tdd at B. Nothing reaches the agents yet.
  const upgraded = fake({ installed: ALL, files: state, pack: pack(B) });
  assert.equal(await runInit(["--no-service"], upgraded.io, upgraded.sys), 0);
  assert.equal(upgraded.files.get(`${SKILLS}/tdd/SKILL.md`), `tdd at ${A}`);
  assert.equal(upgraded.files.get(CONFIG), CONFIG_TEMPLATE + PINS);
  assert.ok(
    upgraded.out.includes(
      `skills: tdd is pinned to ${A}; this harnessd ships ${B}. Set skills.tdd.commit = "${B}" in ${CONFIG} to update.`,
    ),
  );
  assert.ok(upgraded.out.includes(`skills: kept tdd, impeccable in ${SKILLS}`));

  // The owner changes the pin: the next init updates the folder.
  const config = (upgraded.files.get(CONFIG) ?? "").replace(`commit = "${A}"`, `commit = "${B}"`);
  const repinned = fake({
    installed: ALL,
    files: { ...Object.fromEntries(upgraded.files), [CONFIG]: config },
    pack: pack(B),
  });
  assert.equal(await runInit(["--no-service"], repinned.io, repinned.sys), 0);
  assert.equal(repinned.files.get(`${SKILLS}/tdd/SKILL.md`), `tdd at ${B}`);
  assert.equal(repinned.files.get(CONFIG), config);
  assert.ok(repinned.out.includes(`skills: updated tdd in ${SKILLS}`));
});

test("a skill at its pin is copied again when this harnessd ships a newer pack format", async () => {
  const first = fake({ installed: ALL });
  assert.equal(await runInit(["--no-service"], first.io, first.sys), 0);
  const state = Object.fromEntries([...first.files].filter(([k]) => !k.startsWith(PACK_DIR)));
  // The same commits, but the build now adds harness files and a new marker.
  const newer = pack();
  const marker = `${JSON.stringify({ upstream: "pbakaus/impeccable", commit: B, format: 2 })}\n`;
  newer[`${PACK_DIR}/impeccable/.harnessd-pack`] = marker;
  newer[`${PACK_DIR}/impeccable/.harnessd-native/hooks.json`] = "{}";
  const again = fake({ installed: ALL, files: state, pack: newer });
  assert.equal(await runInit(["--no-service"], again.io, again.sys), 0);
  assert.ok(again.out.includes(`skills: updated impeccable in ${SKILLS}`));
  assert.ok(again.out.includes(`skills: kept tdd in ${SKILLS}`));
  assert.equal(again.files.get(`${SKILLS}/impeccable/.harnessd-pack`), marker);
  assert.equal(again.files.get(CONFIG), CONFIG_TEMPLATE + PINS);
});

test("a pin init cannot meet installs nothing for that skill", async () => {
  const pinned = `[skills.tdd]\ncommit = "${"c".repeat(40)}"\n`;
  const f = fake({ installed: ALL, files: { [CONFIG]: pinned } });
  assert.equal(await runInit(["--no-service"], f.io, f.sys), 0);
  assert.ok(!f.files.has(`${SKILLS}/tdd/SKILL.md`));
  assert.ok(f.files.has(`${SKILLS}/impeccable/SKILL.md`));
  assert.ok(f.out.some((l) => l.startsWith(`skills: tdd is pinned to ${"c".repeat(40)}`)));
  assert.ok(!(f.files.get(CONFIG) ?? "").includes("[skills.tdd]\nupstream"));
});

test("a skill table without a commit gets no second table, and init says how to pin", async () => {
  const f = fake({ installed: ALL, files: { [CONFIG]: "[skills.tdd]\nenabled = false\n" } });
  assert.equal(await runInit(["--no-service"], f.io, f.sys), 0, f.err.join("\n"));
  assert.ok(!f.files.has(`${SKILLS}/tdd/SKILL.md`));
  assert.equal((f.files.get(CONFIG) ?? "").match(/\[skills\.tdd\]/g)?.length, 1);
  assert.ok(
    f.out.includes(
      `skills: tdd has no commit in its table. Set skills.tdd.commit = "${A}" in ${CONFIG} to install it.`,
    ),
  );
  assert.ok(f.files.has(`${SKILLS}/impeccable/SKILL.md`));
});

test("a skill folder init did not install is kept, and gets no pin", async () => {
  const f = fake({ installed: ALL, files: { [`${SKILLS}/tdd/SKILL.md`]: "mine" } });
  assert.equal(await runInit(["--no-service"], f.io, f.sys), 0);
  assert.equal(f.files.get(`${SKILLS}/tdd/SKILL.md`), "mine");
  assert.ok(!f.files.has(`${SKILLS}/tdd/LICENSE`));
  assert.ok(f.out.includes(`skills: kept ${SKILLS}/tdd; init did not install it`));
  assert.ok(!(f.files.get(CONFIG) ?? "").includes("[skills.tdd]"));
});

test("a removed pin table is written back from the installed folder", async () => {
  const first = fake({ installed: ALL });
  await runInit(["--no-service"], first.io, first.sys);
  const state = Object.fromEntries(first.files);
  state[CONFIG] = "# mine\n";
  const again = fake({ installed: ALL, files: state, pack: pack(B) });
  assert.equal(await runInit(["--no-service"], again.io, again.sys), 0);
  assert.match(
    again.files.get(CONFIG) ?? "",
    new RegExp(`\\[skills.tdd\\]\nupstream = "mattpocock/skills"\ncommit = "${A}"`),
  );
  assert.equal(again.files.get(`${SKILLS}/tdd/SKILL.md`), `tdd at ${A}`);
});

test("a build without the pack, or a broken config.toml, fails the skills step", async () => {
  const none = fake({ installed: ALL, pack: {} });
  assert.equal(await runInit(["--no-service"], none.io, none.sys), 1);
  assert.match(none.err.join("\n"), /no skill pack in \/pack/);

  const broken = fake({ installed: ALL, files: { [CONFIG]: "[skills\n" } });
  assert.equal(await runInit(["--no-service"], broken.io, broken.sys), 1);
  assert.match(broken.err.join("\n"), /config\.toml: invalid TOML at line 1/);
  assert.equal(broken.files.get(CONFIG), "[skills\n");
});

test("a changed plist is rewritten and the loaded service is booted out and back in", async () => {
  const f = fake({ installed: ALL, files: { [PLIST]: "<old/>" }, loaded: true });
  assert.equal(await runInit(["--workspace", "/Users/ada/code/other"], f.io, f.sys), 0);
  assert.deepEqual(f.calls, [
    `launchctl print gui/501/${LAUNCHD_LABEL}`,
    `launchctl bootout gui/501/${LAUNCHD_LABEL}`,
    `launchctl bootstrap gui/501 ${PLIST}`,
  ]);
  assert.match(f.files.get(PLIST) ?? "", /<string>\/Users\/ada\/code\/other<\/string>/);
  assert.ok(f.out.some((l) => l.includes("is not a git repo")));
});

test("missing CLIs without --yes and no terminal: prints the commands, installs nothing", async () => {
  const f = fake({ installed: ["harnessd"] });
  assert.equal(await runInit([], f.io, f.sys), 0);
  assert.ok(!f.calls.some((c) => c.includes("npm")));
  assert.ok(f.out.includes("Claude Code: not found"));
  assert.ok(f.out.includes("  npm i -g @anthropic-ai/claude-code"));
  assert.ok(f.out.includes("  npm i -g @openai/codex"));
  assert.ok(f.out.includes("Skipped installs. Re-run with --yes to install them."));
  assert.equal(f.out.at(-1), "init: done; not installed: claude, codex");
});

test("missing CLIs, interactive: no installs on no, installs on yes", async () => {
  const no = fake({ installed: ["harnessd"], confirm: false });
  assert.equal(await runInit(["--no-service"], no.io, no.sys), 0);
  assert.deepEqual(no.asked, ["Run these now? [y/N] "]);
  assert.deepEqual(no.calls, []);

  const yes = fake({ installed: ["harnessd"], confirm: true });
  assert.equal(await runInit(["--no-service"], yes.io, yes.sys), 0);
  assert.deepEqual(yes.calls, [
    `${BIN}/npm i -g @anthropic-ai/claude-code`,
    `${BIN}/npm i -g @openai/codex`,
  ]);
  assert.equal(yes.out.at(-1), "init: done");
});

test("--yes never asks", async () => {
  const f = fake({ installed: ["harnessd", "claude"], confirm: false });
  assert.equal(await runInit(["-y", "--no-service"], f.io, f.sys), 0);
  assert.deepEqual(f.asked, []);
  assert.deepEqual(f.calls, [`${BIN}/npm i -g @openai/codex`]);
});

test("a failed install exits 1 and still writes the config", async () => {
  const f = fake({ installed: ["harnessd", "claude"], failInstall: "@openai/codex" });
  assert.equal(await runInit(["--yes", "--no-service"], f.io, f.sys), 1);
  assert.match(f.err[0] ?? "", /npm i -g @openai\/codex" exited 1/);
  assert.equal(f.files.get(CONFIG), CONFIG_TEMPLATE + PINS);
});

test("no global harnessd: the service is skipped", async () => {
  const f = fake({ installed: ["claude", "codex"] });
  assert.equal(await runInit([], f.io, f.sys), 0);
  assert.ok(!f.files.has(PLIST));
  assert.ok(
    f.out.includes("service: skipped; harnessd is not installed globally (re-run with --yes)"),
  );
});

test("Linux skips the service; so does --no-service on a Mac", async () => {
  const linux = fake({ platform: "linux", installed: ALL });
  assert.equal(await runInit([], linux.io, linux.sys), 0);
  assert.deepEqual(linux.calls, []);
  assert.ok(!linux.files.has(PLIST));
  assert.ok(linux.out.includes("service: skipped; the launchd service is macOS-only in v0.1"));

  const mac = fake({ installed: ALL });
  assert.equal(await runInit(["--no-service"], mac.io, mac.sys), 0);
  assert.deepEqual(mac.calls, []);
  assert.ok(mac.out.includes("service: skipped (--no-service)"));
});

test("bootstrap is retried while launchd lets go of the old label", async () => {
  const f = fake({ installed: ALL });
  let failures = 1;
  const exec = f.sys.exec;
  f.sys.exec = async (cmd, args, opts) => {
    if (args[0] === "bootstrap" && failures-- > 0) {
      f.calls.push("bootstrap failed");
      return { code: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error" };
    }
    return exec(cmd, args, opts);
  };
  assert.equal(await runInit([], f.io, f.sys), 0);
  assert.deepEqual(f.calls.slice(-2), ["bootstrap failed", `launchctl bootstrap gui/501 ${PLIST}`]);
});

test("plist: label, harnessd run in the workspace, PATH without npx dirs, logs", async () => {
  const f = fake({ installed: ALL });
  f.sys.env.HARNESSD_HOME = "/Users/ada/hd";
  assert.equal(await runInit([], f.io, f.sys), 0);
  const plist = f.files.get(PLIST) ?? "";
  assert.equal(
    plist,
    renderPlist({
      harnessd: `${BIN}/harnessd`,
      workspace: REPO,
      logsDir: "/Users/ada/hd/logs",
      path: "/opt/homebrew/Cellar/node@24/24.1.0/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
      harnessdHome: "/Users/ada/hd",
    }),
  );
  assert.match(plist, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<!DOCTYPE plist/);
  for (const part of [
    "<key>Label</key>\n  <string>dev.harnessd.daemon</string>",
    "<array>\n    <string>/opt/homebrew/bin/harnessd</string>\n    <string>run</string>\n  </array>",
    `<key>WorkingDirectory</key>\n  <string>${REPO}</string>`,
    "<key>PATH</key>\n    <string>/opt/homebrew/Cellar/node@24/24.1.0/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>",
    "<key>HARNESSD_HOME</key>\n    <string>/Users/ada/hd</string>",
    "<key>RunAtLoad</key>\n  <true/>",
    "<key>SuccessfulExit</key>\n    <false/>",
    "<key>StandardOutPath</key>\n  <string>/Users/ada/hd/logs/daemon.out.log</string>",
    "<key>StandardErrorPath</key>\n  <string>/Users/ada/hd/logs/daemon.err.log</string>",
  ]) {
    assert.ok(plist.includes(part), part);
  }
  assert.ok(!plist.includes("_npx"));
  assert.ok(!plist.includes("LINEAR_API_KEY"));
  assert.ok(f.files.has("/Users/ada/hd/config.toml"));
});

test("plist escapes XML in paths", () => {
  const plist = renderPlist({
    harnessd: "/a&b/harnessd",
    workspace: "/w<x>",
    logsDir: "/l",
    path: "/p",
  });
  assert.ok(plist.includes("<string>/a&amp;b/harnessd</string>"));
  assert.ok(plist.includes("<string>/w&lt;x&gt;</string>"));
  assert.ok(!plist.includes("HARNESSD_HOME"));
});

test("parseInitArgs", () => {
  assert.deepEqual(parseInitArgs([]), { yes: false, service: true, help: false });
  assert.deepEqual(parseInitArgs(["--yes", "--no-service", "--workspace", "x"]), {
    yes: true,
    service: false,
    help: false,
    workspace: "x",
  });
  assert.equal(parseInitArgs(["--workspace"]), "--workspace: expected a directory");
  assert.equal(parseInitArgs(["--force"]), 'unexpected argument "--force"');
});

test("harnessd init is wired into the CLI and rejects bad flags", async () => {
  const f = fake({ platform: "linux", installed: ALL });
  assert.equal(await run(["init", "--no-service"], { ...f.io, system: f.sys }), 0);
  assert.equal(f.out.at(-1), "init: done");
  assert.equal(await run(["init", "--bogus"], { ...f.io, system: f.sys }), 2);
  assert.match(f.err.at(-1) ?? "", /^Usage: harnessd init/);
});

const roots: string[] = [];
after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

test("end to end on disk: init installs the pack, re-run keeps it, sync gives it to every harness", async () => {
  const root = await mkdtemp(join(tmpdir(), "harnessd-cli-init-"));
  roots.push(root);
  const packDir = join(root, "pack");
  await buildPack(join(import.meta.dirname, "../../../.claude/skills"), packDir);
  const home = join(root, "home");
  const bin = join(root, "bin");
  await mkdir(bin);
  for (const tool of ["npm", ...ALL]) await writeFile(join(bin, tool), "", { mode: 0o755 });
  const real = nodeSystem();
  const sys: InitSystem = {
    ...real,
    platform: "linux",
    homedir: home,
    cwd: root,
    env: { PATH: bin },
    packDir,
    exec: async () => ({ code: 0, stdout: "1.0.0\n", stderr: "" }),
  };
  delete sys.confirm;
  const out: string[] = [];
  const io = { out: (l: string) => out.push(l), err: (l: string) => out.push(l) };
  assert.equal(await runInit(["--no-service"], io, sys), 0, out.join("\n"));
  const globalDir = join(home, ".harnessd");
  const config = await readFile(join(globalDir, "config.toml"), "utf8");
  assert.ok(config.startsWith(CONFIG_TEMPLATE));
  assert.match(
    config,
    /\[skills\.impeccable\]\nupstream = "pbakaus\/impeccable"\ncommit = "b49177d/,
  );
  assert.equal(config.match(/^\[skills\./gm)?.length, 14);

  // Re-run: the same bytes, the same skills.
  out.length = 0;
  assert.equal(await runInit(["--no-service"], io, sys), 0, out.join("\n"));
  assert.equal(await readFile(join(globalDir, "config.toml"), "utf8"), config);
  assert.ok(out.some((l) => l.startsWith("skills: kept code-review, ")));

  const merged = await loadConfig({ globalDir, workspaceDir: join(root, "none") });
  assert.equal(merged.skills.length, 14);

  // A repo that turns impeccable off, and that hand-vendors its own tdd.
  const repo = join(root, "repo");
  await mkdir(join(repo, ".harnessd"), { recursive: true });
  await writeFile(join(repo, ".harnessd", "config.toml"), "[skills.impeccable]\nenabled = false\n");
  await mkdir(join(repo, ".claude", "skills", "tdd"), { recursive: true });
  await writeFile(join(repo, ".claude", "skills", "tdd", "SKILL.md"), "hand-vendored\n");
  const { skipped } = await syncRepo({ repoDir: repo, globalDir });
  assert.deepEqual(skipped, [".claude/skills/tdd"]);
  for (const root of [".claude/skills", ".agents/skills"]) {
    assert.match(await readFile(join(repo, root, "domain-modeling", "LICENSE"), "utf8"), /MIT/);
    assert.ok((await readdir(join(repo, root, "code-review"))).length > 1);
    assert.match(
      await readFile(join(repo, root, "grill-with-docs", "SKILL.md"), "utf8"),
      /^disable-model-invocation: true$/m,
    );
    await assert.rejects(stat(join(repo, root, "impeccable")));
    await assert.rejects(stat(join(repo, root, "code-review", ".harnessd-pack")));
  }
  assert.equal(
    await readFile(join(repo, ".claude", "skills", "tdd", "SKILL.md"), "utf8"),
    "hand-vendored\n",
  );
  assert.ok((await stat(join(repo, ".agents", "skills", "tdd", "tests.md"))).isFile());
  assert.equal(
    JSON.parse(await readFile(join(repo, ".claude", "settings.json"), "utf8")).hooks,
    undefined,
  );
  await assert.rejects(stat(join(repo, ".codex", "hooks.json")));
  await assert.rejects(stat(join(repo, ".claude", "agents")));

  // A repo that keeps impeccable gets its design hook and its agents.
  const ui = join(root, "ui");
  await mkdir(join(ui, ".harnessd"), { recursive: true });
  await syncRepo({ repoDir: ui, globalDir });
  const settings = JSON.parse(await readFile(join(ui, ".claude", "settings.json"), "utf8"));
  assert.deepEqual(Object.keys(settings.hooks), ["SessionStart", "PostToolUse", "Stop"]);
  assert.match(settings.hooks.Stop[0].hooks[0].command, /impeccable" hook$/);
  const codex = JSON.parse(await readFile(join(ui, ".codex", "hooks.json"), "utf8"));
  assert.deepEqual(Object.keys(codex.hooks), ["PostToolUse", "Stop"]);
  const agents = await readdir(join(ui, ".claude", "agents"));
  assert.ok(agents.includes("impeccable-finish-reviewer.md"));
  assert.match(
    await readFile(join(ui, ".claude", "agents", "impeccable-finish-reviewer.md"), "utf8"),
    /^---\nname: impeccable-finish-reviewer\n[\s\S]*?\n---\n<!-- Generated by `harnessd sync`/,
  );

  // Self-hosting (MET-20): this repo's own .claude/ keeps its hooks and hand-installed agents.
  const self = join(root, "self");
  const repoRoot = join(import.meta.dirname, "../../..");
  await mkdir(join(self, ".harnessd"), { recursive: true });
  await cp(join(repoRoot, ".claude", "settings.json"), join(self, ".claude", "settings.json"));
  await cp(join(repoRoot, ".claude", "agents"), join(self, ".claude", "agents"), {
    recursive: true,
  });
  const before = JSON.parse(await readFile(join(self, ".claude", "settings.json"), "utf8"));
  const first = await syncRepo({ repoDir: self, globalDir });
  assert.ok(first.skipped.includes(".claude/agents/impeccable-finish-reviewer.md"));
  const after = JSON.parse(await readFile(join(self, ".claude", "settings.json"), "utf8"));
  assert.deepEqual(after.hooks, before.hooks);
  assert.equal(after.description, before.description);
  for (const name of await readdir(join(repoRoot, ".claude", "agents"))) {
    assert.equal(
      await readFile(join(self, ".claude", "agents", name), "utf8"),
      await readFile(join(repoRoot, ".claude", "agents", name), "utf8"),
    );
  }
  assert.deepEqual((await syncRepo({ repoDir: self, globalDir })).changed, []);
});
