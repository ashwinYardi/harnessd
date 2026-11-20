import assert from "node:assert/strict";
import { test } from "node:test";
import { HttpError, isLoopbackHost, matchRoute, type Route } from "./router.ts";

const routes: Route[] = [
  { method: "GET", path: "/api/pause", handler: () => ({}) },
  { method: "POST", path: "/api/pause", handler: () => ({}) },
  { method: "POST", path: "/api/resume", handler: () => ({}) },
];

test("matchRoute finds the route, 404s unknown paths and 405s other methods", () => {
  assert.equal(matchRoute(routes, "POST", "/api/resume"), routes[2]);
  const missing = matchRoute(routes, "GET", "/api/nope");
  assert.ok(missing instanceof HttpError);
  assert.equal(missing.status, 404);
  assert.equal(missing.code, "not_found");
  const wrong = matchRoute(routes, "GET", "/api/resume");
  assert.ok(wrong instanceof HttpError);
  assert.equal(wrong.status, 405);
  assert.equal(wrong.message, "/api/resume accepts POST");
});

test("isLoopbackHost accepts only this machine", () => {
  for (const host of ["127.0.0.1:4747", "localhost", "LOCALHOST:1", "[::1]:4747"]) {
    assert.equal(isLoopbackHost(host), true, host);
  }
  for (const host of [undefined, "", "evil.test", "127.0.0.1.evil.test:4747", "10.0.0.1"]) {
    assert.equal(isLoopbackHost(host), false, String(host));
  }
});
