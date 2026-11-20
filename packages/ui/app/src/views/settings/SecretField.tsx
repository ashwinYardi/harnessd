// A write-only secret field for a connection card (MET-33, D-029). The value goes to the
// daemon once and is never shown again: the card shows only "set" and the source.
import { KeyRoundIcon } from "lucide-react";
import { useId, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { Skeleton } from "../../components/ui/skeleton.tsx";
import { Spinner } from "../../components/ui/spinner.tsx";
import { toast } from "../../components/ui/toast.tsx";
import type { Check } from "../../lib/checks.ts";
import { isReference, type SecretSpec, type SecretState, sourceText } from "../../lib/secrets.ts";
import { removeSecret, saveSecret } from "../../setupApi.ts";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

const PLACEHOLDER: Record<SecretSpec["id"], string> = {
  "linear.api_key": "lin_api_…",
  "slack.webhook_url": "https://hooks.slack.com/services/…",
};

export function SecretField({
  title,
  spec,
  state,
  onSaved,
}: {
  /** The connection's name, for labels and toasts. */
  title: string;
  spec: SecretSpec;
  /** Undefined while the states load. */
  state: SecretState | undefined;
  onSaved: (state: SecretState, checks: Check[]) => void;
}) {
  const id = useId();
  const [value, setValue] = useState("");
  const [replacing, setReplacing] = useState(false);
  const [busy, setBusy] = useState<"save" | "remove">();
  const [error, setError] = useState<string>();

  if (state === undefined) return <Skeleton className="h-8" />;

  // An env-only secret can be overridden here but not removed: the variable is the user's.
  const editing = !state.set || state.source === "env" || replacing;
  const removable = state.set && state.source !== "env";

  async function save() {
    const text = value.trim();
    if (text === "") {
      setError(`Enter the ${spec.label.toLowerCase()} or a reference.`);
      return;
    }
    setBusy("save");
    setError(undefined);
    try {
      const res = await saveSecret(spec.id, text);
      setValue("");
      setReplacing(false);
      onSaved(res.secret, res.checks);
      toast.add({
        type: "success",
        title: `${title} ${isReference(text) ? "reference" : spec.label.toLowerCase()} saved`,
        description: `${title} is checked again.`,
      });
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(undefined);
    }
  }

  async function remove() {
    setBusy("remove");
    setError(undefined);
    try {
      const res = await removeSecret(spec.id);
      setReplacing(false);
      onSaved(res.secret, res.checks);
      toast.add({
        type: "success",
        title: `${title} ${spec.label.toLowerCase()} removed`,
        description: res.secret.set ? `${spec.env} still applies.` : `${title} is checked again.`,
      });
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(undefined);
    }
  }

  // The hint says where the secret lives; while typing, it says what the field takes.
  const hint = editing
    ? state.source === "env" && !replacing
      ? `From ${spec.env}. Save a value here to use it instead.`
      : "Paste the value, or a reference: op://vault/item/field or env:NAME."
    : state.source === "1Password"
      ? "Read with the 1Password CLI each time it is used. Only the reference is saved."
      : "Saved on this Mac in ~/.harnessd/secrets, readable only by you.";

  return (
    <form
      aria-label={`${title} ${spec.label}`}
      className="grid gap-1.5 border-t pt-3"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="flex items-center gap-2 text-xs">
        <label className="font-medium" htmlFor={id}>
          {spec.label}
        </label>
        <span className="text-muted-foreground" role="status">
          {sourceText(state)}
        </span>
      </div>
      {editing ? (
        <div className="flex items-center gap-2">
          <Input
            aria-describedby={error ? `${id}-error` : `${id}-hint`}
            aria-invalid={error ? true : undefined}
            autoComplete="off"
            font="mono"
            id={id}
            name={spec.id}
            onChange={(e) => {
              setValue(e.target.value);
              setError(undefined);
            }}
            placeholder={PLACEHOLDER[spec.id]}
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
              onClick={() => {
                setReplacing(false);
                setValue("");
                setError(undefined);
              }}
              size="sm"
              type="button"
              variant="ghost-muted"
            >
              Cancel
            </Button>
          )}
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <p className="flex min-w-0 flex-1 items-center gap-2 text-muted-foreground text-sm">
            <KeyRoundIcon aria-hidden="true" className="size-4 shrink-0" />
            <span className="font-mono tracking-widest" aria-hidden="true">
              ••••••••
            </span>
            <span className="sr-only">The value is hidden.</span>
          </p>
          <Button
            disabled={busy !== undefined}
            onClick={() => setReplacing(true)}
            size="sm"
            type="button"
            variant="outline"
          >
            Replace
          </Button>
          {removable && (
            <Button
              disabled={busy !== undefined}
              onClick={() => void remove()}
              size="sm"
              type="button"
              variant="ghost-muted"
            >
              {busy === "remove" && <Spinner />}
              Remove
            </Button>
          )}
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
