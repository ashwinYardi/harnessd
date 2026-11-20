import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { startDaemon } from "../server/daemon.ts";
import type { Check, StatusOptions } from "../status/status.ts";
import { secretRoutes } from "./routes.ts";
import { createSecretStore } from "./store.ts";

const roots: string[] = [];
after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

const KEY = "lin_api_ROUTEVALUE0123456789";
const HOOK = "https://hooks.slack.com/services/T1/B1/ROUTEHOOK42";
const VALUES = /ROUTEVALUE|ROUTEHOOK/;

async function serve(env: NodeJS.ProcessEnv = {}) {
  const globalDir = await mkdtemp(join(tmpdir(), "harnessd-secret-routes-"));
  roots.push(globalDir);
  const store = createSecretStore({ globalDir, env });
  const logs: string[] = [];
  const asked: Array<Partial<StatusOptions>> = [];
  const routes = secretRoutes({
    store,
    log: (line) => logs.push(line),
    checks: async (o) => {
      asked.push(o);
      const value = await store.value("linear.api_key");
      const check: Check = {
        id: o.connectionsOnly?.[0] === "slack" ? "slack.webhook" : "linear.key",
        state: value ? "ok" : "missing",
        // A careless check would echo the key; the route must still mask it.
        detail: value ? `accepted ${value}` : "not set",
        fix: "",
      };
      return [check];
    },
  });
  const daemon = await startDaemon({ routes });
  const texts: string[] = [];
  const call = async (path: string, init?: RequestInit) => {
    const res = await fetch(daemon.url + path, init);
    const text = await res.text();
    texts.push(text);
    return { status: res.status, body: JSON.parse(text) as Record<string, unknown> };
  };
  const post = (path: string, body: unknown, type = "application/json") =>
    call(path, {
      method: "POST",
      headers: { "content-type": type },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  return {
    globalDir,
    store,
    logs,
    asked,
    texts,
    url: daemon.url,
    get: (path: string) => call(path),
    post,
    close: () => daemon.close(),
  };
}

test("GET /api/secrets says set and the source for each fixed id, never a value", async () => {
  const s = await serve({ HARNESSD_SLACK_WEBHOOK_URL: HOOK });
  try {
    assert.deepEqual((await s.get("/api/secrets")).body, {
      secrets: [
        { id: "linear.api_key", set: false, source: null },
        { id: "slack.webhook_url", set: true, source: "env" },
      ],
    });
  } finally {
    await s.close();
  }
});

test("POST saves a value, re-runs that connection's checks and never echoes the value", async () => {
  const s = await serve();
  try {
    const saved = await s.post("/api/secrets/linear.api_key", { value: KEY });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body, {
      secret: { id: "linear.api_key", set: true, source: "saved" },
      checks: [{ id: "linear.key", state: "ok", detail: "accepted ***", fix: "" }],
    });
    assert.deepEqual(s.asked, [{ connectionsOnly: ["linear"] }]);
    assert.equal((await stat(join(s.globalDir, "secrets", "linear.api_key"))).mode & 0o777, 0o600);

    const ref = await s.post("/api/secrets/slack.webhook_url", {
      value: "op://Private/Slack/webhook",
    });
    assert.deepEqual(ref.body.secret, { id: "slack.webhook_url", set: true, source: "1Password" });
    assert.match(await readFile(join(s.globalDir, "config.toml"), "utf8"), /op:\/\/Private/);

    const removed = await s.post("/api/secrets/linear.api_key/remove", {});
    assert.deepEqual(removed.body.secret, { id: "linear.api_key", set: false, source: null });
    assert.deepEqual(s.logs, [
      "settings: saved linear.api_key (saved)",
      "settings: saved slack.webhook_url (1Password)",
      "settings: removed linear.api_key",
    ]);
    assert.doesNotMatch([...s.texts, ...s.logs].join("\n"), VALUES);
  } finally {
    await s.close();
  }
});

test("bad bodies and bad values are 400s that never repeat the value", async () => {
  const s = await serve();
  try {
    const cases: Array<[string, unknown, string]> = [
      ["/api/secrets/linear.api_key", { value: `${KEY} extra` }, "invalid_body"],
      ["/api/secrets/linear.api_key", { value: KEY, other: 1 }, "invalid_body"],
      ["/api/secrets/linear.api_key", { value: 42 }, "invalid_body"],
      ["/api/secrets/linear.api_key", [KEY], "invalid_body"],
      ["/api/secrets/slack.webhook_url", { value: "http://ROUTEHOOK" }, "invalid_body"],
      ["/api/secrets/linear.api_key/remove", { value: KEY }, "invalid_body"],
    ];
    for (const [path, body, code] of cases) {
      const res = await s.post(path, body);
      assert.equal(res.status, 400, path);
      assert.equal(res.body.error, code);
    }
    assert.equal((await s.post("/api/secrets/linear.api_key", `{"value":"${KEY}`)).status, 400);
    const plain = await s.post("/api/secrets/linear.api_key", KEY, "text/plain");
    assert.equal(plain.status, 415);
    assert.equal((await s.post("/api/secrets/..%2Fconfig.toml", { value: KEY })).status, 404);
    assert.equal((await s.post("/api/secrets/github.token", { value: KEY })).status, 404);
    assert.equal((await s.get("/api/secrets/linear.api_key")).status, 405);
    assert.doesNotMatch([...s.texts, ...s.logs].join("\n"), VALUES);
    assert.deepEqual(s.logs, []);
  } finally {
    await s.close();
  }
});

test("a non-loopback Host is refused before the body is read", async () => {
  const s = await serve();
  try {
    const { request } = await import("node:http");
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        `${s.url}/api/secrets/linear.api_key`,
        {
          method: "POST",
          headers: { host: "evil.example", "content-type": "application/json" },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify({ value: KEY }));
    });
    assert.equal(status, 403);
    assert.equal(await s.store.value("linear.api_key"), undefined);
  } finally {
    await s.close();
  }
});

test("a broken config.toml is a 400 invalid_config, and nothing is written", async () => {
  const s = await serve();
  try {
    await writeFile(join(s.globalDir, "config.toml"), "[secrets.linear]\napi_key = 3\n");
    const res = await s.post("/api/secrets/linear.api_key", { value: "env:MY_KEY" });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "invalid_config");
    assert.equal(
      await readFile(join(s.globalDir, "config.toml"), "utf8"),
      "[secrets.linear]\napi_key = 3\n",
    );
  } finally {
    await s.close();
  }
});
