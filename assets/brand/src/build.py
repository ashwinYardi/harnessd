"""Generate the harnessd brand SVGs.

Usage, from the repo root:
    pip install fonttools uharfbuzz
    python3 assets/brand/src/build.py --font-dir <folder with the Inter .otf files>
    node assets/brand/src/render.mjs     # PNGs, needs Playwright with Chromium

Every letter is converted to an SVG path, so no file depends on an installed font.
Font: Inter 4.0 (Inter Display SemiBold and Inter Display Medium), SIL Open Font License 1.1.
"""

import argparse
import json
import os
from pathlib import Path

import uharfbuzz as hb
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont

OUT = Path(__file__).resolve().parent.parent

# Colors. See assets/brand/README.md for the contrast table.
INK = "#16171A"
PAPER = "#F7F6F2"
ACCENT = "#0B7666"  # on light backgrounds
ACCENT_DARK = "#3CC6B0"  # on dark backgrounds
MUTED = "#5A5D63"  # tagline on PAPER

# The H mark on a 48-unit grid (a 64-unit grid with its 8-unit margin removed).
# Two upright bars are the harnesses. One continuous crossbar is the coordinator.
# The hole cut through the centre of the crossbar leaves a ring: the one point where
# every harness meets.
MARK_SIZE = 48
MARK = (10, 14, 5, "round")  # bar width, crossbar height, hole radius, hole shape
# The 16 and 32 px tiles use heavier strokes, so that at 12 and 24 px every edge
# sits on a whole pixel. The hole is a 2 px square there: a 2 px circle turns grey.
MARK_SMALL = (12, 16, 4, "square")


def fmt(v):
    v = round(v, 2)
    return str(int(v)) if v == int(v) else str(v)


def mark_d(x=0.0, y=0.0, scale=1.0, geometry=MARK):
    """One even-odd path for the mark, at offset (x, y) and the given scale."""
    bar_w, cross_h, hole_r, hole_shape = geometry

    c = MARK_SIZE / 2
    cx, cy, r = x + c * scale, y + c * scale, hole_r * scale
    if hole_shape == "square":
        hole = f"M{fmt(cx - r)} {fmt(cy - r)}h{fmt(2 * r)}v{fmt(2 * r)}h{fmt(-2 * r)}z"
    else:
        hole = f"M{fmt(cx - r)} {fmt(cy)}a{fmt(r)} {fmt(r)} 0 1 0 {fmt(2 * r)} 0a{fmt(r)} {fmt(r)} 0 1 0 {fmt(-2 * r)} 0z"
    # One outline for the bars and the crossbar, so the hole is the only even-odd cut.
    w, b, h = MARK_SIZE, bar_w, cross_h
    top, bot = c - h / 2, c + h / 2
    pts = [(0, 0), (b, 0), (b, top), (w - b, top), (w - b, 0), (w, 0), (w, w), (w - b, w),
           (w - b, bot), (b, bot), (b, w), (0, w)]
    outline = "M" + "L".join(f"{fmt(x + px * scale)} {fmt(y + py * scale)}" for px, py in pts) + "z"
    return outline + hole


def mark_paths(fill, x=0.0, y=0.0, scale=1.0, geometry=MARK):
    return f'<path fill="{fill}" fill-rule="evenodd" d="{mark_d(x, y, scale, geometry)}"/>'


class Text:
    """Shapes a string with HarfBuzz (kerning on) and returns one path per glyph."""

    def __init__(self, fontfile, text, track=0, adjust=None):
        blob = hb.Blob.from_file_path(fontfile)
        font = hb.Font(hb.Face(blob))
        buf = hb.Buffer()
        buf.add_str(text)
        buf.guess_segment_properties()
        hb.shape(font, buf, {"kern": True, "liga": False, "calt": False})
        tt = TTFont(fontfile)
        gs = tt.getGlyphSet()
        order = tt.getGlyphOrder()
        self.upm = tt["head"].unitsPerEm
        self.glyphs = []
        x = 0
        xmin, ymin, xmax, ymax = 1e9, 1e9, -1e9, -1e9
        adjust = adjust or {}
        for i, (info, pos) in enumerate(zip(buf.glyph_infos, buf.glyph_positions)):
            x += adjust.get(i, 0)
            name = order[info.codepoint]
            pen = SVGPathPen(gs, ntos=lambda v: fmt(v))
            gs[name].draw(TransformPen(pen, (1, 0, 0, -1, x + pos.x_offset, 0)))
            bp = BoundsPen(gs)
            gs[name].draw(TransformPen(bp, (1, 0, 0, -1, x + pos.x_offset, 0)))
            if bp.bounds:
                b = bp.bounds
                xmin, ymin = min(xmin, b[0]), min(ymin, b[1])
                xmax, ymax = max(xmax, b[2]), max(ymax, b[3])
            self.glyphs.append(pen.getCommands())
            x += pos.x_advance + track
        self.bounds = (xmin, ymin, xmax, ymax)


def svg(w, h, body, title):
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {fmt(w)} {fmt(h)}" '
        f'width="{fmt(w)}" height="{fmt(h)}" role="img" aria-label="{title}">'
        f"<title>{title}</title>{body}</svg>\n"
    )


def glyph_group(text, fill, accent, dx, dy, s):
    out = []
    last = len(text.glyphs) - 1
    for i, d in enumerate(text.glyphs):
        color = accent if i == last else fill
        out.append(f'<path fill="{color}" d="{d}"/>')
    return f'<g transform="translate({fmt(dx)} {fmt(dy)}) scale({s})">{"".join(out)}</g>'


def contrast(a, b):
    def lum(h):
        c = [int(h[i : i + 2], 16) / 255 for i in (1, 3, 5)]
        c = [v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4 for v in c]
        return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]

    la, lb = sorted((lum(a), lum(b)), reverse=True)
    return round((la + 0.05) / (lb + 0.05), 2)


