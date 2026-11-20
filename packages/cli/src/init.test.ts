import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { loadConfig } from "@harnessd/daemon";
import { run } from "./index.ts";
import {
  CONFIG_TEMPLATE,
  type ExecResult,
  type InitSystem,
  LAUNCHD_LABEL,
  parseInitArgs,
  renderPlist,
  runInit,
} from "./init.ts";

const HOME = "/Users/ada";
const PLIST = `${HOME}/Library/LaunchAgents/dev.harnessd.daemon.plist`;
const CONFIG = `${HOME}/.harnessd/config.toml`;
const REPO = `${HOME}/code/app`;
const BIN = "/opt/homebrew/bin";

interface FakeOptions {
  platform?: NodeJS.Platform;
  /** Binaries already in /opt/homebrew/bin. npm is always there. */
  installed?: string[];
  files?: Record<string, string>;
  confirm?: boolean;
  /** Labels launchd has loaded. */
  loaded?: boolean;
  failInstall?: string;
}

/** An in-memory Mac (or Linux box): files in a map, commands recorded, npm and launchctl faked. */
function fake(o: FakeOptions = {}) {
  const files = new Map<string, string>(Object.entries(o.files ?? {}));
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
    fs: {
      read: async (p) => files.get(p),
      write: async (p, d) => {
        files.set(p, d);
      },
      mkdirp: async () => {},
      exists: async (p) => files.has(p) || p === `${REPO}/.git`,
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
  assert.equal(f.files.get(CONFIG), CONFIG_TEMPLATE);
  assert.ok(f.out.includes(`config: wrote ${CONFIG}`));
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
  assert.equal(f.files.get(CONFIG), "[linear]\nteam_id = 'MET'\n");
  assert.ok(f.out.includes(`config: kept existing ${CONFIG}`));
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
  assert.equal(f.files.get(CONFIG), CONFIG_TEMPLATE);
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

test("the config template loads as a valid, empty global config", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harnessd-cli-init-"));
  roots.push(dir);
  await writeFile(join(dir, "config.toml"), CONFIG_TEMPLATE);
  const config = await loadConfig({ globalDir: dir, workspaceDir: join(dir, "none") });
  assert.equal(config.linear.team_id, undefined);
});
