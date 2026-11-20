// Ported from T3 Code, apps/web/src/components/ui/toast.tsx (https://github.com/pingdotgg/t3code).
// Copyright (c) 2026 T3 Tools Inc. MIT License; see packages/ui/THIRD_PARTY_NOTICES.md.
// Changes: one flat stack at the bottom right, no swipe stacking, no copy or thread actions,
// and enter and exit motion of 150 ms. Async results go through toast.add() (DESIGN.md).
import { Toast } from "@base-ui/react/toast";
import { CircleAlertIcon, CircleCheckIcon, InfoIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/cn.ts";
import { Spinner } from "./spinner.tsx";

export type ToastType = "success" | "error" | "warning" | "info" | "loading";

/** The one toast manager. Code outside React calls toast.add() and toast.close(). */
export const toast = Toast.createToastManager();

const ICONS: Record<ToastType, ReactNode> = {
  success: <CircleCheckIcon className="text-success-foreground" />,
  error: <CircleAlertIcon className="text-destructive-foreground" />,
  warning: <TriangleAlertIcon className="text-warning-foreground" />,
  info: <InfoIcon className="text-info-foreground" />,
  loading: <Spinner className="text-muted-foreground" />,
};

function ToastList() {
  const { toasts } = Toast.useToastManager();
  return (
    <Toast.Portal data-slot="toast-portal">
      <Toast.Viewport
        aria-label="Notifications"
        className="fixed right-4 bottom-4 z-100 flex w-[calc(100%-2rem)] max-w-90 flex-col-reverse gap-2"
        data-slot="toast-viewport"
      >
        {toasts.map((t) => (
          <Toast.Root
            className={cn(
              "relative w-full select-none rounded-lg border bg-popover text-popover-foreground shadow-lg/5 not-dark:bg-clip-padding",
              "transition-[opacity,translate] duration-150 ease-out data-starting-style:translate-y-2 data-starting-style:opacity-0 data-ending-style:opacity-0",
            )}
            key={t.id}
            toast={t}
          >
            <Toast.Content className="flex items-start gap-2 py-2.5 pr-8 pl-3 text-sm">
              {t.type && (
                <span className="flex h-lh w-4 shrink-0 items-center [&_svg]:size-4">
                  {ICONS[t.type as ToastType]}
                </span>
              )}
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <Toast.Title className="wrap-break-word font-medium" data-slot="toast-title" />
                <Toast.Description
                  className="wrap-break-word text-muted-foreground text-xs"
                  data-slot="toast-description"
                />
              </div>
              <Toast.Close
                aria-label="Dismiss"
                className="absolute top-2 right-2 inline-flex size-5 cursor-pointer items-center justify-center rounded-sm text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                <XIcon className="size-3" />
              </Toast.Close>
            </Toast.Content>
          </Toast.Root>
        ))}
      </Toast.Viewport>
    </Toast.Portal>
  );
}

function ToastProvider({ children }: { children: ReactNode }) {
  return (
    <Toast.Provider limit={4} toastManager={toast}>
      {children}
      <ToastList />
    </Toast.Provider>
  );
}

export { ToastProvider };
