// The accent sits behind one --brand token family (D-029). These tests read index.css: the
// accent changes on one line, and white text on the brand fill keeps WCAG AA in both themes.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const css = readFileSync(new URL("../index.css", import.meta.url), "utf8");

/** WCAG 2.1 relative luminance of an oklch color, clipped to sRGB. */
function luminance(l: number, c: number, h: number): number {
  const rad = (h * Math.PI) / 180;
  const a = c * Math.cos(rad);
  const b = c * Math.sin(rad);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const clip = (v: number) => Math.min(1, Math.max(0, v));
  const r = clip(4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_);
  const g = clip(-1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_);
  const bl = clip(-0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_);
  return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
}

const contrastWithWhite = (y: number) => 1.05 / (y + 0.05);

const OKLCH = /oklch\(([\d.]+)\s+([\d.]+)\s+([\d.]+)\)/;

/** The two arms of --brand: light-dark(<light>, <dark>), each an oklch color. */
function brandArms(): Record<"light" | "dark", [number, number, number]> {
  const lines = [...css.matchAll(/--brand:\s*([^;]+);/g)];
  assert.equal(lines.length, 1, "--brand is set on one line");
  const m = /^light-dark\((oklch\([^)]+\)),\s*(oklch\([^)]+\))\)$/.exec(lines[0]?.[1] ?? "");
  assert.ok(m, "--brand is light-dark(oklch(...), oklch(...))");
  const read = (v: string) => OKLCH.exec(v)?.slice(1, 4).map(Number) as [number, number, number];
  return { light: read(m[1] ?? ""), dark: read(m[2] ?? "") };
}

test("the accent is one --brand line, and primary and ring read it", () => {
  brandArms();
  assert.equal([...css.matchAll(/--brand-foreground:/g)].length, 1);
  assert.match(css, /--primary:\s*var\(--brand\);/);
  assert.match(css, /--primary-foreground:\s*var\(--brand-foreground\);/);
  assert.match(css, /--ring:\s*var\(--brand\);/);
  assert.equal([...css.matchAll(/--primary:/g)].length, 1, "no theme overrides --primary");
  const others = css.replace(/--brand:[^;]+;/g, "").replace(/oklch\([\d.%]+ 0 0\)/g, "");
  assert.doesNotMatch(others, /oklch\(/, "no other chromatic oklch outside --brand");
});

test("white text on the brand fill meets WCAG AA (4.5:1) in light and dark", () => {
  assert.match(css, /--brand-foreground:\s*var\(--color-white\);/);
  for (const [theme, [l, c, h]] of Object.entries(brandArms())) {
    const ratio = contrastWithWhite(luminance(l, c, h));
    assert.ok(ratio >= 4.5, `${theme}: ${ratio.toFixed(2)}:1`);
  }
});
