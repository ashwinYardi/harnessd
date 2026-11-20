// Settings routes for secrets (MET-33, D-029). Write-only: no route returns a value. Each
// id has its own fixed route, so no request text names a file. Errors, log lines and the
// re-run checks never hold a value.
import { ConfigError } from "@harnessd/shared";
import { HttpError, type Route } from "../server/router.ts";
import type { Check, StatusOptions } from "../status/status.ts";
import { SECRET_IDS, SecretError, type SecretId, type SecretStore } from "./store.ts";

export interface SecretRoutesOptions {
  store: SecretStore;
  /** The status engine, with options merged over the daemon's own. */
  checks: (options: Partial<StatusOptions>) => Promise<Check[]>;
  log?: (line: string) => void;
}

const CONNECTION: Record<SecretId, "linear" | "slack"> = {
  "linear.api_key": "linear",
  "slack.webhook_url": "slack",
};

const BODY_HINT = 'send { "value": "…" } with the secret, or an op:// or env: reference';

function bodyValue(body: unknown): string {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(400, "invalid_body", BODY_HINT);
  }
  const keys = Object.keys(body);
  const value = (body as { value?: unknown }).value;
  if (keys.length !== 1 || keys[0] !== "value" || typeof value !== "string") {
    throw new HttpError(400, "invalid_body", BODY_HINT);
  }
  return value;
}

function emptyBody(body: unknown): void {
  if (body === undefined || body === null) return;
  if (typeof body === "object" && !Array.isArray(body) && Object.keys(body).length === 0) return;
  throw new HttpError(400, "invalid_body", "this action takes no options; send {}");
}

/** Masks every value the store knows, in case a check echoed one. */
function masked(checks: Check[], known: readonly string[]): Check[] {
  const hide = (text: string) => known.reduce((t, v) => t.replaceAll(v, "***"), text);
  return checks.map((c) => ({ ...c, detail: hide(c.detail), fix: hide(c.fix) }));
}

export function secretRoutes(options: SecretRoutesOptions): Route[] {
  const { store } = options;
  const log = options.log ?? (() => {});

  async function guard<T>(task: () => Promise<T>): Promise<T> {
    try {
      return await task();
    } catch (e) {
      if (e instanceof SecretError) throw new HttpError(400, "invalid_body", e.message);
      if (e instanceof ConfigError) throw new HttpError(400, "invalid_config", e.message);
      throw e;
    }
  }

  async function after(id: SecretId, secret: Awaited<ReturnType<SecretStore["state"]>>) {
    const checks = await options.checks({ connectionsOnly: [CONNECTION[id]] });
    return { secret, checks: masked(checks, store.known()) };
  }

  const routes: Route[] = [
    {
      method: "GET",
      path: "/api/secrets",
      handler: () =>
        guard(async () => ({
          secrets: await Promise.all(SECRET_IDS.map((id) => store.state(id))),
        })),
    },
  ];
  for (const id of SECRET_IDS) {
    routes.push(
      {
        method: "POST",
        path: `/api/secrets/${id}`,
        handler: ({ body }) =>
          guard(async () => {
            const secret = await store.save(id, bodyValue(body));
            log(`settings: saved ${id} (${secret.source})`);
            return after(id, secret);
          }),
      },
      {
        method: "POST",
        path: `/api/secrets/${id}/remove`,
        handler: ({ body }) =>
          guard(async () => {
            emptyBody(body);
            const secret = await store.remove(id);
            log(`settings: removed ${id}`);
            return after(id, secret);
          }),
      },
    );
  }
  return routes;
}
