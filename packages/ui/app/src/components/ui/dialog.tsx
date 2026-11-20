// Ported from T3 Code, apps/web/src/components/ui/dialog.tsx and dialog-styles.ts
// (https://github.com/pingdotgg/t3code).
// Copyright (c) 2026 T3 Tools Inc. MIT License; see packages/ui/THIRD_PARTY_NOTICES.md.
// Changes: no glass or blur (DESIGN.md), no media variant, no retained popup, no nested scaling.
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { XIcon } from "lucide-react";
import type * as React from "react";
import { cn } from "../../lib/cn.ts";
import { Button } from "./button.tsx";

export const DIALOG_BACKDROP_CLASS =
  "fixed inset-0 z-50 bg-black/32 transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0 dark:bg-black/64";
export const DIALOG_POPUP_CLASS =
  "relative flex min-h-0 w-full min-w-0 flex-col rounded-2xl border bg-popover not-dark:bg-clip-padding text-popover-foreground shadow-xl/10 outline-none transition-[scale,opacity] duration-150 ease-out data-ending-style:scale-98 data-starting-style:scale-98 data-ending-style:opacity-0 data-starting-style:opacity-0";

const Dialog = DialogPrimitive.Root;

function DialogTrigger(props: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogClose(props: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogPopup({
  className,
  children,
  showCloseButton = true,
  ...props
}: DialogPrimitive.Popup.Props & { showCloseButton?: boolean }) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Backdrop className={DIALOG_BACKDROP_CLASS} data-slot="dialog-backdrop" />
      <DialogPrimitive.Viewport className="fixed inset-0 z-50 grid grid-rows-[1fr_auto_3fr] justify-items-center p-4">
        <DialogPrimitive.Popup
          className={cn(DIALOG_POPUP_CLASS, "row-start-2 max-h-full max-w-lg", className)}
          data-slot="dialog-popup"
          {...props}
        >
          {children}
          {showCloseButton && (
            <DialogPrimitive.Close
              aria-label="Close"
              className="absolute end-2 top-2"
              render={<Button size="icon-sm" variant="ghost" />}
            >
              <XIcon />
            </DialogPrimitive.Close>
          )}
        </DialogPrimitive.Popup>
      </DialogPrimitive.Viewport>
    </DialogPrimitive.Portal>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("flex flex-col gap-1.5 p-5 pb-3", className)}
      data-slot="dialog-header"
      {...props}
    />
  );
}

function DialogPanel({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div className={cn("space-y-3 px-5 pb-5", className)} data-slot="dialog-panel" {...props} />
  );
}

function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex flex-col-reverse gap-2 rounded-b-[calc(var(--radius-2xl)-1px)] border-t bg-muted/72 px-5 py-3 sm:flex-row sm:justify-end",
        className,
      )}
      data-slot="dialog-footer"
      {...props}
    />
  );
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      className={cn("font-semibold text-base leading-snug", className)}
      data-slot="dialog-title"
      {...props}
    />
  );
}

function DialogDescription({ className, ...props }: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      className={cn("text-muted-foreground text-sm", className)}
      data-slot="dialog-description"
      {...props}
    />
  );
}

export {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
};
