import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { parseLoginPrompt } from "./login-prompt.ts";

test("an https URL in a line is found, without trailing punctuation", () => {
  assert.deepEqual(parseLoginPrompt("Open https://auth.example.com/device?x=1."), {
    url: "https://auth.example.com/device?x=1",
  });
  assert.deepEqual(parseLoginPrompt("Visit (https://example.com/a)"), {
    url: "https://example.com/a",
  });
});

test("http and javascript: URLs are refused", () => {
  assert.deepEqual(parseLoginPrompt("Open http://example.com/login"), {});
  assert.deepEqual(parseLoginPrompt("Open javascript:alert(1)"), {});
  assert.deepEqual(parseLoginPrompt("Open https://"), {});
});

test("a device code is found near the words code or enter", () => {
  assert.deepEqual(parseLoginPrompt("Enter this one-time code: ABCD-1234"), { code: "ABCD-1234" });
  assert.deepEqual(parseLoginPrompt("Then enter WXYZ-98765 in the browser"), {
    code: "WXYZ-98765",
  });
  assert.deepEqual(parseLoginPrompt("Code ABCD-EFGH at https://example.com/device"), {
    url: "https://example.com/device",
    code: "ABCD-EFGH",
  });
});

test("plain uppercase words and codes far from code or enter are not codes", () => {
  assert.deepEqual(parseLoginPrompt("Enter your CODE in the BROWSER"), {});
  assert.deepEqual(parseLoginPrompt("Session ABCD-1234 started"), {});
  assert.deepEqual(parseLoginPrompt("Enter the code shown on the SIGN-IN page"), {});
  assert.deepEqual(parseLoginPrompt("Enter the code at https://example.com/ABCD-1234"), {
    url: "https://example.com/ABCD-1234",
  });
});

test("no file in the setup module drives another app", async () => {
  const dir = import.meta.dirname;
  for (const name of await readdir(dir)) {
    if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue;
    const text = await readFile(join(dir, name), "utf8");
    assert.doesNotMatch(text, /osascript|tell application/i, name);
  }
});
