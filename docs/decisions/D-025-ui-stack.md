# D-025 UI stack after T3 Code: Tailwind v4, Base UI, CVA, lucide-react
Status: accepted 2026-11-20. Extends D-003 and D-024. Replaces the MET-18 visual world: hand-written CSS, authored icons, no shadows.

- The UI uses Tailwind v4 (`@tailwindcss/vite`), Base UI (`@base-ui/react`), class-variance-authority and lucide-react, as T3 Code (pingdotgg/t3code) does. `tailwind-merge` resolves class conflicts in `cn()`.
- The primitives live in `packages/ui/app/src/components/ui/`. Most are ports of T3 Code's `apps/web/src/components/ui`. Each ported file names its source and keeps the MIT notice. `packages/ui/THIRD_PARTY_NOTICES.md` holds the full licence text.
- The tokens follow T3 Code's `index.css`: the color roles, the zinc and neutral ramps, the primary blue, the radius scale, the type steps and the motion curve. Three tokens move one step darker for WCAG AA: muted text (zinc-600), warning text (amber-800) and the destructive fill (red-600). DESIGN.md records every token and its contrast.
- Overlays (dialog, popover, toast, tooltip) take T3 Code's soft drop shadows. Glass and backdrop blur stay out (AGENTS.md: no glass).
- We do not copy T3 Code's name, logo, brand, fonts or copy.
- The page keeps its strict CSP. Base UI renders one fixed inline `<style>` (the scrollbar rule of the scroll area and select). The CSP allows that one hash. A test in `packages/ui/src/csp.test.ts` fails when a Base UI update changes the text.
- Tailwind builds at `vite build`. The daemon still serves only the built files (D-024). No runtime CSS-in-JS.

Why:
- The owner judged the MET-18 UI far below T3 Code. A shared, proven component system closes that gap faster than more hand-written CSS.
- Jakob's law: the owner uses T3 Code daily. The same controls, density and keys make harnessd familiar at once.
- Base UI gives accessible dialogs, selects, tabs, switches, tooltips and toasts with focus management, so harnessd does not hand-roll them.
- All four libraries are MIT licensed, run in the browser only and are not vendor SDKs (D-002).

Issue: MET-29.
