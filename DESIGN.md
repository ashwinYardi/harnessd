---
name: harnessd
description: Dense, quiet, keyboard-first operator UI for a local team of coding agents (D-025, D-029).
colors:
  background: "zinc-25 oklch(99.2% 0 0)"
  foreground: "zinc-900"
  card: "white"
  popover: "white"
  brand: "light-dark(oklch(0.488 0.217 264), oklch(0.571 0.21 264))"
  brand-foreground: "white"
  primary: "brand"
  primary-foreground: "brand-foreground"
  secondary: "zinc-50"
  muted: "zinc-50"
  muted-foreground: "zinc-600"
  placeholder: "zinc-500"
  accent: "zinc-100"
  border: "zinc-200"
  input: "zinc-300"
  ring: "brand"
  destructive: "red-600"
  error: "red-500"
  error-foreground: "red-700"
  error-surface: "red-500 at 8%"
  warning: "amber-500"
  warning-foreground: "amber-800"
  warning-surface: "amber-500 at 8%"
  success: "emerald-500"
  success-foreground: "emerald-700"
  info-foreground: "blue-700"
  sidebar: "zinc-50"
  sidebar-row-hover: "zinc-100"
  sidebar-row-active: "white"
  dark-background: "#000"
  dark-foreground: "neutral-100"
  dark-card: "neutral-950 + 3% white"
  dark-muted-foreground: "neutral-400"
  dark-border: "white at 8%"
  dark-input: "white at 14%"
  dark-error-foreground: "red-400"
  dark-warning-foreground: "amber-400"
  dark-success-foreground: "emerald-400"
typography:
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.4
  heading:
    fontSize: "14px"
    fontWeight: 600
  meta:
    fontSize: "12px"
  tag:
    fontSize: "11px"
  data:
    fontFamily: "ui-monospace, SF Mono, Menlo, Consolas, monospace"
    fontSize: "12px"
    lineHeight: "18px"
rounded:
  sm: "4px"
  md: "6px"
  lg: "8px (--radius, --control-radius)"
  xl: "12px"
  2xl: "16px"
spacing:
  base: "4px (Tailwind --spacing)"
  control-height: "32px default, 28px sm, 24px xs"
  header: "52px"
  sidebar: "224px, 48px icon rail below 768px"
motion:
  fast: "100ms (hover, tooltip, sidebar row)"
  base: "150ms (button, dialog, toast, select, tabs)"
  max: "200ms (switch, theme change)"
  ease: "ease-out; drawer cubic-bezier(0.32, 0.72, 0, 1)"
  reduced: "prefers-reduced-motion stops every transition and animation"
components:
  button: "components/ui/button.tsx: default, outline, secondary, ghost, ghost-muted, destructive, warning-outline, link"
  service-logo: "components/service-logo.tsx: ServiceLogo and HarnessName"
  badge: "components/ui/badge.tsx"
  card: "components/ui/card.tsx"
  dialog: "components/ui/dialog.tsx"
  tooltip: "components/ui/tooltip.tsx"
  toast: "components/ui/toast.tsx"
  input: "components/ui/input.tsx"
  select: "components/ui/select.tsx"
  switch: "components/ui/switch.tsx"
  tabs: "components/ui/tabs.tsx"
  sidebar: "components/ui/sidebar.tsx"
  scroll-area: "components/ui/scroll-area.tsx"
  skeleton: "components/ui/skeleton.tsx"
  kbd: "components/ui/kbd.tsx"
  command-palette: "components/ui/command.tsx"
---

## Overview
harnessd's UI is an Operate surface (PRODUCT.md). It answers three questions fast: what runs, what is blocked, and what needs the owner. It is dense, quiet, keyboard-first and professional. It is built on Tailwind v4, Base UI, CVA and lucide-react (D-025). The primitives come from the shadcn/ui Base UI registry, with harnessd's changes (D-029). One signature: **Needs you** is the only loud thing on screen.

