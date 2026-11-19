// A minimal MCP server over stdio, hand-rolled (no SDK, D-002): newline-delimited
// JSON-RPC 2.0 with initialize, notifications/initialized, ping, tools/list and tools/call.
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { VERSION } from "@harnessd/shared";
import {
  type FrontmatterValue,
  readNote,
  searchNotes,
  VaultError,
  type VaultScope,
  type Vaults,
  writeNote,
} from "./vault.ts";

export const MEMORY_SERVER_NAME = "harnessd-memory";

/** Newest first. A client asking for one of these gets it back; anything else gets the first. */
export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

type Id = string | number | null;

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: Id;
  result?: unknown;
  error?: { code: number; message: string };
}

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

const scopeSchema = {
  type: "string",
  enum: ["global", "workspace"],
  default: "workspace",
  description:
    "global: ~/.harnessd/vault, shared by every repo. workspace: this repo's .harnessd/vault.",
};

export const MEMORY_TOOLS = [
  {
    name: "search_notes",
    description:
      "Search memory notes by title and text (case-insensitive). Returns the best matches with snippets.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words or a phrase to look for." },
        scope: scopeSchema,
        limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "read_note",
    description: "Read one memory note, frontmatter included.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Vault-relative path, such as decisions/MET-7-sync. .md is optional.",
        },
        scope: scopeSchema,
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "write_note",
    description:
      "Create or overwrite a memory note at <path>.md (Obsidian-compatible markdown), with optional YAML frontmatter.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Vault-relative path, such as notes/build. .md is optional.",
        },
        content: { type: "string", description: "Markdown body." },
        frontmatter: {
          type: "object",
          description: "Optional YAML frontmatter: string, number, boolean or string-list values.",
          additionalProperties: {
            anyOf: [
              { type: "string" },
              { type: "number" },
              { type: "boolean" },
              { type: "array", items: { type: "string" } },
            ],
          },
        },
        scope: scopeSchema,
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
];

class ParamsError extends Error {}

type Args = Record<string, unknown>;

function vaultFor(vaults: Vaults, args: Args): string {
  const scope = args.scope ?? "workspace";
  if (scope !== "global" && scope !== "workspace") {
    throw new VaultError(`scope must be "global" or "workspace", got ${JSON.stringify(scope)}`);
  }
  const dir = vaults[scope as VaultScope];
  if (dir === undefined) {
    throw new VaultError(
      'no workspace vault: start the server inside a repo with .harnessd/, or use scope "global"',
    );
  }
  return dir;
}

function stringArg(args: Args, key: string): string {
  const value = args[key];
  if (typeof value !== "string") throw new VaultError(`${key} must be a string`);
  return value;
}

async function callTool(vaults: Vaults, name: string, args: Args): Promise<unknown> {
  switch (name) {
    case "search_notes": {
      const limit = args.limit ?? 10;
      if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 50) {
        throw new VaultError("limit must be an integer from 1 to 50");
      }
      const scope = args.scope ?? "workspace";
      const results = await searchNotes(vaultFor(vaults, args), stringArg(args, "query"), limit);
      return { scope, results };
    }
    case "read_note":
      return {
        scope: args.scope ?? "workspace",
        ...(await readNote(vaultFor(vaults, args), stringArg(args, "path"))),
      };
    case "write_note": {
      const fm = args.frontmatter;
      if (fm !== undefined && (typeof fm !== "object" || fm === null || Array.isArray(fm))) {
        throw new VaultError("frontmatter must be an object");
      }
      const path = await writeNote(
        vaultFor(vaults, args),
        stringArg(args, "path"),
        stringArg(args, "content"),
        fm as Record<string, FrontmatterValue> | undefined,
      );
      return { scope: args.scope ?? "workspace", path, written: true };
    }
    default:
      throw new ParamsError(`unknown tool ${JSON.stringify(name)}`);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Handles one decoded JSON-RPC message. Returns the response, or undefined for
 * notifications. Tool failures (bad path, missing note) come back as
 * `isError: true` results, as MCP asks, so the model can read and recover.
 */
export async function handleMessage(
  vaults: Vaults,
  message: unknown,
): Promise<JsonRpcResponse | undefined> {
  if (!isObject(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    const id =
      isObject(message) && (typeof message.id === "string" || typeof message.id === "number")
        ? message.id
        : null;
    return {
      jsonrpc: "2.0",
      id,
      error: { code: INVALID_REQUEST, message: "invalid JSON-RPC 2.0 request" },
    };
  }
  if (!("id" in message)) return undefined; // notification: initialized, cancelled, ...
  const id = message.id as Id;
  const params = isObject(message.params) ? message.params : {};
  const ok = (result: unknown): JsonRpcResponse => ({ jsonrpc: "2.0", id, result });
  const fail = (code: number, msg: string): JsonRpcResponse => ({
    jsonrpc: "2.0",
    id,
    error: { code, message: msg },
  });

  switch (message.method) {
    case "initialize": {
      const asked = params.protocolVersion;
      const protocolVersion =
        typeof asked === "string" && PROTOCOL_VERSIONS.includes(asked)
          ? asked
          : PROTOCOL_VERSIONS[0];
      return ok({
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: MEMORY_SERVER_NAME, version: VERSION },
        instructions:
          "Long-term memory as markdown notes. Search before deciding; write down decisions and facts worth keeping.",
      });
    }
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: MEMORY_TOOLS });
    case "tools/call": {
      const name = params.name;
      if (typeof name !== "string") return fail(INVALID_PARAMS, "tools/call needs a tool name");
      const args = isObject(params.arguments) ? params.arguments : {};
      try {
        const result = await callTool(vaults, name, args);
        return ok({ content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
      } catch (e) {
        if (e instanceof ParamsError) return fail(INVALID_PARAMS, e.message);
        if (e instanceof VaultError)
          return ok({ content: [{ type: "text", text: e.message }], isError: true });
        return fail(INTERNAL_ERROR, (e as Error).message);
      }
    }
    default:
      return fail(METHOD_NOT_FOUND, `method not found: ${message.method}`);
  }
}

export interface ServeOptions {
  vaults: Vaults;
  input: Readable;
  output: Writable;
}

/** Serves MCP over newline-delimited JSON until `input` ends. Responses keep request order. */
export async function serveMemory(options: ServeOptions): Promise<void> {
  const lines = createInterface({ input: options.input, crlfDelay: Number.POSITIVE_INFINITY });
  for await (const line of lines) {
    if (line.trim() === "") continue;
    let message: unknown;
    let response: JsonRpcResponse | undefined;
    try {
      message = JSON.parse(line);
    } catch {
      response = { jsonrpc: "2.0", id: null, error: { code: PARSE_ERROR, message: "parse error" } };
    }
    if (response === undefined) {
      try {
        response = await handleMessage(options.vaults, message);
      } catch (e) {
        const id = isObject(message) && "id" in message ? (message.id as Id) : null;
        const error = { code: INTERNAL_ERROR, message: (e as Error).message };
        response = { jsonrpc: "2.0", id, error };
      }
    }
    if (response !== undefined) options.output.write(`${JSON.stringify(response)}\n`);
  }
}
