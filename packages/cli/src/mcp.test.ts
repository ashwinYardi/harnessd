import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { after, test } from "node:test";
import { run } from "./index.ts";

const BIN = join(import.meta.dirname, "bin.ts");

const roots: string[] = [];
after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

test("harnessd mcp memory round-trips MCP over stdio as a real process", async () => {
  const root = await mkdtemp(join(tmpdir(), "harnessd-cli-mcp-"));
  roots.push(root);
  const repo = join(root, "repo");
  const globalDir = join(root, "global");
  await mkdir(join(repo, ".harnessd"), { recursive: true });
  await mkdir(join(repo, "src"), { recursive: true });

  // Started from a subfolder: the workspace vault is found by walking up.
  const child = spawn(process.execPath, [BIN, "mcp", "memory"], {
    cwd: join(repo, "src"),
    env: { ...process.env, HARNESSD_HOME: globalDir },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d) => {
    stderr += d;
  });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  let id = 0;
  async function request(method: string, params?: unknown) {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params })}\n`);
    const { value } = await lines.next();
    const response = JSON.parse(String(value));
    assert.equal(response.id, id);
    return response;
  }
  const text = (response: { result: { content: { text: string }[] } }) =>
    JSON.parse(response.result.content[0]?.text ?? "");

  const init = await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "0" },
  });
  assert.equal(init.result.serverInfo.name, "harnessd-memory");
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  const list = await request("tools/list");
  assert.deepEqual(
    list.result.tools.map((t: { name: string }) => t.name),
    ["search_notes", "read_note", "write_note"],
  );

  await request("tools/call", {
    name: "write_note",
    arguments: { path: "repo-fact", content: "The repo uses turbo." },
  });
  await request("tools/call", {
    name: "write_note",
    arguments: { path: "me", content: "I like turbo too.", scope: "global" },
  });
  const read = await request("tools/call", { name: "read_note", arguments: { path: "repo-fact" } });
  assert.equal(text(read).content, "The repo uses turbo.\n");
  const search = await request("tools/call", {
    name: "search_notes",
    arguments: { query: "turbo", scope: "global" },
  });
  assert.equal(text(search).results[0].path, "me.md");
  assert.deepEqual((await request("ping")).result, {});

  child.stdin.end();
  const code = await new Promise((resolve) => child.on("exit", resolve));
  assert.equal(code, 0, stderr);
  assert.equal(stderr, "");
  assert.equal(
    await readFile(join(repo, ".harnessd", "vault", "repo-fact.md"), "utf8"),
    "The repo uses turbo.\n",
  );
  assert.equal(await readFile(join(globalDir, "vault", "me.md"), "utf8"), "I like turbo too.\n");
});

test("harnessd mcp with a bad server name prints usage and exits 2", async () => {
  const err: string[] = [];
  assert.equal(await run(["mcp", "nope"], { out: () => {}, err: (l) => err.push(l) }), 2);
  assert.match(err[0] ?? "", /Usage: harnessd mcp memory/);
  const io = { out: () => {}, err: () => {} };
  assert.equal(await run(["mcp", "nope", "--workspace", "."], io), 2);
  assert.equal(await run(["mcp", "memory", "--wrkspace", "."], io), 2);
});
