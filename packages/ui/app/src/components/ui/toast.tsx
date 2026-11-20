// From shadcn/ui, base-nova registry (MIT; see packages/ui/THIRD_PARTY_NOTICES.md).
// harnessd changes: one flat stack at the bottom right with at most four toasts, no swipe or
// peek transforms, 150 ms enter and exit, an 8 px radius, and icons in the state colors.
// Every async result goes through toast.add() (DESIGN.md).
import { Toast as ToastPrimitive } from "@base-ui/react/toast";
import { CircleAlertIcon, CircleCheckIcon, InfoIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/cn.ts";
import { Spinner } from "./spinner.tsx";

export type ToastType = "success" | "error" | "warning" | "info" | "loading";

/** The one toast manager. Code outside React calls toast.add() and toast.close(). */
export const toast = ToastPrimitive.createToastManager();

const ICONS: Record<ToastType, ReactNode> = {
  success: <CircleCheckIcon className="text-success-foreground" />,
  error: <CircleAlertIcon className="text-destructive-foreground" />,
  warning: <TriangleAlertIcon className="text-warning-foreground" />,
  info: <InfoIcon className="text-info-foreground" />,
  loading: <Spinner className="text-muted-foreground" />,
};

function ToastIcon({ type }: { type: string | undefined }) {
  const icon = type ? ICONS[type as ToastType] : undefined;
  if (!icon) return null;
  return (
    <span
      aria-hidden="true"
      className="flex h-lh w-4 shrink-0 items-center [&_svg]:size-4"
      data-slot="toast-icon"
    >
      {icon}
    </span>
  );
}

function ToastList() {
  const { toasts } = ToastPrimitive.useToastManager();
  return toasts.map((t) => (
    <ToastPrimitive.Root
      className={cn(
        "relative w-full select-none rounded-lg border bg-popover text-popover-foreground shadow-lg/5 outline-none not-dark:bg-clip-padding focus-visible:ring-2 focus-visible:ring-ring",
        "transition-[opacity,translate] duration-150 ease-out data-limited:hidden data-ending-style:opacity-0 data-starting-style:translate-y-2 data-starting-style:opacity-0",
      )}
      data-slot="toast"
      key={t.id}
      toast={t}
    >
      <ToastPrimitive.Content
        className="flex items-start gap-2 py-2.5 pr-8 pl-3 text-sm"
        data-slot="toast-content"
      >
        <ToastIcon type={t.type} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <ToastPrimitive.Title className="wrap-break-word font-medium" data-slot="toast-title" />
          <ToastPrimitive.Description
            className="wrap-break-word text-muted-foreground text-xs"
            data-slot="toast-description"
          />
        </div>
        <ToastPrimitive.Close
          aria-label="Dismiss"
          className="absolute top-2 right-2 inline-flex size-5 cursor-pointer items-center justify-center rounded-sm text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          data-slot="toast-close"
        >
          <XIcon aria-hidden="true" className="size-3" />
        </ToastPrimitive.Close>
      </ToastPrimitive.Content>
    </ToastPrimitive.Root>
  ));
}

function ToastProvider({ children }: { children: ReactNode }) {
  return (
    <ToastPrimitive.Provider limit={4} toastManager={toast}>
      {children}
      <ToastPrimitive.Portal data-slot="toast-portal">
        <ToastPrimitive.Viewport
          aria-label="Notifications"
          className="fixed right-4 bottom-4 z-100 flex w-[calc(100%-2rem)] max-w-sm flex-col-reverse gap-2 outline-none"
          data-slot="toast-viewport"
        >
          <ToastList />
        </ToastPrimitive.Viewport>
      </ToastPrimitive.Portal>
    </ToastPrimitive.Provider>
  );
}

export { ToastProvider };
