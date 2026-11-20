---
version: 1
slug: "app-index-html"
primary_target: "app/index.html"
related_targets: ["app/src/views/settings/Settings.tsx"]
---

# Surface brief: harnessd app shell (packages/ui)

Mode: Operate. Visitor: the owner, a developer who checks in a few times a day and lives in keyboard-driven developer tools. Job: see what runs, what is blocked and what needs them; stop everything at once; reach any action by keyboard. Constraints: PRODUCT.md pinned aesthetic, D-025 stack, D-029 primitives, brand token and logos, loopback only, strict CSP, no web fonts, nothing copied from another product.

## Settings (MET-28)
An extension of this surface: a sub-nav (Harnesses, Connections, Team), one card per harness or connection with its service logo, state badge, details, fix and actions, a Team table that saves through the validator, and a Start banner while the loop is in setup. Job: get from a fresh machine to a running loop in a few clicks. No secret is ever shown or typed.

## Direction contract
THESIS: harnessd is a dense, quiet, keyboard-first tool. A sidebar, a status header and a Cmd+K palette that every developer knows; tight rows; real service logos in one color. It refuses the decorated kanban and the custom one-off look of MET-18.
OWN-WORLD: zinc neutrals on near-white, true black in dark, one accent behind the --brand token, 8 px controls, 12 px cards, soft overlay shadows, system sans at 14 px, lucide icons, Simple Icons service logos in the text color. Red belongs to Needs you alone; amber to budget and paused.
STORY: The owner opens the app, reads the red Needs you count in the header and sidebar, scans the board, checks agents and logs from the sidebar, pauses from the header, and runs anything else from Cmd+K.
FIRST VIEWPORT: 224 px sidebar left (Board, Agents, Logs, Settings; Commands at the foot). 52 px header with title, connection, Needs you button and the pause control at its right edge. Board columns fill the rest, Needs you first.
FORM: operator app shell, pinned by the owner. seed: none (pinned) "Dense, quiet, keyboard-first and professional"; "One token set for color, type scale, spacing, radius and motion"; "Build an app shell: a left sidebar (Board, Agents, Logs, Settings), a header with the pause control always visible, and a Cmd+K command palette with every action."
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
