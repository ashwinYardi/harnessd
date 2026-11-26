import assert from "node:assert/strict";
import { test } from "node:test";
import { LinearError } from "./linear/client.ts";
import { isNetworkError } from "./net-error.ts";

const network = (message: string) => new LinearError("network", message);
const http = (status: number) =>
  new LinearError("http", `Linear request failed with HTTP ${status}.`, status);

test("a Linear network error, timeout or 5xx answer is a network error", () => {
  assert.equal(isNetworkError(network("Linear request failed: fetch failed")), true);
  assert.equal(isNetworkError(network("Linear request timed out")), true);
  assert.equal(isNetworkError(http(500)), true);
  assert.equal(isNetworkError(http(503)), true);
});

test("a request timeout is a network error", () => {
  assert.equal(
    isNetworkError(new DOMException("The operation was aborted due to timeout", "TimeoutError")),
    true,
  );
  assert.equal(isNetworkError(new Error("request timed out")), true);
  assert.equal(isNetworkError(new Error("timeout after 30000 ms")), true);
});

test("gh transport text is a network error", () => {
  for (const message of [
    "fetch failed",
    "timeout",
    "request timed out",
    "read ECONNRESET",
    "connect ECONNREFUSED 140.82.112.3:443",
    "connect ETIMEDOUT",
    "getaddrinfo EAI_AGAIN api.github.com",
    "connection reset by peer",
    "Could not resolve host: api.github.com",
    "HTTP 502",
    "HTTP 5xx",
    "HTTP 50x",
    "gh: HTTP 503 Service Unavailable",
  ]) {
    assert.equal(isNetworkError(new Error(message)), true, message);
  }
});

test("auth, GraphQL, not_found, rate_limited and 4xx errors are not network errors", () => {
  assert.equal(
    isNetworkError(new LinearError("auth", "Linear rejected the API key (HTTP 401).", 401)),
    false,
  );
  assert.equal(
    isNetworkError(new LinearError("auth", "timeout while authenticating", 401)),
    false,
    "a Linear code outside network stays non-network even when its text looks like transport",
  );
  assert.equal(
    isNetworkError(new LinearError("graphql", "Linear error: stateId must be a UUID.", 400)),
    false,
  );
  assert.equal(
    isNetworkError(new LinearError("graphql", "Linear error: boom", 500)),
    false,
    "only the http code turns a 5xx answer into a network error",
  );
  assert.equal(
    isNetworkError(new LinearError("not_found", "Linear issue MET-1 not found.")),
    false,
  );
  assert.equal(
    isNetworkError(new LinearError("rate_limited", "Linear rate limit hit.", 429)),
    false,
  );
  assert.equal(isNetworkError(http(400)), false);
  assert.equal(isNetworkError(http(404)), false);
  assert.equal(isNetworkError(new LinearError("http", "Linear request failed.", 499)), false);
  assert.equal(isNetworkError(new Error("validation failed")), false);
  assert.equal(isNetworkError("not an error"), false);
});

test("a string error is read as transport text too", () => {
  assert.equal(isNetworkError("fetch failed"), true);
  assert.equal(isNetworkError("auth failed"), false);
});
