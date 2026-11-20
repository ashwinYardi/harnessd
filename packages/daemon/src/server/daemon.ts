// The daemon's local HTTP server: /health and the JSON API. See docs/API.md.
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { VERSION } from "@harnessd/shared";
import { cleanReason, type PauseControl } from "../control/pause.ts";
import { createRouter, HttpError, type Route } from "./router.ts";

/** The only address the daemon listens on: the API has no auth, so it never leaves the machine. */
export const DAEMON_HOST = "127.0.0.1";

export interface DaemonOptions {
  /** Port to listen on. 0 picks a free port. */
  port?: number;
  /** Serves the pause routes. Without it they are 404. */
  pause?: PauseControl;
  /** More routes, such as the UI's (MET-18, `uiRoutes` and `staticRoutes`). */
  routes?: Route[];
}

export interface Daemon {
  url: string;
  close(): Promise<void>;
}

/** Reads `{ reason? }` from a POST /api/pause body. */
export function parsePauseBody(body: unknown): string | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "invalid_body", "expected a JSON object");
  }
  const { reason, ...rest } = body as Record<string, unknown>;
  const extra = Object.keys(rest);
  if (extra.length > 0) throw new HttpError(400, "invalid_body", `unknown key ${extra[0]}`);
  if (reason !== undefined && typeof reason !== "string") {
    throw new HttpError(400, "invalid_body", "reason must be a string");
  }
  return cleanReason(reason);
}

/** GET /api/pause, POST /api/pause and POST /api/resume. */
export function pauseRoutes(control: PauseControl): Route[] {
  return [
    { method: "GET", path: "/api/pause", handler: () => control.status() },
    {
      method: "POST",
      path: "/api/pause",
      handler: ({ body }) => control.pause(parsePauseBody(body)),
    },
    { method: "POST", path: "/api/resume", handler: () => control.resume() },
  ];
}

/** Starts the harnessd HTTP server on 127.0.0.1. */
export async function startDaemon(options: DaemonOptions = {}): Promise<Daemon> {
  const routes: Route[] = [
    { method: "GET", path: "/health", handler: () => ({ ok: true, version: VERSION }) },
    ...(options.pause ? pauseRoutes(options.pause) : []),
    ...(options.routes ?? []),
  ];
  const streams = new Set<ServerResponse>();
  const server: Server = createServer(createRouter(routes, { streams }));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, DAEMON_HOST, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://${DAEMON_HOST}:${port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((e) => (e ? reject(e) : resolve()));
        // Event streams never go idle: end them, or the close waits forever.
        for (const res of streams) res.end();
        server.closeIdleConnections();
      }),
  };
}