## Colors
Restrained: zinc neutrals in light, true black and neutral in dark, one accent, and three state colors that each do one job.
- **Brand** (blue for now): the `--brand` token family in `index.css`. `--primary` and `--ring` read it. It fills the default button, focus rings, the switch and the budget bar under 80 percent. Nothing else. The brand accent replaces it by changing the one `--brand` line (light value, then dark value) and, if needed, `--brand-foreground`. `lib/tokens.test.ts` checks AA for both values.
- **Service logos**: GitHub, Linear, Slack, Claude, OpenAI and git, in the current text color. Never in a brand color, so the state colors keep their meaning.
- **Destructive and error** (red): only Needs you, Blocked, blocking checks (fail and missing, D-023) and failed calls. The Needs you column, its count in the sidebar and the header button are red. Nothing else is red.
- **Warning** (amber): budgets at 80 percent or more, stopping runs, warning log lines, warn checks, and the header while paused.
- **Success** (emerald): the live connection dot, the running-agent dot, ok checks and success toasts.

Text contrast, computed from the Tailwind v4 oklch values (WCAG 2.1, sRGB compositing):

| Pair | Light | Dark |
|---|---|---|
| foreground on background | 17.3 | 19.3 |
| muted-foreground on background | 7.6 | 8.1 |
| muted-foreground on accent or card | 7.0 | 7.3 |
| placeholder on background | 4.7 | 8.1 |
| white on brand | 6.7 | 4.6 |
| white on destructive | 4.8 | 4.8 |
| error-foreground on error-surface | 5.7 | 6.4 |
| warning-foreground on warning-surface | 6.7 | 10.0 |
| success-foreground on success surface | 5.0 | 10.9 |

Three tokens take the darker step so every pair passes 4.5:1: muted-foreground (zinc-600), warning-foreground (amber-800) and destructive (red-600). A service logo takes the text color around it, so it keeps that text's contrast.

## Typography
One system sans. 14 px (`text-sm`) for anything a person reads, 12 px (`text-xs`) for meta, 11 px (`text-2xs`) for tags. Weight makes hierarchy: 600 for headings and column heads, 500 for buttons and active nav. Monospace only for data: issue keys, check ids, log lines and tool actions. All figures are tabular.

## Layout
- **App shell:** a 224 px sidebar on the left (Board, Agents, Logs, Settings, then Commands at the foot). Below 768 px it becomes a 48 px icon rail with tooltips and status dots.
- **Header:** 52 px, across the content. The view title, the connection, the last poll, the Needs you button and the pause control at the right edge. While paused it turns amber.
- **Board:** six columns that share the width, at least 176 px each, then scroll sideways. Needs you is first. Each column scrolls inside itself.
- **Agents:** one table in a card, fixed columns.
- **Logs:** one card, mono lines, time and source in fixed columns.
- Spacing is Tailwind's 4 px scale. Views have 16 px gutters.

## Elevation and depth
A 1 px border and a change of surface first. Controls take a faint `shadow-xs/5`. Overlays (dialog, popover, select, toast, tooltip) take a soft drop shadow with a real offset. No glass, no backdrop blur, no glow.

## Shapes
8 px radius on controls and inputs, 12 px on cards and board columns, 16 px on dialogs and the command palette, 4 px on badges.

## Components
- **Button** (CVA): default (primary), outline, secondary, ghost, ghost-muted, destructive, warning-outline, link. Sizes default 32 px, sm 28 px, xs 24 px, icon 32 px. Press scales to 0.97.
- **Pause control:** always in the header at the right. Outline with a pause icon while running; primary "Resume" while paused. The click changes the header and the label at once (optimistic). The daemon's answer confirms it. A failure rolls back and shows an error toast. Never a confirmation.
- **Service logo** (`components/service-logo.tsx`): a 16 px Simple Icons mark in `currentColor`, before the service's name on Harnesses and Connections cards; 14 px before the harness id in the agent list and the Team table. The text label is always there, so the logo is `aria-hidden`; `named` gives it its own accessible name where no text sits next to it. Port and skills show text only. In the agent list and the Team table, a harness with no mark keeps an empty 14 px slot, so every name starts at one edge.
- **Command palette:** Cmd+K or Ctrl+K, or Commands in the sidebar. It lists every action: pause or resume, each view, run the checks again, read the board again, load the log again, and the three themes. Up, Down, Home, End, Enter, Esc.
- **Toasts:** bottom right, at most four, 5 s. Every async result gets one: pause, resume, check again. A Copy button is the one exception: its label reads "Copied" for 1.5 s, and a toast shows only when the copy fails.
- **Held updates:** while the pointer or focus is in the board or the agent table, live changes wait. A "Show N updates" button applies them.
- **States:** every view has a skeleton for loading, a sentence for empty that says what fills it, and an error card with Retry.

