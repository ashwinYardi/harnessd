# D-025 UI stack: Tailwind v4, Base UI, CVA, lucide-react
Status: accepted 2026-11-20; the source of the primitives and the accent token are amended by D-029. Extends D-003 and D-024. Replaces the MET-18 visual world: hand-written CSS, authored icons, no shadows. No earlier record named a "no CSS framework" rule; it was the practice of MET-18 and the old DESIGN.md, which this record and the new DESIGN.md replace.

- The UI uses Tailwind v4 (`@tailwindcss/vite`), Base UI (`@base-ui/react`), class-variance-authority and lucide-react. `tailwind-merge` resolves class conflicts in `cn()`.
- The primitives live in `packages/ui/app/src/components/ui/`. D-029 says where they come from. `packages/ui/THIRD_PARTY_NOTICES.md` holds every license.
- The tokens: color roles, zinc and neutral ramps, one accent, a radius scale, type steps and one motion curve. Three tokens take the darker step for WCAG AA: muted text (zinc-600), warning text (amber-800) and the destructive fill (red-600). DESIGN.md records every token and its contrast.
- Overlays (dialog, popover, toast, tooltip) take soft drop shadows. Glass and backdrop blur stay out (AGENTS.md: no glass).
- The page keeps its strict CSP. Base UI renders one fixed inline `<style>` (the scrollbar rule of the scroll area and select). The CSP allows that one hash. A test in `packages/ui/src/csp.test.ts` fails when a Base UI update changes the text.
- Tailwind builds at `vite build`. The daemon still serves only the built files (D-024). No runtime CSS-in-JS.

Why:
- The MET-18 UI was below the bar the owner set: dense, quiet, keyboard-first and professional. A shared, proven component system closes that gap faster than more hand-written CSS.
- Jakob's law: a left sidebar, a status header and a Cmd+K palette are what developers already know from their tools.
- Base UI gives accessible dialogs, selects, tabs, switches, tooltips and toasts with focus management, so harnessd does not hand-roll them.
- All four libraries are MIT or ISC licensed, run in the browser only and are not vendor SDKs (D-002).

Issue: MET-29.
