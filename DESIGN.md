---
name: harnessd
description: Dense, quiet operator UI for a local team of coding agents.
colors:
  ground: "#f3f4f6"
  surface: "#ffffff"
  surface-2: "#eaecf0"
  line: "#dadde3"
  line-strong: "#b9bec8"
  text: "#14171c"
  text-2: "#464d5a"
  text-3: "#5a6170"
  accent: "#2847c7"
  band: "#1a2130"
  band-text: "#e8ebf1"
  band-paused: "#7a4500"
  band-live: "#5fd39a"
  band-pending: "#f2b85b"
  signal: "#b3261e"
  signal-bg: "#fcebea"
  signal-line: "#e7a6a1"
  warn: "#8a4f00"
  warn-fill: "#b86b00"
  ok: "#157347"
  dark-ground: "#101318"
  dark-surface: "#161a21"
  dark-text: "#e6e9ef"
  dark-text-3: "#9199a7"
  dark-signal: "#ff9b93"
  dark-band: "#0b0e13"
typography:
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.4
  heading:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 650
    lineHeight: 1.4
  meta:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.4
  brand:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 650
    lineHeight: 1.4
    letterSpacing: "-0.01em"
  tag:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: "16px"
  data:
    fontFamily: "ui-monospace, SF Mono, Menlo, Consolas, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: "18px"
rounded:
  xs: "2px"
  sm: "3px"
  md: "4px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
components:
  band:
    backgroundColor: "{colors.band}"
    textColor: "{colors.band-text}"
    height: "44px"
  band-paused:
    backgroundColor: "{colors.band-paused}"
    textColor: "{colors.band-text}"
  button-kill:
    backgroundColor: "#f3f5f9"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    height: "28px"
  button:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    height: "28px"
    padding: "0 10px"
  issue-row:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: "7px 9px 8px"
  issue-row-loud:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.signal}"
  column-needs-you:
    backgroundColor: "{colors.signal-bg}"
    textColor: "{colors.signal}"
  region-head:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    height: "34px"
---

## Overview
harnessd's UI is an Operate surface (PRODUCT.md): one page that answers what runs, what is blocked and what needs the owner. It reads like the stock tables of a financial page. Every state and figure sits in a fixed column on one baseline, so a glance finds what changed. The world adds only type, palette, density and one move; the layout, the controls and the navigation are standard.

The signature move: the **Needs you** column, set in the one signal ink, sits first on the board, and the header band carries the kill switch and turns amber while paused.

## Colors
Restrained: cool ink-on-newsprint neutrals, never cream, plus four colors that each do one job.
- **Band** (`band`): the header across the top. It holds the name, the connection, the needs-you count and the pause control. It becomes `band-paused` (amber) while paused, so the state is visible from across the room.
- **Signal** (`signal`, `signal-bg`, `signal-line`): only for Needs input and Blocked. Nothing else on screen is red.
- **Warn** (`warn`, `warn-fill`): budgets at 80 percent or more, stopping runs and warning log lines.
- **Ok** (`ok`): the running-agent marker on a board row. In the band, `band-live` and `band-pending` color the connection dot.
- **Accent** (`accent`): the focus ring and nothing else.

Dark theme tokens mirror the light ones under `prefers-color-scheme: dark` and `[data-theme="dark"]` (see `packages/ui/app/src/styles.css`). Every text pair meets WCAG AA (4.5:1); lines are hairlines and carry no meaning alone.

## Typography
One system sans at 13 px for everything a person reads, 12 px for meta, 11 px for tags. The name in the band is 14 px. Weight, not size, makes hierarchy: 650 for region headings, 600 for column heads and agent names. Monospace is used only for data: issue keys, log times and log lines. All figures use tabular numerals, so ticking times never shift their column.

## Layout
A fixed viewport app: band (44 px), then the board (three fifths), then a split of agents (left) and log (right). Each region scrolls inside itself; the page never scrolls sideways. The board has six columns of at least 208 px: Needs you, Backlog, Ready, In Progress, In Review, Done. Below 900 px the regions stack and the page scrolls; below 560 px each column takes most of the width and snaps.

Spacing steps: 4, 8, 12, 16 px. Rows sit 6 px apart in a column; regions have 16 px side gutters.

## Elevation & Depth
None. Depth is a 1 px line and a change of ground (`ground` behind the board, `surface` for rows and panels). No shadows, no blur.

## Shapes
4 px radius on rows, buttons and the alert pill; 3 px on tags; 2 px (`xs`) on the budget bar. No pills wider than their text.

## Components
- **Issue row**: a link to Linear. Line one: key, priority (Urgent in bold, High plain; never red), size, and the running agent at the right. Line two: the title, two lines at most. Line three, when it applies: the Needs-you reason, what it waits on, or its parent.
- **Agent table**: a real table with fixed columns: agent, task (key, title, latest action), elapsed, budget used (bar, percent, budget; the percent passes 100 when a run is over), tokens. Idle agents say Idle.
- **Log**: time, source, text in monospace. It follows the end until the reader scrolls up; then it holds still and offers a button with the count of new lines.
- **Pause control**: always in the band at the right. The label and the band change on the click, before the API answers. The notice to its left says what happened (runs stopped, worktrees kept) and is a live region.
- **Held updates**: while the pointer or focus is in the board or the agent table, live changes wait. A "Show N updates" button in the region head applies them; leaving the region applies them too.
- **Skip links**: the first two tab stops jump to Agents and Log, past the board's links.
- **States**: every region has a skeleton for loading, a sentence for empty that says what fills it, and an error sentence with Retry.

## Do's and Don'ts
- Do keep red for Needs you. Do keep amber for budget, stopping and paused.
- Do give every number tabular figures and a fixed column.
- Do use authored 16 px SVG icons with a 1.5 px stroke, always next to a text label.
- Don't add gradients, shadows, glass, emoji, eyebrow labels or decorative illustration.
- Don't move content under the cursor: hold it, or append below the visible area.
- Don't add a modal or a confirmation to pause; it is the kill switch and must act at once.
