// Renders the brand PNGs from the SVGs that build.py writes. Needs Playwright with Chromium.
// Usage, from the repo root: node assets/brand/src/render.mjs
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const { chromium } = createRequire(import.meta.url)("playwright");
const dir = fileURLToPath(new URL("../", import.meta.url));

// [output, source svg, width, height]
const jobs = [
  ["favicon-16.png", "src/favicon-tile.svg", 16, 16],
  ["favicon-32.png", "src/favicon-tile.svg", 32, 32],
  ["apple-touch-icon.png", "src/touch-icon.svg", 180, 180],
  ["favicon-512.png", "app-icon.svg", 512, 512],
  ["social-preview.png", "src/social-preview.svg", 1280, 640],
];

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
for (const [out, src, w, h] of jobs) {
  const svg = readFileSync(dir + src, "utf8");
  await page.setViewportSize({ width: w, height: h });
  await page.setContent(
    `<body style="margin:0;background:transparent"><img style="display:block" width="${w}" height="${h}" src="data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}"></body>`,
  );
  await page.screenshot({ path: dir + out, omitBackground: true });
  console.log(`wrote ${out}`);
}
await browser.close();
