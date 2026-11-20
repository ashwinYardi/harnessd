// A small JSON router for the daemon's local HTTP API. See docs/API.md.
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";

export type HttpMethod = "GET" | "POST";

export interface ApiRequest {
  method: HttpMethod;
  /** The path without the query string. */
  path: string;
  /** Parsed JSON body; undefined when there is none. */
  body: unknown;
}

export interface Route {
  method: HttpMethod;
  path: string;
  /**
   * Returns the JSON body of a 200, a RawBody or an EventStream; throws HttpError for
   * anything else.
   */
  handler: (request: ApiRequest) => unknown;
}

/** A 200 that is not JSON: a file of the built UI (D-020). */
export class RawBody {
  readonly contentType: string;
  readonly body: string | Uint8Array;
  readonly headers: Record<string, string>;

  constructor(
    contentType: string,
    body: string | Uint8Array,
    headers: Record<string, string> = {},
  ) {
    this.contentType = contentType;
    this.body = body;
    this.headers = headers;
  }
}

/** Sends one server-sent event. `data` goes out as one line of JSON. */
export type SendEvent = (event: string, data: unknown) => void;

/**
 * A 200 that stays open as server-sent events (D-020). `open` starts sending and returns
 * the function that stops it, called when the client goes or the server closes.
 */
export class EventStream {
  readonly open: (send: SendEvent) => () => void;

  constructor(open: (send: SendEvent) => () => void) {
    this.open = open;
  }
}

/** A comment line on every open stream at this interval keeps proxies and clients awake. */
export const STREAM_HEARTBEAT_MS = 15_000;

/** An error the API reports as `{ error: code, message }` with this status. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string = code) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

/** Largest request body read, in bytes. */
export const MAX_BODY_BYTES = 64 * 1024;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * The route for a method and path. A path with no route is 404; a known path with
 * another method is 405, with the allowed methods.
 */
export function matchRoute(
  routes: readonly Route[],
  method: string,
  path: string,
): Route | HttpError {
  const onPath = routes.filter((r) => r.path === path);
  if (onPath.length === 0) return new HttpError(404, "not_found", `no route for ${path}`);
  const route = onPath.find((r) => r.method === method);
  if (route) return route;
  const allow = onPath.map((r) => r.method).join(", ");
  return new HttpError(405, "method_not_allowed", `${path} accepts ${allow}`);
}

/** True when a Host header names this machine, which blocks DNS rebinding. */
export function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  const name = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];
  return LOOPBACK_HOSTS.has((name ?? "").toLowerCase());
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  // Read to the end even past the limit, so the client gets the 413 rather than a reset.
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size <= MAX_BODY_BYTES) chunks.push(chunk as Buffer);
  }
  if (size > MAX_BODY_BYTES) throw new HttpError(413, "payload_too_large");
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (text === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "invalid_json", "the body is not JSON");
  }
}

function send(res: ServerResponse, status: number, body: unknown, headers = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

function openStream(
  req: IncomingMessage,
  res: ServerResponse,
  stream: EventStream,
  streams: Set<ServerResponse> | undefined,
): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.write(": open\n\n");
  const send: SendEvent = (event, data) => {
    if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const heartbeat = setInterval(() => res.write(": ping\n\n"), STREAM_HEARTBEAT_MS);
  heartbeat.unref();
  streams?.add(res);
  let stop: (() => void) | undefined;
  const end = (): void => {
    clearInterval(heartbeat);
    streams?.delete(res);
    stop?.();
    stop = undefined;
  };
  req.on("close", end);
  res.on("close", end);
  stop = stream.open(send);
}

export interface RouterOptions {
  /** Open event streams are added here, so a server close can end them. */
  streams?: Set<ServerResponse>;
}

/**
 * A request listener over `routes`. Responses are JSON unless a route returns a RawBody
 * or an EventStream. Requests must name a loopback Host, and POSTs must send
 * `content-type: application/json`, so a web page cannot trigger them cross-origin.
 */
export function createRouter(
  routes: readonly Route[],
  options: RouterOptions = {},
): RequestListener {
  return (req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) send(res, 500, { error: "internal_error", message: "internal error" });
      else res.end();
    });
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (!isLoopbackHost(req.headers.host)) {
        throw new HttpError(403, "forbidden_host", "only loopback hosts are served");
      }
      const path = (req.url ?? "/").split("?")[0] ?? "/";
      const route = matchRoute(routes, req.method ?? "GET", path);
      if (route instanceof HttpError) {
        if (route.status === 405) {
          const allow = routes.filter((r) => r.path === path).map((r) => r.method);
          res.setHeader("allow", allow.join(", "));
        }
        throw route;
      }
      let body: unknown;
      if (route.method === "POST") {
        const type = req.headers["content-type"]?.split(";")[0]?.trim().toLowerCase();
        if (type !== "application/json") {
          throw new HttpError(415, "unsupported_media_type", "send content-type: application/json");
        }
        body = await readBody(req);
      }
      const result = await route.handler({ method: route.method, path, body });
      if (result instanceof EventStream) {
        openStream(req, res, result, options.streams);
      } else if (result instanceof RawBody) {
        res.writeHead(200, { "content-type": result.contentType, ...result.headers });
        res.end(result.body);
      } else {
        send(res, 200, result);
      }
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      send(res, error.status, { error: error.code, message: error.message });
    }
  }
}
