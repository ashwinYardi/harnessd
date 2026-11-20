---
version: 1
slug: "app-index-html"
primary_target: "app/index.html"
related_targets: []
---

# Surface brief: harnessd live board (packages/ui)

Mode: Operate. Visitor: the owner, a developer who checks in a few times a day. Job: see what runs, what is blocked and what needs them; stop everything at once if needed. Constraints: PRODUCT.md pinned aesthetic (dense, quiet, t3.code and cloudroom.dev craft bar; no gradients, emoji, filler copy). Loopback only, strict CSP, no web fonts.

## Direction contract
THESIS: The board reads like the stock tables of a financial page: every state and figure sits in a fixed column, so a glance finds what changed. It refuses the decorated kanban: no avatars, no colored pills, no drop shadows. Rows are plain bordered quote lines.
OWN-WORLD: Cool ink on newsprint grey, never cream. A deep ink header band carries the name, the connection and the kill switch; it turns amber while paused. One signal red is reserved for Needs you. Amber marks budgets past 80 percent. System sans at 13 px, tabular figures, mono only for keys and log lines, 1 px hairline rules, 4 px radius, no shadows.
STORY: The owner opens the page, reads the Needs you column first, scans the state columns, checks each agent's task, time and budget, reads the log when something looks wrong, and pauses from the control that is always in the band.
FIRST VIEWPORT: Header band 44 px across the top, pause control at its right edge. Board of six columns below it, Needs you at the left. Bottom third split: agent table left, live log right.
FORM: financial-pages quote table, candidate 5 of 7. seed:90eeb77d10ca5ba4 (degraded roll, no challengers).
SIGNATURE: quote-line rows: key, title and right-aligned tabular figures on one baseline grid, with the Needs you column set in the one signal ink.
