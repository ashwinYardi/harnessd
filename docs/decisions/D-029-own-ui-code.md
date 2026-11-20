# D-029 The UI owns its code: shadcn/ui primitives, a brand token and real service logos
Status: accepted 2026-11-20. Amends D-025. Issue: MET-32.

- **Primitives.** Every file in `packages/ui/app/src/components/ui/` starts from the shadcn/ui base-nova registry (`npx shadcn add`, Base UI variant, MIT). harnessd then changes it, and the file header lists the changes. The exported names follow shadcn/ui (`DialogContent`, `TooltipContent`, `SelectContent`, `CardContent`, `TabsTrigger`, `TabsContent`). No file names or credits another product.
- **What stays harnessd's own.** The command palette keeps its own combobox on a Base UI dialog and `lib/commands.ts`, not cmdk, so its keys and tests do not change. The toast keeps one flat stack of four. The sidebar keeps the static parts only. Motion uses Base UI's starting and ending styles, not an animation plugin.
- **Brand token.** The accent is one line: `--brand: light-dark(<light>, <dark>)` in `index.css`, with `--brand-foreground`. `--primary` and `--ring` read it. The brand accent from D-027 (MET-31) drops in by changing that line. `lib/tokens.test.ts` checks that white text on both values meets WCAG AA. If the new accent needs dark text, `--brand-foreground` changes with it.
- **Service logos.** GitHub, Linear, Slack, Claude, OpenAI (for Codex) and git show their logos from Simple Icons (`simple-icons`, CC0). Only the six used icons are imported. Version 16 dropped Slack and OpenAI, so those two paths are copied unchanged from version 15.22.0 into `lib/service-paths.ts`. The git logo is CC BY 3.0 and is credited in the notices.
- **Logo color.** Every logo is one color, the text color around it. Each brand's guidelines allow a one-color logo. It keeps the text's contrast in both themes. Brand colors stay out, because red, amber and green carry state.
- **Logo label.** A logo always sits next to the service's name. The logo is then `aria-hidden`; with no name next to it, it has its own accessible name.
- **Public repo.** AGENTS.md says what may go in this public repo: original work, or work from a source made for reuse with its license noted. Nothing copied from another product, no secrets, no personal data, no local paths, no session links.

Why:
- harnessd is public and MIT. Its UI code must come from sources made to be copied, under licenses that allow it.
- Developers find a service by its logo before they read its name.
- One-color logos keep the page quiet and keep color for state (DESIGN.md).

Numbering: two open branches both use D-027, so one of them will take D-028. This record is D-029.
