# harnessd brand

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="lockup-dark.svg">
  <img src="lockup.svg" alt="harnessd" height="48">
</picture>

## The mark
An H. The two upright bars are the harnesses. The crossbar is the coordinator that joins them. The ring at the centre is the one point where every harness meets.

The mark is flat and one color. Every shape sits on a 48-unit grid: bars 12 wide, crossbar 8 high, ring 18 across with an 8-unit hole.

## Files
All logos are SVG paths. No file needs an installed font.

| File | Use |
|---|---|
| `mark.svg`, `mark-dark.svg` | The H mark alone. Ink, or paper for dark backgrounds. |
| `wordmark.svg`, `wordmark-dark.svg` | "harnessd" alone. |
| `lockup.svg`, `lockup-dark.svg` | The mark and the wordmark side by side. The default logo. |
| `app-icon.svg` | The mark on a rounded ink tile, 512 px, radius 112. |
| `favicon.svg` | The bare mark. Ink, or paper when the browser is dark. |
| `favicon-16.png`, `favicon-32.png` | A small ink tile. Its ring is snapped to whole pixels. |
| `apple-touch-icon.png` | 180 px, square tile. The OS rounds the corners. |
| `favicon-512.png` | The app icon as a PNG. |
| `social-preview.png` | 1280 × 640, the lockup and the tagline. |
| `src/build.py`, `src/render.mjs` | Make every file above. See "Rebuild". |

`-dark` files are for dark backgrounds.

## Colors
| Name | Hex | Use |
|---|---|---|
| Ink | `#16171A` | The logo on light backgrounds. The app-icon tile. |
| Paper | `#F7F6F2` | The logo on dark backgrounds. The social preview background. |
| Junction | `#0D7F70` | The final "d" of the wordmark, on light backgrounds. |
| Junction light | `#3CC6B0` | The final "d", on dark backgrounds. |
| Slate | `#5A5D63` | The tagline on Paper. |

Junction is the only accent. Use it on the "d" and nowhere else in the logo. Do not use it for UI states.

Contrast, WCAG 2.1. Every pair passes AA for normal text (4.5:1).

| Pair | Ratio |
|---|---|
| Ink on Paper | 16.6:1 |
| Ink on white | 17.9:1 |
| Paper on `#0D1117` (a common dark page) | 17.5:1 |
| Junction on Paper | 4.5:1 |
| Junction on white | 4.9:1 |
| Junction light on Ink | 8.5:1 |
| Junction light on `#0D1117` | 8.9:1 |
| Slate on Paper | 6.1:1 |

## Clear space
Keep a space around the logo equal to half the mark's height. For the lockup, that is half its own height on every side. Put no text, edge or other logo in it.

## Minimum size
| Item | Smallest |
|---|---|
| Mark | 16 px. Below 24 px, use `favicon-16.png` or `favicon-32.png`. |
| Lockup | 20 px high |
| Wordmark | 14 px high |

## Do not
- Do not stretch, rotate, outline or add effects to the logo.
- Do not change the colors, or put the accent on the mark.
- Do not set "harnessd" in another font, or capitalise it.
- Do not put the logo on a busy image, or on a background with less than 4.5:1 contrast.

## Font
The wordmark is Inter Display SemiBold, and the social-preview tagline is Inter Display Medium. Both are from Inter 4.0 by Rasmus Andersson and the Inter Project Authors, under the [SIL Open Font License 1.1](https://openfontlicense.org). The letters are converted to paths, so the font is not shipped here. The wordmark has a tracking of -40/2048 em, with two spacing fixes by eye: "rn" opens by 6 units, and the "d" by 14.

## Rebuild
From the repo root:
```sh
pip install fonttools uharfbuzz
python3 assets/brand/src/build.py --font-dir <folder with the Inter .otf files>
node assets/brand/src/render.mjs    # needs Playwright with Chromium
```
`build.py` prints the contrast table above.
