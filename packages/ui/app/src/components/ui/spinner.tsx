// From shadcn/ui, base-nova registry (MIT; see packages/ui/THIRD_PARTY_NOTICES.md).
// harnessd changes: aria-hidden, because each caller says in text what is loading; the spin
// runs only when motion is allowed.
import { LoaderCircleIcon } from "lucide-react";
import type * as React from "react";
import { cn } from "../../lib/cn.ts";

function Spinner({ className, ...props }: React.ComponentProps<typeof LoaderCircleIcon>) {
  return (
    <LoaderCircleIcon
      aria-hidden="true"
      className={cn("size-4 motion-safe:animate-spin", className)}
      data-slot="spinner"
      {...props}
    />
  );
}

export { Spinner };
