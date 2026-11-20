// Settings → Team (MET-28): one row per agent with its role, harness and model. Save writes
// the workspace .harnessd/config.toml through the config validator, then runs harnessd sync.
import { AGENT_ROLES, HARNESSES, validateTeam } from "@harnessd/shared";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { ApiError, type Load } from "../../api.ts";
import { Button } from "../../components/ui/button.tsx";
import { Card, CardFooter } from "../../components/ui/card.tsx";
import { Input } from "../../components/ui/input.tsx";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select.tsx";
import { Skeleton } from "../../components/ui/skeleton.tsx";
import { Spinner } from "../../components/ui/spinner.tsx";
import { toast } from "../../components/ui/toast.tsx";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip.tsx";
import { cn } from "../../lib/cn.ts";
import { readTeam, saveTeam, type TeamAgent } from "../../setupApi.ts";
import { ErrorState } from "../common.tsx";

interface Row extends TeamAgent {
  key: string;
  isNew: boolean;
}

const toRows = (agents: TeamAgent[]): Row[] =>
  agents.map((a) => ({ ...a, key: a.name, isNew: false }));
const strip = (rows: Row[]) =>
  rows.map(({ name, role, harness, model }) => ({ name, role, harness, model }));

function Field({
  error,
  id,
  children,
}: {
  error: string | undefined;
  id: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-1">
      {children}
      {error && (
        <p className="text-destructive-foreground text-xs" id={id}>
          {error}
        </p>
      )}
    </div>
  );
}

