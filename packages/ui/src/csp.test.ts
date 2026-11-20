// The page's CSP allows one inline <style>: the scrollbar rule Base UI's scroll area and
// select render. If a Base UI update changes that text, its hash changes, and this test fails.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { UI_CSP } from "@harnessd/daemon";

test("the CSP allows the hash of Base UI's scrollbar style, and no other inline style", () => {
  const require = createRequire(import.meta.url);
  const root = dirname(require.resolve("@base-ui/react/package.json"));
  const file = join(root, "utils", "styles.js");
  const source = readFileSync(file, "utf8");
  const children = /children: `([^`]+)`/.exec(source)?.[1];
  assert.ok(children, "Base UI's scrollbar style text was not found");
  const placeholder = ["$", "{DISABLE_SCROLLBAR_CLASS_NAME}"].join("");
  const css = children.replaceAll(placeholder, "base-ui-disable-scrollbar");
  const hash = createHash("sha256").update(css).digest("base64");
  const styleSrc = UI_CSP.split("; ").find((d) => d.startsWith("style-src"));
  assert.equal(styleSrc, `style-src 'self' 'sha256-${hash}'`);
});
