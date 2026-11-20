// Settings → Harnesses (MET-28): one card per harness CLI, after T3 Code's Settings →
// Providers. The card shows what the status engine found and runs the fixed setup commands.
import { CopyIcon, DownloadIcon, LogInIcon, RefreshCwIcon, RotateCwIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Load } from "../../api.ts";
import { Button } from "../../components/ui/button.tsx";
import { Card, CardFooter, CardHeader, CardPanel, CardTitle } from "../../components/ui/card.tsx";
import { Input } from "../../components/ui/input.tsx";
import { Skeleton } from "../../components/ui/skeleton.tsx";
import { Spinner } from "../../components/ui/spinner.tsx";
import { toast } from "../../components/ui/toast.tsx";
import { harnessSummary } from "../../lib/setup.ts";
import {
  type HarnessAction,
  type HarnessCard,
  type Job,
  readHarnesses,
  runHarnessAction,
  setHarnessPath,
} from "../../setupApi.ts";
import { ErrorState } from "../common.tsx";
import { StateBadge } from "./parts.tsx";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

const ACTION_TEXT: Record<HarnessAction, string> = {
  install: "Install",
  update: "Update now",
  signin: "Sign in",
};

function copy(text: string) {
  void navigator.clipboard?.writeText(text).then(
    () => toast.add({ type: "success", title: "Copied", description: text }),
    () => toast.add({ type: "error", title: "Could not copy", description: text }),
  );
}

function JobOutput({ job }: { job: Job }) {
  return (
    <div className="mt-3 rounded-lg border bg-muted/50" aria-live="polite">
      <p className="flex items-center gap-2 border-b px-3 py-1.5 text-xs">
        {job.state === "running" && <Spinner className="size-3.5" />}
        <span className="font-mono">{job.command}</span>
        <span className="ms-auto text-muted-foreground">
          {job.state === "running"
            ? "Running"
            : job.state === "ok"
              ? "Done"
              : `Failed (exit ${job.exitCode})`}
        </span>
      </p>
      {job.lines.length > 0 && (
        <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap px-3 py-2 font-mono text-2xs leading-4 text-muted-foreground">
          {job.lines.join("\n")}
        </pre>
      )}
      {job.state === "failed" && (
        <div className="flex items-center gap-2 border-t px-3 py-2 text-xs">
          <span className="text-destructive-foreground">Run it yourself in a terminal:</span>
          <code className="font-mono">{job.command}</code>
          <Button
            aria-label="Copy the command"
            className="ms-auto"
            onClick={() => copy(job.command)}
            size="icon-sm"
            variant="ghost"
          >
            <CopyIcon />
          </Button>
        </div>
      )}
    </div>
  );
}

function BinaryPath({ card, onSaved }: { card: HarnessCard; onSaved: () => void }) {
  const found = harnessSummary(card.id, card.checks).path;
  const [value, setValue] = useState(card.bin ?? "");
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const dirty = value.trim() !== (card.bin ?? "");
  async function save(path: string | null) {
    setSaving(true);
    setError(undefined);
    try {
      await setHarnessPath(card.id, path);
      if (path === null) setValue("");
      toast.add({
        type: "success",
        title: path ? "Path saved" : "Path cleared",
        description: `${card.name} is checked again.`,
      });
      onSaved();
    } catch (e) {
      setError(message(e));
    } finally {
      setSaving(false);
    }
  }
  const id = `bin-${card.id}`;
  return (
    <form
      className="grid gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        void save(value.trim() === "" ? null : value.trim());
      }}
    >
      <label className="text-muted-foreground text-xs" htmlFor={id}>
        Binary path
      </label>
      <div className="flex items-center gap-2">
        <Input
          aria-describedby={error ? `${id}-error` : `${id}-hint`}
          aria-invalid={error ? true : undefined}
          font="mono"
          id={id}
          onChange={(e) => setValue(e.target.value)}
          placeholder={found ?? `/usr/local/bin/${card.id === "claude-code" ? "claude" : card.id}`}
          size="sm"
          spellCheck={false}
          value={value}
        />
        <Button disabled={!dirty || saving} size="sm" type="submit" variant="outline">
          {saving && <Spinner />}
          Save
        </Button>
        {card.bin && (
          <Button disabled={saving} onClick={() => void save(null)} size="sm" variant="ghost-muted">
            Use PATH
          </Button>
        )}
      </div>
      {error ? (
        <p className="text-destructive-foreground text-xs" id={`${id}-error`}>
          {error}
        </p>
      ) : (
        <p className="text-muted-foreground text-xs" id={`${id}-hint`}>
          {card.bin ? "Saved in ~/.harnessd/config.toml." : "Empty uses the CLI found on PATH."}
        </p>
      )}
    </form>
  );
}

