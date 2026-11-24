#!/usr/bin/env node
// qa-browser drives the headless browser the daemon starts for a web QA review (MET-179,
// D-051). It never launches a browser: the daemon owns the lifecycle and passes the CDP
// endpoint in HARNESSD_QA_BROWSER. Each command connects, acts on the page the last command
// left open, then disconnects, so the page survives between shell calls. One JSON object
// goes to stdout, `{ ok, command, result | error }`, and the exit code is 0 or 1.
//
// Screenshots are written under `<HARNESSD_HOME>/qa/<run id>/`, and the JSON returns the
// path relative to HARNESSD_HOME so no local path reaches a public review.
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { chromium, type Page } from "playwright-core";

/** The commands QA may run. */
export const QA_BROWSER_COMMANDS = [
  "open",
  "click",
  "type",
  "text",
  "check",
  "screenshot",
] as const;
export type QaBrowserCommand = (typeof QA_BROWSER_COMMANDS)[number];

export const DEFAULT_WIDTH = 1280;
export const DEFAULT_HEIGHT = 800;

export interface QaBrowserIo {
  /** Writes one line; the CLI writes it to stdout. */
  out: (line: string) => void;
}

export interface QaBrowserDeps {
  /** The daemon's environment; default `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Where `check` reads its file; default `process.cwd()`. */
  cwd?: string;
  /** Where screenshots go; default `$HARNESSD_HOME`, then `~/.harnessd`. */
  home?: string;
  /** Connects to the running browser; a test injects one. */
  connect?: (endpoint: string) => Promise<ConnectedPage>;
}

interface ConnectedPage {
  page: Page;
  close: () => Promise<void>;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isCommand(value: string): value is QaBrowserCommand {
  return (QA_BROWSER_COMMANDS as readonly string[]).includes(value);
}

/** One validated command, ready to run once the browser connection exists. */
type Action =
  | { kind: "open"; url: string; width: number; height: number }
  | { kind: "click"; selector: string }
  | { kind: "type"; selector: string; text: string }
  | { kind: "text"; selector: string }
  | { kind: "check"; file: string }
  | { kind: "screenshot"; name: string };

function require(args: readonly string[], index: number, what: string): string {
  const value = args[index];
  if (value === undefined || value === "") throw new Error(`missing ${what}`);
  return value;
}

function viewport(value: string | undefined, flag: string): number {
  const number = Number(value);
  if (value === undefined || !Number.isInteger(number) || number <= 0) {
    throw new Error(`${flag} expects a positive integer`);
  }
  return number;
}

/** Parses the arguments of a known command. Pure, so a bad call never connects first. */
export function parseQaBrowserArgs(command: QaBrowserCommand, args: readonly string[]): Action {
  if (command === "open") {
    let url: string | undefined;
    let width = DEFAULT_WIDTH;
    let height = DEFAULT_HEIGHT;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i] ?? "";
      if (arg === "--width") {
        width = viewport(args[++i], "--width");
      } else if (arg === "--height") {
        height = viewport(args[++i], "--height");
      } else if (arg.startsWith("--")) {
        throw new Error(`unknown option ${arg}`);
      } else if (url === undefined) {
        url = arg;
      } else {
        throw new Error(`expected one url, got ${JSON.stringify(url)} and ${JSON.stringify(arg)}`);
      }
    }
    if (url === undefined || url === "") throw new Error("missing url");
    try {
      new URL(url);
    } catch {
      throw new Error(`not a url: ${JSON.stringify(url)}`);
    }
    return { kind: "open", url, width, height };
  }
  if (command === "click") return { kind: "click", selector: require(args, 0, "selector") };
  if (command === "type") {
    return {
      kind: "type",
      selector: require(args, 0, "selector"),
      text: require(args, 1, "text"),
    };
  }
  if (command === "text") return { kind: "text", selector: require(args, 0, "selector") };
  if (command === "check") return { kind: "check", file: require(args, 0, "file") };
  return { kind: "screenshot", name: require(args, 0, "name") };
}

/** A safe path segment: letters, digits, dot, dash and underscore. */
function segment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "");
  return cleaned === "" ? "run" : cleaned;
}