function Choice({
  label,
  value,
  options,
  onChange,
  invalid,
  describedBy,
}: {
  label: string;
  value: string;
  options: readonly string[];
  onChange: (v: string) => void;
  invalid: boolean;
  describedBy: string | undefined;
}) {
  return (
    <Select value={value} onValueChange={(v) => onChange(String(v))}>
      <SelectTrigger
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        aria-label={label}
        size="sm"
        className="min-w-0"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectPopup>
        {options.map((o) => (
          <SelectItem key={o} value={o}>
            {o}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

export function Team() {
  const base = useId();
  const [saved, setSaved] = useState<Load<TeamAgent[]>>({ status: "loading" });
  const [rows, setRows] = useState<Row[]>([]);
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [tried, setTried] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const { agents } = await readTeam();
      setSaved({ status: "ready", data: agents });
      setRows(toRows(agents));
    } catch (e) {
      setSaved({ status: "error", error: e instanceof Error ? e.message : String(e) });
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const errors = useMemo(
    () => ({ ...(tried ? validateTeam(strip(rows)) : {}), ...serverErrors }),
    [rows, tried, serverErrors],
  );
  const dirty =
    saved.status === "ready" &&
    JSON.stringify(strip(rows)) !== JSON.stringify(strip(toRows(saved.data)));

  function update(i: number, patch: Partial<Row>) {
    setServerErrors({});
    setRows((r) => r.map((row, j) => (j === i ? { ...row, ...patch } : row)));
  }

  function add() {
    setRows((r) => [
      ...r,
      {
        key: `new-${Date.now()}`,
        name: "",
        role: "backend",
        harness: "claude-code",
        model: "",
        removable: true,
        isNew: true,
      },
    ]);
    requestAnimationFrame(() => document.getElementById(`${base}-${rows.length}-name`)?.focus());
  }

  async function save() {
    setTried(true);
    const local = validateTeam(strip(rows));
    if (Object.keys(local).length > 0) {
      toast.add({
        type: "error",
        title: "Not saved",
        description: "Fix the fields marked in red.",
      });
      return;
    }
    setSaving(true);
    try {
      const res = await saveTeam(strip(rows));
      setSaved({ status: "ready", data: res.agents });
      setRows(toRows(res.agents));
      setTried(false);
      if (res.syncError) {
        toast.add({ type: "warning", title: "Saved; sync failed", description: res.syncError });
      } else {
        toast.add({
          type: "success",
          title: "Team saved",
          description: `harnessd sync wrote ${res.synced.length} ${res.synced.length === 1 ? "file" : "files"}.`,
        });
      }
    } catch (e) {
      if (e instanceof ApiError) setServerErrors(e.fields);
      toast.add({
        type: "error",
        title: "Not saved",
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setSaving(false);
    }
  }

  if (saved.status === "loading") {
    return <Skeleton aria-hidden="true" className="h-72" shape="card" />;
  }
  if (saved.status === "error") {
    return (
      <ErrorState onRetry={() => void load()} text={`Could not read the team. ${saved.error}`} />
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <Card>
        <table className="w-full table-fixed border-collapse text-sm">
          <colgroup>
            <col className="w-[28%]" />
            <col className="w-[22%]" />
            <col className="w-[22%]" />
            <col />
            <col className="w-12" />
          </colgroup>
          <thead className="text-left text-muted-foreground text-xs">
            <tr>
              <th className="px-4 pt-3 pb-1.5 font-medium" scope="col">
                Agent
              </th>
              <th className="px-2 pt-3 pb-1.5 font-medium" scope="col">
                Role
              </th>
              <th className="px-2 pt-3 pb-1.5 font-medium" scope="col">
                Harness
              </th>
              <th className="px-2 pt-3 pb-1.5 font-medium" scope="col">
                Model
              </th>
              <th className="pt-3 pb-1.5" scope="col">
                <span className="sr-only">Remove</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => {
              const err = (f: string) => errors[`${i}.${f}`];
              const eid = (f: string) => (err(f) ? `${base}-${i}-${f}-error` : undefined);
              return (
                <tr className="border-t align-top" key={row.key}>
                  <td className="px-4 py-2">
                    {row.isNew ? (
                      <Field error={err("name")} id={`${base}-${i}-name-error`}>
                        <Input
                          aria-describedby={eid("name")}
                          aria-invalid={err("name") ? true : undefined}
                          aria-label="Agent name"
                          id={`${base}-${i}-name`}
                          onChange={(e) => update(i, { name: e.target.value })}
                          placeholder="docs-writer"
                          size="sm"
                          spellCheck={false}
                          value={row.name}
                        />
                      </Field>
                    ) : (
                      <span className="block py-1 font-medium">{row.name}</span>
                    )}
                  </td>
                  <td className="px-2 py-2">
                    <Field error={err("role")} id={`${base}-${i}-role-error`}>
                      <Choice
                        describedBy={eid("role")}
                        invalid={!!err("role")}
                        label={`Role of ${row.name || "the new agent"}`}
                        onChange={(v) => update(i, { role: v })}
                        options={AGENT_ROLES}
                        value={row.role}
                      />
                    </Field>
                  </td>
                  <td className="px-2 py-2">
                    <Field error={err("harness")} id={`${base}-${i}-harness-error`}>
                      <Choice
                        describedBy={eid("harness")}
                        invalid={!!err("harness")}
                        label={`Harness of ${row.name || "the new agent"}`}
                        onChange={(v) => update(i, { harness: v })}
                        options={HARNESSES}
                        value={row.harness}
                      />
                    </Field>
                  </td>
                  <td className="px-2 py-2">
                    <Field error={err("model")} id={`${base}-${i}-model-error`}>
                      <Input
                        aria-describedby={eid("model")}
                        aria-invalid={err("model") ? true : undefined}
                        aria-label={`Model of ${row.name || "the new agent"}`}
                        onChange={(e) => update(i, { model: e.target.value })}
                        placeholder="Harness default"
                        size="sm"
                        spellCheck={false}
                        value={row.model}
                      />
                    </Field>
                  </td>
                  <td className="py-2 pe-2">
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            aria-disabled={!row.removable || undefined}
                            aria-label={`Remove ${row.name || "the new agent"}`}
                            onClick={() =>
                              row.removable && setRows((r) => r.filter((_, j) => j !== i))
                            }
                            size="icon-sm"
                            variant="ghost-muted"
                          />
                        }
                      >
                        <Trash2Icon />
                      </TooltipTrigger>
                      <TooltipPopup side="left">
                        {row.removable
                          ? "Remove"
                          : "A default agent stays. Change its harness or model."}
                      </TooltipPopup>
                    </Tooltip>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {errors.team && (
          <p className="border-t px-4 py-2 text-destructive-foreground text-xs" role="alert">
            {errors.team}
          </p>
        )}
        <CardFooter>
          <Button onClick={add} size="sm" variant="outline">
            <PlusIcon aria-hidden="true" />
            Add agent
          </Button>
          <span className={cn("ms-auto text-muted-foreground text-xs", dirty && "text-foreground")}>
            {dirty ? "Unsaved changes" : "Saved in .harnessd/config.toml"}
          </span>
          <Button
            disabled={!dirty || saving}
            onClick={() => setRows(toRows(saved.data))}
            size="sm"
            variant="ghost-muted"
          >
            Discard
          </Button>
          <Button disabled={!dirty || saving} size="sm" type="submit">
            {saving && <Spinner />}
            Save and sync
          </Button>
        </CardFooter>
      </Card>
    </form>
  );
}
