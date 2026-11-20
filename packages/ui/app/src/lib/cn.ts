// Joins class names and resolves Tailwind conflicts, so a caller's class wins over a default.
// The shadcn/ui cn() helper (MIT; see THIRD_PARTY_NOTICES.md), with cva's cx in place of clsx.
import { type CxOptions, cx } from "class-variance-authority";
import { extendTailwindMerge } from "tailwind-merge";

// text-2xs and text-3xs are font sizes, not colors.
const twMerge = extendTailwindMerge({ extend: { theme: { text: ["2xs", "3xs"] } } });

export function cn(...inputs: CxOptions): string {
  return twMerge(cx(inputs));
}