/** `<HARNESSD_HOME>` for screenshots; the daemon's default when it is not set. */
export function qaHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.HARNESSD_HOME?.trim();
  return override ? resolve(override) : join(homedir(), ".harnessd");
}

/** The path a screenshot is written to, relative to HARNESSD_HOME, with `/` separators. */
export function screenshotPath(
  name: string,
  runId: string,
  env: NodeJS.ProcessEnv = process.env,
): { absolute: string; relative: string } {
  const run = segment(runId);
  const raw = segment(name);
  const file = raw.endsWith(".png") ? raw : `${raw}.png`;
  const relative = `qa/${run}/${file}`;
  return { absolute: join(qaHome(env), "qa", run, file), relative };
}

/** Connects over CDP and returns the page the previous command left open. */
async function connectPage(endpoint: string): Promise<ConnectedPage> {
  const browser = await chromium.connectOverCDP(endpoint);
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = context.pages()[0] ?? (await context.newPage());
  // A connected browser keeps running: close() only drops this connection (docs, Browser.close).
  return { page, close: () => browser.close() };
}

async function perform(action: Action, page: Page, deps: QaBrowserDeps): Promise<unknown> {
  const env = deps.env ?? process.env;
  if (action.kind === "open") {
    await page.setViewportSize({ width: action.width, height: action.height });
    await page.goto(action.url);
    return { url: page.url(), width: action.width, height: action.height };
  }
  if (action.kind === "click") {
    await page.locator(action.selector).click();
    return true;
  }
  if (action.kind === "type") {
    await page.locator(action.selector).fill(action.text);
    return true;
  }
  if (action.kind === "text") return (await page.textContent(action.selector)) ?? "";
  if (action.kind === "check") {
    const source = await readFile(resolve(deps.cwd ?? process.cwd(), action.file), "utf8");
    // A file may hold an expression (`document.title`) or a function (`() => …`).
    const expression =
      "(async () => { const value = (" +
      source +
      '); return typeof value === "function" ? await value() : value; })()';
    return await page.evaluate(expression);
  }
  const runId = env.HARNESSD_QA_RUN?.trim() || "run";
  const target = screenshotPath(action.name, runId, env);
  await mkdir(dirname(target.absolute), { recursive: true });
  await page.screenshot({ path: target.absolute });
  return target.relative;
}

/**
 * Runs one command and prints one JSON object. The return value is the exit code, so a
 * caller can set `process.exitCode` without the process exiting before stdout flushes.
 */
export async function runQaBrowser(
  argv: readonly string[],
  io: QaBrowserIo,
  deps: QaBrowserDeps = {},
): Promise<number> {
  const command = argv[0] ?? "";
  try {
    if (!isCommand(command)) {
      throw new Error(
        command === ""
          ? `missing command; expected one of ${QA_BROWSER_COMMANDS.join(", ")}`
          : `unknown command ${JSON.stringify(command)}; expected one of ${QA_BROWSER_COMMANDS.join(", ")}`,
      );
    }
    const action = parseQaBrowserArgs(command, argv.slice(1));
    const endpoint =
      deps.env?.HARNESSD_QA_BROWSER?.trim() ?? process.env.HARNESSD_QA_BROWSER?.trim();
    if (endpoint === undefined || endpoint === "") {
      throw new Error(
        "HARNESSD_QA_BROWSER is not set; harnessd sets it for a live web review. " +
          "If the browser step failed, read the QA setup error.",
      );
    }
    const connected = await (deps.connect ?? connectPage)(endpoint);
    try {
      const result = await perform(action, connected.page, deps);
      io.out(JSON.stringify({ ok: true, command, result: result ?? null }));
      return 0;
    } finally {
      await connected.close().catch(() => {});
    }
  } catch (error) {
    io.out(JSON.stringify({ ok: false, command, error: message(error) }));
    return 1;
  }
}

const consoleIo: QaBrowserIo = { out: (line) => process.stdout.write(`${line}\n`) };

if (import.meta.main) {
  process.exitCode = await runQaBrowser(process.argv.slice(2), consoleIo);
}
