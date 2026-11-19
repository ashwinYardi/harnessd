import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { VERSION } from "@harnessd/shared";

export {
  type ClaudeCodeOptions,
  claudeArgs,
  createClaudeCodeAdapter,
} from "./adapters/claude-code.ts";

export interface DaemonOptions {
  /** Port to listen on. 0 picks a free port. */
  port?: number;
  host?: string;
}

export interface Daemon {
  url: string;
  close(): Promise<void>;
}

/** Starts the harnessd HTTP server. v0.1 skeleton: only /health. */
export async function startDaemon(options: DaemonOptions = {}): Promise<Daemon> {
  const host = options.host ?? "127.0.0.1";
  const server: Server = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, version: VERSION }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, host, resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://${host}:${port}`,
    close: () => new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

export * from "./config/load.ts";
export * from "./config/merge.ts";