function HarnessCardView({
  card,
  job,
  onAction,
  onRecheck,
  checking,
}: {
  card: HarnessCard;
  job: Job | null;
  onAction: (action: HarnessAction) => void;
  onRecheck: () => void;
  checking: boolean;
}) {
  const s = harnessSummary(card.id, card.checks);
  const busy = job?.state === "running";
  const status = !s.found
    ? "Not found"
    : !s.signedIn
      ? "Not signed in"
      : s.warning
        ? "Known bad version"
        : "Ready";
  const primary: HarnessAction | undefined = !s.found
    ? "install"
    : !s.signedIn
      ? "signin"
      : s.warning
        ? "update"
        : undefined;
  return (
    <Card>
      <CardHeader className="items-center">
        <div className="min-w-0 flex-1">
          <CardTitle className="flex items-center gap-2">
            {card.name}
            <StateBadge state={s.state}>{status}</StateBadge>
          </CardTitle>
          <p className="mt-0.5 text-muted-foreground text-xs">
            {card.required
              ? "Required: an agent on the team uses it."
              : "Optional: no agent uses it yet."}
          </p>
        </div>
        <Button disabled={checking} onClick={onRecheck} size="sm" variant="ghost-muted">
          {checking ? <Spinner /> : <RotateCwIcon aria-hidden="true" />}
          Recheck
        </Button>
      </CardHeader>
      <CardPanel className="grid gap-3">
        <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1.5 text-sm">
          <dt className="text-muted-foreground text-xs leading-5">Found</dt>
          <dd className="wrap-anywhere">{s.found ? "Yes" : (s.reason ?? "No")}</dd>
          <dt className="text-muted-foreground text-xs leading-5">Version</dt>
          <dd className="font-mono text-xs leading-5">{s.version ?? "Unknown"}</dd>
          <dt className="text-muted-foreground text-xs leading-5">Path</dt>
          <dd className="wrap-anywhere font-mono text-xs leading-5">{s.path ?? "None"}</dd>
          <dt className="text-muted-foreground text-xs leading-5">Signed in</dt>
          <dd>
            {s.signedIn ? (
              `Yes, ${s.signIn.replace(/^signed in ?/, "").replace(/^\((.*)\)$/, "$1") || "with the CLI"}`
            ) : (
              <span className="text-destructive-foreground">
                {s.found ? "No" : "Install first"}
              </span>
            )}
          </dd>
        </dl>
        {s.warning && (
          <p
            className="rounded-lg bg-warning-surface px-3 py-2 text-warning-foreground text-xs"
            role="note"
          >
            {s.warning}. Update now to fix it.
          </p>
        )}
        <BinaryPath card={card} onSaved={onRecheck} />
      </CardPanel>
      <CardFooter className="flex-wrap">
        {(["install", "update", "signin"] as const).map((action) => {
          // Each button shows only when it can help: Sign in only while signed out.
          const show =
            action === "install"
              ? !s.found
              : action === "signin"
                ? s.found && !s.signedIn
                : s.found;
          if (!show) return null;
          const Icon =
            action === "install" ? DownloadIcon : action === "update" ? RefreshCwIcon : LogInIcon;
          return (
            <Button
              disabled={busy}
              key={action}
              onClick={() => onAction(action)}
              size="sm"
              variant={action === primary ? "default" : "outline"}
            >
              {busy && job?.action === action ? <Spinner /> : <Icon aria-hidden="true" />}
              {ACTION_TEXT[action]}
            </Button>
          );
        })}
        <span className="ms-auto text-muted-foreground text-xs">
          {s.found ? "Sign in opens Terminal with " : "Runs "}
          <code className="font-mono">
            {s.found ? card.commands.signin : card.commands.install}
          </code>
        </span>
      </CardFooter>
      {job && (
        <div className="px-4 pb-3">
          <JobOutput job={job} />
        </div>
      )}
    </Card>
  );
}

