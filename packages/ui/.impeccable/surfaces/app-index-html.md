---
version: 1
slug: "app-index-html"
primary_target: "app/index.html"
related_targets: ["app/src/views/settings/Settings.tsx"]
---

# Surface brief: harnessd app shell (packages/ui)

Mode: Operate. Visitor: the owner, a developer who checks in a few times a day and uses T3 Code daily. Job: see what runs, what is blocked and what needs them; stop everything at once; reach any action by keyboard. Constraints: PRODUCT.md pinned aesthetic, D-025 stack and tokens, loopback only, strict CSP, no web fonts, no T3 Code brand.

## Settings (MET-28)
An extension of this surface, after T3 Code's Settings → Providers: a sub-nav (Harnesses, Connections, Team), one card per harness or connection with its state badge, details, fix and actions, a Team table that saves through the validator, and a Start banner while the loop is in setup. Job: get from a fresh machine to a running loop in a few clicks. No secret is ever shown. The Linear and Slack cards take their secret in a write-only field (MET-33, D-029).

## Direction contract
THESIS: harnessd feels like a sibling of T3 Code: the same sidebar, header, palette, controls and density, so the owner knows it on sight. It refuses the decorated kanban and the custom one-off look of MET-18.
OWN-WORLD: T3 Code's zinc neutrals on near-white, true black in dark, one blue primary, 8 px controls, 12 px cards, soft overlay shadows, system sans at 14 px, lucide icons. Red belongs to Needs you alone; amber to budget and paused.
STORY: The owner opens the app, reads the red Needs you count in the header and sidebar, scans the board, checks agents and logs from the sidebar, pauses from the header, and runs anything else from Cmd+K.
FIRST VIEWPORT: 224 px sidebar left (Board, Agents, Logs, Settings; Commands at the foot). 52 px header with title, connection, Needs you button and the pause control at its right edge. Board columns fill the rest, Needs you first.
FORM: T3 Code app shell, pinned by the owner. seed: none (pinned) "The owner wants the UI at T3 Code's level"; "Take T3 Code's tokens for color, type scale, spacing, radius and motion"; "Build an app shell: a left sidebar (Board, Agents, Logs, Settings), a header with the pause control always visible, and a Cmd+K command palette with every action."
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
