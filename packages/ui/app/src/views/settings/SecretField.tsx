// A write-only secret field for a connection card (MET-33, D-030). The value goes to the
// daemon once and is never shown again: the card shows only "set" and the source.
import { KeyRoundIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { Skeleton } from "../../components/ui/skeleton.tsx";
import { Spinner } from "../../components/ui/spinner.tsx";
import { toast } from "../../components/ui/toast.tsx";
import type { Check } from "../../lib/checks.ts";
import { type SecretSpec, type SecretState, savedToast, sourceText } from "../../lib/secrets.ts";
import { removeSecret, saveSecret } from "../../setupApi.ts";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Keeps browsers and password managers from offering to store the value. */
const NO_MANAGER = {
  autoComplete: "off",
  "data-1p-ignore": "",
  "data-lpignore": "true",
  "data-bwignore": "",
  "data-form-type": "other",
} as const;

/** Where focus goes after the field changes shape, so the keyboard never drops to the page. */
type FocusTarget = "input" | "replace" | "keep";

export function SecretField({
  title,
  spec,
  state,
  onSaved,
  onRetry,
}: {
  /** The connection's name, for labels and toasts. */
  title: string;
  spec: SecretSpec;
  /** Undefined while the states load; "error" when they could not be read. */
  state: SecretState | "error" | undefined;
  onSaved: (state: SecretState, checks: Check[]) => void;
  onRetry: () => void;
}) {
  const id = useId();
  const [value, setValue] = useState("");
  const [replacing, setReplacing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState<"save" | "remove">();
  const [error, setError] = useState<string>();
  const [focus, setFocus] = useState<FocusTarget>();
  const inputRef = useRef<HTMLInputElement>(null);
  const replaceRef = useRef<HTMLButtonElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (focus === undefined) return;
    const el = { input: inputRef, replace: replaceRef, keep: keepRef }[focus].current;
    el?.focus();
    setFocus(undefined);
  }, [focus]);

  if (state === undefined) {
    return (
      <div aria-hidden="true" className="grid gap-1.5 border-t pt-3">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-7" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    );
  }

  const known = state === "error" ? undefined : state;
  // A variable fallback can be overridden here but not removed: the variable is the user's.
  const editing = known === undefined || !known.stored || replacing;
  const label = spec.label;

  function cancel() {
    setReplacing(false);
    setValue("");
    setError(undefined);
    setFocus("replace");
  }

  /** Escape in the remove prompt keeps the secret. */
  function keepOnEscape(e: React.KeyboardEvent) {
    if (e.key !== "Escape") return;
    e.preventDefault();
    setConfirming(false);
    setFocus("replace");
  }

  async function save() {
    const text = value.trim();
    if (text === "") {
      setError(`Enter the ${label} or a reference.`);
      setFocus("input");
      return;
    }
    setBusy("save");
    setError(undefined);
    try {
      const res = await saveSecret(spec.id, text);
      setValue("");
      setReplacing(false);
      onSaved(res.secret, res.checks);
      toast.add(savedToast(title, label, "saved", res.checks));
      setFocus(res.secret.stored ? "replace" : "input");
    } catch (e) {
      setError(message(e));
      setFocus("input");
    } finally {
      setBusy(undefined);
    }
  }

  async function remove() {
    setBusy("remove");
    setError(undefined);
    try {
      const res = await removeSecret(spec.id);
      setConfirming(false);
      setReplacing(false);
      onSaved(res.secret, res.checks);
      toast.add(savedToast(title, label, "removed", res.checks));
      setFocus("input");
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(undefined);
    }
  }

  // The hint says where the secret lives; while typing, it says what the field takes.
  const hint =
    known === undefined
      ? "Paste the value, or a reference: op://vault/item/field or env:NAME."
      : editing
        ? known.source === "env" && !known.stored
          ? `From ${spec.env}. Save a value here to use it instead.`
          : "Paste the value, or a reference: op://vault/item/field or env:NAME."
        : known.source === "1Password"
          ? "Read with the 1Password CLI each time it is used. Only the reference is saved."
          : known.source === "env"
            ? "Read from the named environment variable. Only the reference is saved."
            : "Saved on this Mac in ~/.harnessd/secrets, readable only by you.";

  return (
    <form
      aria-label={`${title} ${label}`}
      autoComplete="off"
      className="grid gap-1.5 border-t pt-3"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="flex items-center gap-2 text-xs">
        <label className="font-medium" htmlFor={id}>
          {label}
        </label>
        <span className="text-muted-foreground" role="status">
          {known === undefined ? "Could not read" : sourceText(known)}
        </span>
        {known === undefined && (
          <Button
            className="ms-auto"
            onClick={onRetry}
            size="xs"
            type="button"
            variant="ghost-muted"
          >
            Retry
          </Button>
        )}
      </div>
      {editing ? (
        <div className="flex items-center gap-2">
          <Input
            {...NO_MANAGER}
            aria-describedby={error ? `${id}-error` : `${id}-hint`}
            aria-invalid={error ? true : undefined}
            font="mono"
            id={id}
            name={spec.id}
            onChange={(e) => {
              setValue(e.target.value);
              setError(undefined);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape" && replacing) {
                e.preventDefault();
                cancel();
              }
            }}
            placeholder={spec.placeholder}
            ref={inputRef}
            size="sm"
            spellCheck={false}
            type="password"
            value={value}
          />
          <Button disabled={busy !== undefined} size="sm" type="submit" variant="outline">
            {busy === "save" && <Spinner />}
            Save
          </Button>
          {replacing && (
            <Button
              disabled={busy !== undefined}
              onClick={cancel}
              size="sm"
              type="button"
              variant="ghost-muted"
            >
              Cancel
            </Button>
          )}
        </div>
      ) : confirming ? (
        <div className="flex items-center gap-2">
          <p className="min-w-0 flex-1 text-sm">Remove the saved {label}?</p>
          <Button
            disabled={busy !== undefined}
            onClick={() => void remove()}
            onKeyDown={keepOnEscape}
            size="sm"
            type="button"
            variant="outline"
          >
            {busy === "remove" && <Spinner />}
            Remove
          </Button>
          <Button
            disabled={busy !== undefined}
            onClick={() => {
              setConfirming(false);
              setFocus("replace");
            }}
            onKeyDown={keepOnEscape}
            ref={keepRef}
            size="sm"
            type="button"
            variant="ghost-muted"
          >
            Keep
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <p className="flex min-w-0 flex-1 items-center gap-2 text-muted-foreground text-sm">
            <KeyRoundIcon aria-hidden="true" className="size-4 shrink-0" />
            <span aria-hidden="true" className="font-mono tracking-widest">
              ••••••••
            </span>
            <span className="sr-only">The value is hidden.</span>
          </p>
          <Button
            disabled={busy !== undefined}
            onClick={() => {
              setReplacing(true);
              setFocus("input");
            }}
            ref={replaceRef}
            size="sm"
            type="button"
            variant="outline"
          >
            Replace
          </Button>
          <Button
            disabled={busy !== undefined}
            onClick={() => {
              setConfirming(true);
              setFocus("keep");
            }}
            size="sm"
            type="button"
            variant="ghost-muted"
          >
            Remove
          </Button>
        </div>
      )}
      {error ? (
        <p className="text-destructive-foreground text-xs" id={`${id}-error`} role="alert">
          {error}
        </p>
      ) : (
        <p className="text-pretty text-muted-foreground text-xs" id={`${id}-hint`}>
          {hint}
        </p>
      )}
    </form>
  );
}
