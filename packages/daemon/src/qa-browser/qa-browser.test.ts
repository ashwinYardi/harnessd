import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Page } from "playwright-core";
import {
  parseQaBrowserArgs,
  parseViewport,
  runQaBrowser,
  screenshotPath,
  viewportPath,
} from "./qa-browser.ts";

/** Captures the one stdout line the CLI writes. */
function capture(): { lines: string[]; io: { out: (line: string) => void } } {
  const lines: string[] = [];
  return { lines, io: { out: (line: string) => lines.push(line) } };
}

/** The single JSON object a command printed. */
function one(lines: string[]): Record<string, unknown> {
  assert.equal(lines.length, 1, "one JSON line");
  const value: unknown = JSON.parse(lines[0] ?? "");
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}

/** The built bin a package manager links; build it once when a plain test run has no dist. */
function builtScript(): string {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const script = join(root, "dist", "qa-browser", "qa-browser.js");
  if (!existsSync(script)) {
    const built = spawnSync("pnpm", ["run", "build"], { cwd: root, encoding: "utf8" });
    assert.equal(built.status, 0, `build failed: ${built.stderr || built.stdout}`);
  }
  return script;
}

test("an unknown command prints one JSON error and exits 1", async () => {
  const { lines, io } = capture();
  const code = await runQaBrowser(["nope"], io, {
    env: { HARNESSD_QA_BROWSER: "http://127.0.0.1:1" },
  });
  assert.equal(code, 1);
  const payload = one(lines);
  assert.equal(payload.ok, false);
  assert.equal(payload.command, "nope");
  assert.match(String(payload.error), /unknown command "nope"/);
  assert.equal("result" in payload, false);
});

test("a missing argument prints one JSON error and exits 1", async () => {
  const { lines, io } = capture();
  const code = await runQaBrowser(["click"], io, {
    env: { HARNESSD_QA_BROWSER: "http://127.0.0.1:1" },
  });
  assert.equal(code, 1);
  const payload = one(lines);
  assert.equal(payload.ok, false);
  assert.equal(payload.command, "click");
  assert.match(String(payload.error), /missing selector/);
});

test("no HARNESSD_QA_BROWSER names the variable in one JSON error", async () => {
  const { lines, io } = capture();
  const code = await runQaBrowser(["open", "http://127.0.0.1:3000"], io, { env: {} });
  assert.equal(code, 1);
  const payload = one(lines);
  assert.equal(payload.ok, false);
  assert.equal(payload.command, "open");
  assert.match(String(payload.error), /HARNESSD_QA_BROWSER is not set/);
});

test("the script itself exits 1 with one JSON line for an unknown command", () => {
  const script = fileURLToPath(new URL("./qa-browser.ts", import.meta.url));
  const result = spawnSync(process.execPath, [script, "nope"], {
    encoding: "utf8",
    env: { ...process.env, HARNESSD_QA_BROWSER: "" },
  });
  assert.equal(result.status, 1);
  const lines = result.stdout
    .trim()
    .split("\n")
    .filter((line) => line !== "");
  const payload = one(lines);
  assert.equal(payload.ok, false);
  assert.equal(payload.command, "nope");
});

