// A service's logo, drawn in the current text color (D-029). Monochrome is allowed by every
// brand here, keeps the text contrast in both themes, and leaves color to the state roles.
import type * as React from "react";
import { cn } from "../lib/cn.ts";
import { harnessService, SERVICES, type ServiceId } from "../lib/services.ts";

interface ServiceLogoProps extends Omit<React.ComponentProps<"svg">, "children"> {
  service: ServiceId;
  /**
   * Give the logo its own accessible name. Leave it off when a text label sits next to the
   * logo, so a screen reader does not say the name twice.
   */
  named?: boolean;
}

export function ServiceLogo({ service, named = false, className, ...props }: ServiceLogoProps) {
  const s = SERVICES[service];
  return (
    <svg
      aria-hidden={named ? undefined : true}
      aria-label={named ? s.name : undefined}
      className={cn("size-4 shrink-0", className)}
      data-service={service}
      fill="currentColor"
      focusable="false"
      role={named ? "img" : undefined}
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <path d={s.path} />
    </svg>
  );
}

/** A harness id with its maker's logo in front, when harnessd has one. */
export function HarnessName({ harness, className }: { harness: string; className?: string }) {
  const service = harnessService(harness);
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5", className)}>
      {/* A harness with no logo keeps an empty slot, so every name in a list starts at one edge. */}
      {service ? (
        <ServiceLogo className="size-3.5" service={service} />
      ) : (
        <span aria-hidden="true" className="size-3.5 shrink-0" />
      )}
      <span className="truncate">{harness}</span>
    </span>
  );
}
