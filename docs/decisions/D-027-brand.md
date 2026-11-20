# D-027 Brand: the H mark, the wordmark and one accent
Status: accepted 2026-11-20. Issue: MET-31.

- **The mark** is an H. Two upright bars are the harnesses, and one continuous crossbar is the coordinator. A hole cut through the centre of the crossbar leaves a ring, the point where every harness meets. It is flat, one color, and drawn on a 48-unit grid. A ring on short struts was rejected, because its outline looks like a known film spacecraft.
- **The wordmark** is "harnessd" in lowercase, in Inter Display SemiBold (SIL OFL 1.1), converted to SVG paths. No brand file needs an installed font.
- **Colors:** Ink `#16171A`, Paper `#F7F6F2`, and one accent, Junction `#0B7666` (`#3CC6B0` on dark). The accent marks only the final "d" of the wordmark. It is never a UI state color, so it cannot be confused with Needs you, warning or success (DESIGN.md).
- **Source of truth:** `assets/brand/`, made by `assets/brand/src/build.py`. Rules for use: `assets/brand/README.md`.
- **No borrowed brand.** No other product's name, logo, screenshot or copy is used as part of the harnessd brand. The README names harness CLIs and vendored skills only as facts: what harnessd runs on and what it credits.
- **Asset tools:** `build.py` (Python, fonttools and uharfbuzz) and `render.mjs` (Playwright) make the assets only. They are not part of the build or of any package, so D-002 and D-003 still hold.
- MET-32 puts the mark in the app. Until then the UI keeps its text title.

Why: the owner wants an original brand that reads at 16 px and fits the quiet UI.