export function Harnesses({ onChecksChanged }: { onChecksChanged: () => void }) {
  const [cards, setCards] = useState<Load<HarnessCard[]>>({ status: "loading" });
  const [jobs, setJobs] = useState<Record<string, Job>>({});
  const [checking, setChecking] = useState(false);

  const load = useCallback(async () => {
    setChecking(true);
    try {
      const { harnesses } = await readHarnesses();
      setCards({ status: "ready", data: harnesses });
      setJobs((j) => ({
        ...Object.fromEntries(harnesses.flatMap((h) => (h.job ? [[h.id, h.job]] : []))),
        ...j,
      }));
    } catch (e) {
      setCards((c) => (c.status === "ready" ? c : { status: "error", error: message(e) }));
    } finally {
      setChecking(false);
    }
  }, []);

  const changed = useRef(onChecksChanged);
  changed.current = onChecksChanged;
  const recheck = useCallback(() => {
    void load();
    changed.current();
  }, [load]);

  // One stream for the page. A job's result is announced once, when it leaves "running";
  // jobs replayed on connect are shown but not announced again.
  const seen = useRef(new Map<string, Job["state"]>());
  useEffect(() => {
    void load();
    const events = new EventSource("/api/setup/events");
    events.addEventListener("job", (e) => {
      const job = JSON.parse((e as MessageEvent<string>).data) as Job;
      const before = seen.current.get(job.id);
      seen.current.set(job.id, job.state);
      setJobs((j) => ({ ...j, [job.harness]: job }));
      if (before !== "running" || job.state === "running") return;
      if (job.state === "ok") {
        toast.add({
          type: "success",
          title: job.action === "signin" ? "Terminal opened" : `${job.command} finished`,
        });
        if (job.action !== "signin") recheck();
      } else {
        toast.add({
          type: "error",
          title: "The command failed",
          description: "The card shows its output and the command to run.",
        });
      }
    });
    return () => events.close();
  }, [load, recheck]);

  async function act(card: HarnessCard, action: HarnessAction) {
    try {
      const job = await runHarnessAction(card.id, action);
      seen.current.set(job.id, "running");
      setJobs((j) => ({ ...j, [card.id]: job }));
    } catch (e) {
      toast.add({
        type: "error",
        title: `${ACTION_TEXT[action]} did not start`,
        description: message(e),
      });
    }
  }

  if (cards.status === "loading") {
    return (
      <div className="grid gap-3" aria-hidden="true">
        <Skeleton className="h-64" shape="card" />
        <Skeleton className="h-64" shape="card" />
      </div>
    );
  }
  if (cards.status === "error") {
    return (
      <ErrorState
        onRetry={() => void load()}
        text={`Could not check the harnesses. ${cards.error}`}
      />
    );
  }
  return (
    <div className="grid gap-3">
      {cards.data.map((card) => (
        <HarnessCardView
          card={card}
          checking={checking}
          job={jobs[card.id] ?? null}
          key={card.id}
          onAction={(a) => void act(card, a)}
          onRecheck={recheck}
        />
      ))}
      <p className="text-muted-foreground text-xs">
        harnessd runs only these fixed commands. Keys go in only through each CLI's own sign-in.
      </p>
    </div>
  );
}
