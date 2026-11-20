// Ported from T3 Code, apps/web/src/components/ui/command.tsx (https://github.com/pingdotgg/t3code).
// Copyright (c) 2026 T3 Tools Inc. MIT License; see packages/ui/THIRD_PARTY_NOTICES.md.
// Changes: a plain combobox and listbox in a Base UI dialog, in place of the Autocomplete
// primitive; matching is lib/commands.ts. Keys: Up, Down, Home, End, Enter, Esc.
import { Dialog as CommandDialogPrimitive } from "@base-ui/react/dialog";
import { ArrowDownIcon, ArrowUpIcon, SearchIcon } from "lucide-react";
import { type KeyboardEvent, useId, useMemo, useRef, useState } from "react";
import { cn } from "../../lib/cn.ts";
import { type Command, matchCommands, nextEnabled } from "../../lib/commands.ts";
import { DIALOG_BACKDROP_CLASS, DIALOG_POPUP_CLASS } from "./dialog.tsx";
import { Kbd, KbdGroup } from "./kbd.tsx";

interface CommandPaletteProps<T extends Command> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  commands: readonly T[];
  onRun: (command: T) => void;
  placeholder?: string;
}

function CommandPalette<T extends Command>({
  open,
  onOpenChange,
  commands,
  onRun,
  placeholder = "Type a command",
}: CommandPaletteProps<T>) {
  // Opened by a shortcut, the palette has no trigger; focus goes back where it was.
  const returnTo = useRef<HTMLElement | null>(null);
  if (open && returnTo.current === null && typeof document !== "undefined") {
    returnTo.current = document.activeElement as HTMLElement | null;
  }
  return (
    <CommandDialogPrimitive.Root
      open={open}
      onOpenChange={onOpenChange}
      onOpenChangeComplete={(isOpen) => {
        if (isOpen) return;
        const el = returnTo.current;
        returnTo.current = null;
        if (el && el !== document.body && el.isConnected) el.focus();
        else document.getElementById("main")?.focus();
      }}
    >
      <CommandDialogPrimitive.Portal>
        <CommandDialogPrimitive.Backdrop
          className={DIALOG_BACKDROP_CLASS}
          data-slot="command-dialog-backdrop"
        />
        <CommandDialogPrimitive.Viewport className="pointer-events-none fixed inset-0 z-50 flex flex-col items-center px-4 pt-[max(--spacing(4),10vh)] pb-[10vh]">
          <CommandDialogPrimitive.Popup
            aria-label="Command palette"
            className={cn(
              DIALOG_POPUP_CLASS,
              "pointer-events-auto max-h-105 max-w-xl overflow-hidden",
            )}
            data-slot="command-dialog-popup"
          >
            {open && (
              <CommandBody
                commands={commands}
                onRun={(c) => {
                  onOpenChange(false);
                  onRun(c);
                }}
                placeholder={placeholder}
              />
            )}
          </CommandDialogPrimitive.Popup>
        </CommandDialogPrimitive.Viewport>
      </CommandDialogPrimitive.Portal>
    </CommandDialogPrimitive.Root>
  );
}

function CommandBody<T extends Command>({
  commands,
  onRun,
  placeholder,
}: {
  commands: readonly T[];
  onRun: (command: T) => void;
  placeholder: string;
}) {
  const id = useId();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(-2);
  const items = useMemo(() => matchCommands(commands, query), [commands, query]);
  // Nothing is chosen until the reader types or moves, so Enter alone never runs a command.
  const index = active === -2 || active >= items.length ? -1 : active;
  const current = index >= 0 ? items[index] : undefined;

  function move(next: number) {
    if (next < 0) return;
    setActive(next);
    document.getElementById(`${id}-${next}`)?.scrollIntoView({ block: "nearest" });
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") move(nextEnabled(items, index, 1));
    else if (e.key === "ArrowUp") move(nextEnabled(items, Math.max(index, 0), -1));
    else if (e.key === "Home") move(nextEnabled(items, -1, 1));
    else if (e.key === "End") move(nextEnabled(items, 0, -1));
    else if (e.key === "Enter" && current && !current.disabled) onRun(current);
    else return;
    e.preventDefault();
  }

  let lastGroup = "";
  return (
    <>
      <div className="flex items-center gap-2 border-b px-4">
        <SearchIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        <input
          aria-activedescendant={current ? `${id}-${index}` : undefined}
          aria-autocomplete="list"
          aria-controls={`${id}-list`}
          aria-expanded="true"
          // biome-ignore lint/a11y/noAutofocus: the palette exists to take typing at once
          autoFocus
          className="h-11 w-full bg-transparent text-sm outline-none placeholder:text-placeholder"
          onChange={(e) => {
            setQuery(e.target.value);
            const found = matchCommands(commands, e.target.value);
            setActive(e.target.value.trim() ? nextEnabled(found, -1, 1) : -2);
          }}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          role="combobox"
          spellCheck={false}
          value={query}
        />
      </div>
      <div
        className="min-h-0 flex-1 overflow-y-auto p-2"
        id={`${id}-list`}
        role="listbox"
        aria-label="Commands"
      >
        {items.length === 0 && (
          <p className="px-2 py-6 text-center text-muted-foreground text-sm">
            No command matches "{query}".
          </p>
        )}
        {items.map((c, i) => {
          const head = c.group !== lastGroup ? c.group : null;
          lastGroup = c.group;
          return (
            <div key={c.id} role="presentation">
              {head && (
                <div
                  className="px-2 pt-2 pb-1 font-medium text-muted-foreground text-xs"
                  role="presentation"
                >
                  {head}
                </div>
              )}
              {/* biome-ignore lint/a11y/useKeyWithClickEvents: the combobox input owns the keys (aria-activedescendant) */}
              <div
                aria-disabled={c.disabled || undefined}
                aria-selected={i === index}
                className={cn(
                  "flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 text-sm aria-disabled:cursor-not-allowed aria-disabled:opacity-64",
                  i === index && "bg-foreground/[0.07]",
                )}
                id={`${id}-${i}`}
                onClick={() => !c.disabled && onRun(c)}
                onPointerMove={() => i !== index && !c.disabled && setActive(i)}
                role="option"
                tabIndex={-1}
              >
                <span className="min-w-0 flex-1 truncate">{c.title}</span>
                {c.shortcut && (
                  <KbdGroup>
                    {c.shortcut.split(" ").map((k) => (
                      <Kbd key={k}>{k}</Kbd>
                    ))}
                  </KbdGroup>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex items-center gap-3 border-t border-foreground/[0.07] bg-foreground/[0.025] px-4 py-2 text-muted-foreground text-xs">
        <span className="inline-flex items-center gap-1.5">
          <KbdGroup>
            <Kbd aria-label="Up">
              <ArrowUpIcon />
            </Kbd>
            <Kbd aria-label="Down">
              <ArrowDownIcon />
            </Kbd>
          </KbdGroup>
          Move
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Kbd>Enter</Kbd>
          Run
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Kbd>Esc</Kbd>
          Close
        </span>
      </div>
    </>
  );
}

export { CommandPalette };
