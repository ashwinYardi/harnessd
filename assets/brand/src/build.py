"""Generate the harnessd brand SVGs.

Usage, from the repo root:
    pip install fonttools uharfbuzz
    python3 assets/brand/src/build.py [--font-dir /usr/share/fonts/opentype/inter]
    node assets/brand/src/render.mjs     # PNGs, needs Playwright with Chromium

Every letter is converted to an SVG path, so no file depends on an installed font.
Font: Inter 4.0 (Inter Display SemiBold and Inter Regular), SIL Open Font License 1.1.
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
ACCENT = "#0D7F70"  # on light backgrounds
ACCENT_DARK = "#3CC6B0"  # on dark backgrounds
MUTED = "#5A5D63"  # tagline on PAPER

# The H mark on a 48-unit grid (a 64-unit grid with its 8-unit margin removed).
# Two upright bars are the harnesses. The crossbar is the coordinator. The ring is
# the one point where every harness meets.
MARK_SIZE = 48
BAR_W = 12
CROSS_H = 8
RING_OUT = 9
RING_IN = 4


def ring_d(cx, cy, ro, ri):
    def circle(r):
        return f"M{fmt(cx - r)} {fmt(cy)}a{fmt(r)} {fmt(r)} 0 1 0 {fmt(2 * r)} 0a{fmt(r)} {fmt(r)} 0 1 0 {fmt(-2 * r)} 0z"

    return circle(ro) + circle(ri)


def mark_d(x=0.0, y=0.0, s=1.0, ring_out=RING_OUT, ring_in=RING_IN):
    """Paths for the mark at offset (x, y) and scale s. The ring overlaps the crossbar.

    At 16 px, ring_out=8 and ring_in=4 put every edge on a whole pixel.
    """

    def r(rx, ry, w, h):
        rx, ry, w, h = x + rx * s, y + ry * s, w * s, h * s
        return f"M{fmt(rx)} {fmt(ry)}h{fmt(w)}v{fmt(h)}h{fmt(-w)}z"

    c = MARK_SIZE / 2
    stub_l = c - ring_out + 1 - BAR_W  # the crossbar runs 1 unit into the ring
    parts = [
        r(0, 0, BAR_W, MARK_SIZE),
        r(MARK_SIZE - BAR_W, 0, BAR_W, MARK_SIZE),
        r(BAR_W, c - CROSS_H / 2, stub_l, CROSS_H),
        r(c + ring_out - 1, c - CROSS_H / 2, stub_l, CROSS_H),
    ]
    rings = ring_d(x + c * s, y + c * s, ring_out * s, ring_in * s)
    return "".join(parts), rings


def fmt(v):
    v = round(v, 2)
    return str(int(v)) if v == int(v) else str(v)


def mark_paths(fill, x=0.0, y=0.0, s=1.0, **ring):
    bars, rings = mark_d(x, y, s, **ring)
    return f'<path fill="{fill}" d="{bars}"/><path fill="{fill}" fill-rule="evenodd" d="{rings}"/>'


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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--font-dir", default="/usr/share/fonts/opentype/inter")
    font_dir = ap.parse_args().font_dir
    wm_font = os.path.join(font_dir, "InterDisplay-SemiBold.otf")
    tag_font = os.path.join(font_dir, "InterDisplay-Medium.otf")

    # Wordmark. Tracking -40/2048 em, then optical fixes by eye: open "rn" a touch,
    # and give the final "d" a hair more room so the accent reads as its own letter.
    word = Text(wm_font, "harnessd", track=-40, adjust={3: 6, 7: 14})
    xmin, ymin, xmax, ymax = word.bounds
    pad = 0
    wm_h = 64.0  # the wordmark's height, ascender to baseline, in output units
    s = wm_h / (ymax - ymin)
    wm_w = (xmax - xmin) * s
    files = {}

    def wordmark(fill, accent):
        return glyph_group(word, fill, accent, -xmin * s + pad, -ymin * s, round(s, 6))

    files["wordmark.svg"] = svg(wm_w, wm_h, wordmark(INK, ACCENT), "harnessd")
    files["wordmark-dark.svg"] = svg(wm_w, wm_h, wordmark(PAPER, ACCENT_DARK), "harnessd")

    # Mark alone, tight to its 48-unit grid.
    files["mark.svg"] = svg(MARK_SIZE, MARK_SIZE, mark_paths(INK), "harnessd")
    files["mark-dark.svg"] = svg(MARK_SIZE, MARK_SIZE, mark_paths(PAPER), "harnessd")

    # Lockup: the mark is as tall as the wordmark, and the gap is half the mark.
    m = wm_h / MARK_SIZE
    gap = wm_h * 0.42
    lw = wm_h + gap + wm_w

    def lockup(fill, accent):
        return mark_paths(fill, 0, 0, m) + glyph_group(
            word, fill, accent, wm_h + gap - xmin * s, -ymin * s, round(s, 6)
        )

    files["lockup.svg"] = svg(lw, wm_h, lockup(INK, ACCENT), "harnessd")
    files["lockup-dark.svg"] = svg(lw, wm_h, lockup(PAPER, ACCENT_DARK), "harnessd")

    # App icon: a 512 tile, radius 112 (about 22 percent), mark 256 wide.
    t = 512
    ms = 256 / MARK_SIZE
    o = (t - 256) / 2
    files["app-icon.svg"] = svg(
        t,
        t,
        f'<rect width="{t}" height="{t}" rx="112" fill="{INK}"/>' + mark_paths(PAPER, o, o, ms),
        "harnessd",
    )
    # Square tile with no radius, for the 180 px touch icon (the OS rounds it).
    files["src/touch-icon.svg"] = svg(
        t, t, f'<rect width="{t}" height="{t}" fill="{INK}"/>' + mark_paths(PAPER, o, o, ms), "harnessd"
    )
    # Small tile for the 16 and 32 px PNGs: the mark fills 12 of 16 pixels, snapped to whole pixels.
    files["src/favicon-tile.svg"] = svg(
        16,
        16,
        f'<rect width="16" height="16" rx="3" fill="{INK}"/>' + mark_paths(PAPER, 2, 2, 12 / 48, ring_out=8, ring_in=4),
        "harnessd",
    )

    # favicon.svg: the bare mark, ink on light tabs and paper on dark ones.
    bars, rings = mark_d(8, 8, 1)
    files["favicon.svg"] = (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="harnessd">'
        "<title>harnessd</title>"
        f"<style>path{{fill:{INK}}}@media (prefers-color-scheme:dark){{path{{fill:{PAPER}}}}}</style>"
        f'<path d="{bars}"/><path fill-rule="evenodd" d="{rings}"/></svg>\n'
    )

    # Social preview, 1280x640: the lockup and the tagline, all as paths.
    W, H = 1280, 640
    ls = 1.75  # lockup scale: 112 px tall
    lx = (W - lw * ls) / 2
    ly = 236
    tag = Text(tag_font, "One harness to rule them all.", track=-10)
    txmin, tymin, txmax, tymax = tag.bounds
    ts = 40 / tag.upm * 1.0  # 40 px type
    tw = (txmax - txmin) * ts
    tag_body = "".join(f'<path d="{d}"/>' for d in tag.glyphs)
    body = (
        f'<rect width="{W}" height="{H}" fill="{PAPER}"/>'
        f'<g transform="translate({fmt(lx)} {ly}) scale({ls})">{lockup(INK, ACCENT)}</g>'
        f'<g fill="{MUTED}" transform="translate({fmt((W - tw) / 2 - txmin * ts)} 432) scale({ts})">'
        f"{tag_body}</g>"
    )
    files["src/social-preview.svg"] = svg(W, H, body, "harnessd: One harness to rule them all.")

    for name, text in files.items():
        (OUT / name).write_text(text)

    pairs = {
        "ink on paper": (INK, PAPER),
        "ink on white": (INK, "#FFFFFF"),
        "paper on ink": (PAPER, INK),
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