test("the built script through a bin symlink exits 1 with one JSON line", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harnessd-qa-browser-bin-"));
  try {
    const link = join(dir, "qa-browser");
    await symlink(builtScript(), link);
    const result = spawnSync(process.execPath, [link, "nope"], {
      encoding: "utf8",
      env: { ...process.env, HARNESSD_QA_BROWSER: "" },
    });
    assert.equal(result.status, 1, result.stderr);
    const lines = result.stdout
      .trim()
      .split("\n")
      .filter((line) => line !== "");
    const payload = one(lines);
    assert.equal(payload.ok, false);
    assert.equal(payload.command, "nope");
    assert.match(String(payload.error), /unknown command "nope"/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("open takes a url, a width and a height, and defaults to 1280x800", () => {
  assert.deepEqual(parseQaBrowserArgs("open", ["http://127.0.0.1:3000"]), {
    kind: "open",
    url: "http://127.0.0.1:3000",
    width: 1280,
    height: 800,
  });
  assert.deepEqual(
    parseQaBrowserArgs("open", ["http://x.test", "--width", "390", "--height", "844"]),
    { kind: "open", url: "http://x.test", width: 390, height: 844 },
  );
  assert.throws(() => parseQaBrowserArgs("open", ["--width", "0", "http://x"]), /--width/);
  assert.throws(() => parseQaBrowserArgs("open", ["--depth", "1", "http://x"]), /unknown option/);
  assert.throws(() => parseQaBrowserArgs("open", ["not a url"]), /not a url/);
});

test("click, type, text, check and screenshot take their arguments", () => {
  assert.deepEqual(parseQaBrowserArgs("click", ["#go"]), { kind: "click", selector: "#go" });
  assert.deepEqual(parseQaBrowserArgs("type", ["#name", "Ada Lovelace"]), {
    kind: "type",
    selector: "#name",
    text: "Ada Lovelace",
  });
  assert.deepEqual(parseQaBrowserArgs("text", ["h1"]), { kind: "text", selector: "h1" });
  assert.deepEqual(parseQaBrowserArgs("check", ["checks/title.js"]), {
    kind: "check",
    file: "checks/title.js",
  });
  assert.deepEqual(parseQaBrowserArgs("screenshot", ["home"]), {
    kind: "screenshot",
    name: "home",
  });
  assert.throws(() => parseQaBrowserArgs("type", ["#name"]), /missing text/);
});

test("open saves the viewport and every later command restores it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harnessd-qa-browser-viewport-"));
  try {
    const env = {
      HARNESSD_QA_BROWSER: "http://127.0.0.1:1",
      HARNESSD_HOME: dir,
      HARNESSD_QA_RUN: "MET-53-qa-1-pr7",
    };
    const sizes: string[] = [];
    const page = {
      setViewportSize: async ({ width, height }: { width: number; height: number }) => {
        sizes.push(`${width}x${height}`);
      },
      goto: async () => {},
      url: () => "http://app.test/",
      textContent: async () => "hello",
    } as unknown as Page;
    const deps = {
      env,
      connect: async () => ({ page, close: async () => {} }),
    };
    const { lines, io } = capture();

    assert.equal(
      await runQaBrowser(
        ["open", "http://app.test", "--width", "390", "--height", "844"],
        io,
        deps,
      ),
      0,
    );
    assert.deepEqual(JSON.parse(await readFile(viewportPath("MET-53-qa-1-pr7", env), "utf8")), {
      width: 390,
      height: 844,
    });
    assert.equal(await runQaBrowser(["text", "h1"], io, deps), 0);
    assert.deepEqual(sizes, ["390x844", "390x844"], "the later command restores the open size");

    assert.equal(
      await runQaBrowser(
        ["open", "http://app.test", "--width", "1280", "--height", "800"],
        io,
        deps,
      ),
      0,
    );
    assert.equal(await runQaBrowser(["text", "h1"], io, deps), 0);
    assert.deepEqual(sizes, ["390x844", "390x844", "1280x800", "1280x800"]);
    assert.equal(one(lines.slice(-1)).result, "hello");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a malformed saved viewport is ignored", () => {
  assert.equal(parseViewport(undefined), undefined);
  assert.equal(parseViewport({ width: 0, height: 800 }), undefined);
  assert.equal(parseViewport({ width: 390, height: "844" }), undefined);
  assert.deepEqual(parseViewport({ width: 390, height: 844 }), { width: 390, height: 844 });
});

test("a screenshot path is relative to HARNESSD_HOME and safe", () => {
  const target = screenshotPath("Home page", "MET-53-qa-1-pr7", { HARNESSD_HOME: "/tmp/home" });
  assert.equal(target.relative, "qa/MET-53-qa-1-pr7/Home_page.png");
  assert.equal(target.absolute, "/tmp/home/qa/MET-53-qa-1-pr7/Home_page.png");
  const png = screenshotPath("done.png", "../run");
  assert.equal(png.relative.endsWith("/done.png"), true);
  assert.doesNotMatch(png.relative, /\.\./);
});