## UX checklist
Each item is met where it says. Check it again on every UI change.

| Rule | Where it is met |
|---|---|
| Nielsen 1, visibility of system status | Header: connection dot, last poll, paused band. Sidebar counts. Toasts for each result. Skeletons while loading. |
| Nielsen 2, match with the real world | The words of the domain (GLOSSARY.md): Needs you, Blocked, run, budget used, check. |
| Nielsen 3, user control and freedom | Resume undoes Pause. Esc closes the palette and dialogs. Back and Forward move between views (hash routes). |
| Nielsen 4, consistency and standards | One set of primitives from shadcn/ui; the platform's own keys (Cmd+K, Esc, arrows); one density. |
| Nielsen 5, error prevention | Pause never needs a confirm, but a second click while a call is in flight does nothing (`aria-disabled`). Disabled palette items do not run. |
| Nielsen 6, recognition over recall | Sidebar with labels; palette lists every action with its group; key hints at the foot of the palette. |
| Nielsen 7, flexibility and efficiency | Cmd+K palette; skip link; every control works by keyboard. |
| Nielsen 8, aesthetic and minimal design | One loud color for Needs you; no decoration; meta in muted text. |
| Nielsen 9, help users recover from errors | Error cards name the problem and offer Retry. Failed checks show their fix. Failed pause says the agents still run. |
| Nielsen 10, help and documentation | Tooltips on the icon rail and the connection dot; the Settings view states it runs the doctor checks. |
| Jakob's law | The layout developers know from their tools: a left sidebar, a header with status, Cmd+K for every action. Each service shows its own logo. |
| Fitts's law | The pause control is a 32 px button at the header's right edge, at least 112 px wide. The Needs you button sits next to it. Sidebar rows span the full rail width. On coarse pointers every control has a 44 px hit area. |
| Hick's law | Four views. The palette narrows by typed words. Each view shows one primary action at most. |
| Gestalt grouping | Board columns are bounded cards; agent rows share one table; palette items sit under group headings. |
| Progressive disclosure | Issue rows show key, title and one status line; Linear holds the rest (opens on click). The external-link icon shows only on hover. |
| All interaction states | Hover, active (scale 0.97 on buttons, row tint on nav), focus-visible (2 px ring), disabled (64 percent opacity), loading (skeletons and spinners), empty, error: in every primitive and view. |
| Motion at 200 ms or less | Durations are 100, 150 and 200 ms (see motion tokens). `prefers-reduced-motion` stops them all (`index.css`). |
| Optimistic pause with rollback | `lib/pause.ts` and `hooks/usePause.ts`; tested in `lib/pause.test.ts`. |
| Toasts for async results | `components/ui/toast.tsx`; pause, resume and check again. |
| Live updates never move content under the cursor | Held updates in Board and Agents; the log holds still while scrolled up or under the pointer. |
| WCAG AA | The contrast table above; focus is always visible; skip link; landmarks and labels. |

## Do's and Don'ts
- Do keep red for Needs you, Blocked and failures. Do keep amber for budget, stopping, warn and paused.
- Do use lucide icons at 16 px, next to a text label or with a tooltip. Inside 12 px meta lines (issue reasons, the external-link hint) they shrink to 12 px.
- Do build every new control from `components/ui`. Add a variant with CVA before a one-off class list.
- Don't add gradients, glass, backdrop blur, emoji, eyebrow labels or decorative illustration.
- Don't move content under the cursor: hold it, or append below the visible area.
- Don't add a modal or a confirmation to pause; it is the kill switch and must act at once.
- Do put a service's logo next to its name, in one color.
- Don't copy another product's name, logo, copy or screenshots into the UI or its docs (AGENTS.md, "What goes in this public repo").
- Don't color a service logo, and don't use a logo without its name.
