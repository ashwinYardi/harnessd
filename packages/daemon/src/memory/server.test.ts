import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { after, test } from "node:test";
import { VERSION } from "@harnessd/shared";
import { handleMessage, type MEMORY_TOOLS, serveMemory } from "./server.ts";
import type { Vaults } from "./vault.ts";

const roots: string[] = [];
after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function vaults(): Promise<Vaults> {
  const root = await mkdtemp(join(tmpdir(), "harnessd-mcp-"));
  roots.push(root);
  return { global: join(root, "global"), workspace: join(root, "workspace") };
}

let nextId = 1;
async function call(v: Vaults, method: string, params?: unknown) {
  const response = await handleMessage(v, { jsonrpc: "2.0", id: nextId++, method, params });
  assert.ok(response);
  return response;
}

async function tool(v: Vaults, name: string, args: Record<string, unknown>) {
  const { result, error } = await call(v, "tools/call", { name, arguments: args });
  assert.equal(error, undefined);
  const r = result as { content: { type: string; text: string }[]; isError?: boolean };
  assert.equal(r.content[0]?.type, "text");
  const text = r.content[0]?.text ?? "";
  return { isError: r.isError === true, text, json: r.isError ? undefined : JSON.parse(text) };
}

test("initialize negotiates the protocol version and advertises tools", async () => {
  const v = await vaults();
  const { result } = await call(v, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  });
  assert.deepEqual((result as Record<string, unknown>).protocolVersion, "2025-06-18");
  assert.deepEqual((result as Record<string, unknown>).capabilities, { tools: {} });
  assert.deepEqual((result as Record<string, unknown>).serverInfo, {
    name: "harnessd-memory",
    version: VERSION,
  });
  const future = await call(v, "initialize", { protocolVersion: "2099-01-01" });
  assert.equal((future.result as Record<string, unknown>).protocolVersion, "2025-11-25");
  assert.equal(
    await handleMessage(v, { jsonrpc: "2.0", method: "notifications/initialized" }),
    undefined,
  );
  assert.deepEqual((await call(v, "ping")).result, {});
});

test("tools/list returns search_notes, read_note and write_note with schemas", async () => {
  const { result } = await call(await vaults(), "tools/list");
  const tools = (result as { tools: typeof MEMORY_TOOLS }).tools;
  assert.deepEqual(
    tools.map((t) => t.name),
    ["search_notes", "read_note", "write_note"],
  );
  for (const t of tools) assert.equal(t.inputSchema.type, "object");
});

test("tools/call writes, reads and searches per scope, workspace by default", async () => {
  const v = await vaults();
  const w = await tool(v, "write_note", {
    path: "notes/build",
    content: "Run pnpm build first.",
    frontmatter: { tags: ["ci"] },
  });
  assert.deepEqual(w.json, { scope: "workspace", path: "notes/build.md", written: true });
  assert.equal(
    await readFile(join(v.workspace ?? "", "notes/build.md"), "utf8"),
    "---\ntags:\n  - ci\n---\n\nRun pnpm build first.\n",
  );
  await tool(v, "write_note", { path: "prefs", content: "Prefer pnpm.", scope: "global" });

  const r = await tool(v, "read_note", { path: "notes/build.md" });
  assert.equal(r.json.path, "notes/build.md");
  assert.match(r.json.content, /Run pnpm build first/);

  const s = await tool(v, "search_notes", { query: "PNPM" });
  assert.deepEqual(
    s.json.results.map((h: { path: string }) => h.path),
    ["notes/build.md"],
  );
  const g = await tool(v, "search_notes", { query: "pnpm", scope: "global" });
  assert.deepEqual(
    g.json.results.map((h: { path: string }) => h.path),
    ["prefs.md"],
  );
});

test("tool errors come back as isError results", async () => {
  const v = await vaults();
  const traversal = await tool(v, "read_note", { path: "../../etc/passwd" });
  assert.ok(traversal.isError);
  assert.match(traversal.text, /invalid note path/);
  assert.ok((await tool(v, "write_note", { path: "/abs", content: "x" })).isError);
  assert.ok((await tool(v, "read_note", { path: "missing" })).isError);
  assert.ok((await tool(v, "search_notes", { query: "x", scope: "team" })).isError);
  assert.ok((await tool(v, "search_notes", { query: "x", limit: 0 })).isError);
  const noWorkspace = await tool({ global: v.global }, "read_note", { path: "a" });
  assert.match(noWorkspace.text, /no workspace vault/);
});

test("protocol errors use JSON-RPC codes", async () => {
  const v = await vaults();
  assert.equal((await call(v, "resources/list")).error?.code, -32601);
  assert.equal((await call(v, "tools/call", { name: "rm_rf", arguments: {} })).error?.code, -32602);
  assert.equal((await handleMessage(v, { id: 1, method: "ping" }))?.error?.code, -32600);
});

test("serveMemory speaks newline-delimited JSON-RPC over streams", async () => {
  const v = await vaults();
  const input = new PassThrough();
  const output = new PassThrough();
  const done = serveMemory({ vaults: v, input, output });
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
  input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  input.write("not json\n\n");
  input.end(`${JSON.stringify({ jsonrpc: "2.0", id: "two", method: "ping" })}\n`);
  await done;
  const lines = output
    .read()
    .toString()
    .trim()
    .split("\n")
    .map((l: string) => JSON.parse(l));
  assert.equal(lines.length, 3);
  assert.equal(lines[0].id, 1);
  assert.equal(lines[1].error.code, -32700);
  assert.deepEqual(lines[2], { jsonrpc: "2.0", id: "two", result: {} });
});