def tile(size, radius, mark_w, geometry=MARK):
    """The mark in Paper, centred on an Ink tile."""
    offset = (size - mark_w) / 2
    corner = f' rx="{radius}"' if radius else ""
    return f'<rect width="{size}" height="{size}"{corner} fill="{INK}"/>' + mark_paths(
        PAPER, offset, offset, mark_w / MARK_SIZE, geometry
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--font-dir", required=True, help="folder with the Inter 4.0 .otf files")
    font_dir = ap.parse_args().font_dir
    wm_font = os.path.join(font_dir, "InterDisplay-SemiBold.otf")
    tag_font = os.path.join(font_dir, "InterDisplay-Medium.otf")

    # Wordmark. Tracking -40/2048 em, then optical fixes by eye: open "rn" a touch,
    # and give the final "d" a hair more room so the accent reads as its own letter.
    word = Text(wm_font, "harnessd", track=-40, adjust={3: 6, 7: 14})
    xmin, ymin, xmax, ymax = word.bounds
    wm_h = 64.0  # the wordmark's height, ascender to baseline, in output units
    wm_scale = wm_h / (ymax - ymin)
    wm_w = (xmax - xmin) * wm_scale
    light, dark = (INK, ACCENT), (PAPER, ACCENT_DARK)
    files = {}

    def wordmark(theme, dx=0.0):
        return glyph_group(word, *theme, dx - xmin * wm_scale, -ymin * wm_scale, round(wm_scale, 6))

    files["wordmark.svg"] = svg(wm_w, wm_h, wordmark(light), "harnessd")
    files["wordmark-dark.svg"] = svg(wm_w, wm_h, wordmark(dark), "harnessd")

    # Mark alone, tight to its 48-unit grid.
    files["mark.svg"] = svg(MARK_SIZE, MARK_SIZE, mark_paths(INK), "harnessd")
    files["mark-dark.svg"] = svg(MARK_SIZE, MARK_SIZE, mark_paths(PAPER), "harnessd")

    # Lockup: the mark is 0.9 of the wordmark's height, centred on it, so its heavier
    # strokes do not outweigh the letters. The gap is 0.4 of the wordmark's height.
    mark_h = wm_h * 0.9
    gap = wm_h * 0.4
    lockup_w = mark_h + gap + wm_w

    def lockup(theme):
        mark = mark_paths(theme[0], 0, (wm_h - mark_h) / 2, mark_h / MARK_SIZE)
        return mark + wordmark(theme, mark_h + gap)

    files["lockup.svg"] = svg(lockup_w, wm_h, lockup(light), "harnessd")
    files["lockup-dark.svg"] = svg(lockup_w, wm_h, lockup(dark), "harnessd")

    # App icon: a 512 tile, radius 112 (about 22 percent), mark 240 wide.
    files["app-icon.svg"] = svg(512, 512, tile(512, 112, 240), "harnessd")
    # Square tile for the 180 px touch icon: the OS rounds the corners itself.
    files["src/touch-icon.svg"] = svg(512, 512, tile(512, 0, 240), "harnessd")
    # Small tile for the 16 and 32 px PNGs: the small mark fills 12 of 16 pixels.
    files["src/favicon-tile.svg"] = svg(16, 16, tile(16, 3, 12, MARK_SMALL), "harnessd")

    # favicon.svg: the bare mark, ink on light tabs and paper on dark ones.
    files["favicon.svg"] = (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="harnessd">'
        "<title>harnessd</title>"
        f"<style>path{{fill:{INK}}}@media (prefers-color-scheme:dark){{path{{fill:{PAPER}}}}}</style>"
        f'<path fill-rule="evenodd" d="{mark_d(8, 8)}"/></svg>\n'
    )

    # Social preview, 1280x640: the lockup and the tagline, all as paths.
    width, height = 1280, 640
    lockup_scale = 1.75  # 112 px tall
    tag = Text(tag_font, "One harness to rule them all.", track=-10)
    txmin, _, txmax, _ = tag.bounds
    tag_scale = 40 / tag.upm  # 40 px type
    tag_w = (txmax - txmin) * tag_scale
    tag_body = "".join(f'<path d="{d}"/>' for d in tag.glyphs)
    body = (
        f'<rect width="{width}" height="{height}" fill="{PAPER}"/>'
        f'<g transform="translate({fmt((width - lockup_w * lockup_scale) / 2)} 236) '
        f'scale({lockup_scale})">{lockup(light)}</g>'
        f'<g fill="{MUTED}" transform="translate({fmt((width - tag_w) / 2 - txmin * tag_scale)} 432) '
        f'scale({tag_scale})">{tag_body}</g>'
    )
    files["src/social-preview.svg"] = svg(width, height, body, "harnessd: One harness to rule them all.")

    for name, text in files.items():
        (OUT / name).write_text(text)

    pairs = {
        "ink on paper": (INK, PAPER),
        "ink on white": (INK, "#FFFFFF"),
        "paper on ink": (PAPER, INK),
        "accent on #0D1117 (do not use)": (ACCENT, "#0D1117"),
        "accent on paper": (ACCENT, PAPER),
        "accent on white": (ACCENT, "#FFFFFF"),
        "accent-dark on ink": (ACCENT_DARK, INK),
        "accent-dark on #0D1117": (ACCENT_DARK, "#0D1117"),
        "paper on #0D1117": (PAPER, "#0D1117"),
        "muted on paper": (MUTED, PAPER),
    }
    print(json.dumps({k: contrast(*v) for k, v in pairs.items()}, indent=2))
    print("wrote", ", ".join(sorted(files)))


if __name__ == "__main__":
    main()
