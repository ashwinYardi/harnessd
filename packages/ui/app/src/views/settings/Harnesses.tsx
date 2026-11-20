// Settings → Harnesses (MET-28): one card per harness CLI, with its maker's logo. The card
// shows what the status engine found and runs the fixed setup commands. During a sign-in it
// shows the login link and device code, or the one command to copy (MET-59, part of MET-48).
import {
  CheckIcon,
  CopyIcon,
  DownloadIcon,
  ExternalLinkIcon,
  LogInIcon,
  RefreshCwIcon,
  RotateCwIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Load } from "../../api.ts";
import { ServiceLogo } from "../../components/service-logo.tsx";
import { Button, buttonVariants } from "../../components/ui/button.tsx";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "../../components/ui/card.tsx";
import { Input } from "../../components/ui/input.tsx";
import { Skeleton } from "../../components/ui/skeleton.tsx";
import { Spinner } from "../../components/ui/spinner.tsx";
import { toast } from "../../components/ui/toast.tsx";
import { harnessService } from "../../lib/services.ts";
import { harnessSummary } from "../../lib/setup.ts";
import { copyText, jobStream, signinPanel } from "../../lib/signin.ts";
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

/** Copy with a quiet confirmation: the label reads "Copied" for a moment. */
function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  async function onCopy() {
    if (await copyText(navigator.clipboard, text)) {
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    } else {
      toast.add({
        type: "error",
        title: "Could not copy",
        description: "Select the text and copy it.",
      });
    }
  }
  return (
    <Button aria-label={`Copy ${label}`} onClick={() => void onCopy()} size="sm" variant="outline">
      {copied ? <CheckIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
      <span aria-hidden="true">{copied ? "Copied" : "Copy"}</span>
      <span aria-live="polite" className="sr-only">
        {copied ? "Copied" : ""}
      </span>
    </Button>
  );
}

/** A value to copy by hand: a device code or a command. */
function CopyField({ text, label }: { text: string; label: string }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <code className="block h-7 min-w-0 select-all truncate leading-[26px] rounded-[var(--control-radius)] border bg-background px-2.5 font-mono text-xs">
        {text}
      </code>
      <CopyButton label={label} text={text} />
    </div>
  );
}

function SigninPrompt({
  card,
  job,
  signedIn,
  onRecheck,
  checking,
}: {
  card: HarnessCard;
  job: Job | null;
  signedIn: boolean;
  onRecheck: () => void;
  checking: boolean;
}) {
  const { link, code, fallback } = signinPanel(job, signedIn);
  if (!link && !code && !fallback) return null;
  return (
    <div className="grid gap-2 pt-1">
      {link && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <a
            className={buttonVariants({ size: "sm" })}
            href={link.href}
            rel={link.rel}
            target={link.target}
          >
            <ExternalLinkIcon aria-hidden="true" />
            Open sign-in page
          </a>
          <span className="text-muted-foreground text-xs">
            Opens <span className="font-mono">{link.host}</span> in your browser.
          </span>
        </div>
      )}
      {code && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="w-20 text-muted-foreground text-xs">Device code</span>
          <CopyField label="the device code" text={code} />
        </div>
      )}
      {fallback && (
        <>
          <p className="text-muted-foreground text-xs">
            Run this in a terminal, then press Recheck.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <CopyField label="the command" text={card.commands.signin} />
            <Button
              disabled={checking}
              focusableWhenDisabled
              onClick={onRecheck}
              size="sm"
              variant="outline"
            >
              {checking ? <Spinner /> : <RotateCwIcon aria-hidden="true" />}
              Recheck
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

function JobOutput({ job }: { job: Job }) {
  return (
    <div className="rounded-lg border bg-muted/50">
      <p className="flex items-center gap-2 border-b px-3 py-1.5 text-xs">
        {job.state === "running" && <Spinner className="size-3.5" />}
        <span className="font-mono">{job.command}</span>
        <span className="ms-auto text-muted-foreground" role="status">
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
      {job.state === "failed" && job.action !== "signin" && (
        <div className="flex items-center gap-2 border-t px-3 py-2 text-xs">
          <span className="text-muted-foreground">Run it yourself in a terminal:</span>
          <code className="min-w-0 truncate font-mono">{job.command}</code>
          <span className="ms-auto">
            <CopyButton label="the command" text={job.command} />
          </span>
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
  // Red only for a harness an agent uses: an unused one blocks nothing, so it shows amber.
  const tone = !card.required && (s.state === "fail" || s.state === "missing") ? "warn" : s.state;
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
  const logo = harnessService(card.id);
  return (
    <Card>
      <CardHeader className="items-center">
        <div className="min-w-0 flex-1">
          <CardTitle className="flex items-center gap-2">
            {logo && <ServiceLogo service={logo} />}
            {card.name}
            <StateBadge state={tone}>{status}</StateBadge>
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
      <CardContent className="grid gap-3">
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
              <span
                className={
                  tone === "warn" ? "text-warning-foreground" : "text-destructive-foreground"
                }
              >
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
      </CardContent>
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
              variant={action === primary && !busy ? "default" : "outline"}
            >
              {busy && job?.action === action ? <Spinner /> : <Icon aria-hidden="true" />}
              {ACTION_TEXT[action]}
            </Button>
          );
        })}
        <span className="ms-auto text-muted-foreground text-xs">
          {s.found ? "Sign in runs " : "Runs "}
          <code className="font-mono">
            {s.found ? card.commands.signin : card.commands.install}
          </code>
        </span>
      </CardFooter>
      {job && (
        <div className="grid gap-2 px-4 pb-3">
          <JobOutput job={job} />
          <SigninPrompt
            card={card}
            checking={checking}
            job={job}
            onRecheck={onRecheck}
            signedIn={s.signedIn}
          />
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
  // The harness list runs the sign-in checks first; the status and loop state load after it.
  const recheck = useCallback(() => {
    void load().then(() => changed.current());
  }, [load]);

  // One stream for the page. A job ends once, when it leaves "running": then the card and the
  // checks load again, and the loop state after them (MET-41). Replayed jobs are not announced.
  const stream = useRef<ReturnType<typeof jobStream>>(undefined);
  useEffect(() => {
    void load();
    const onJob = jobStream({
      show: (job) => setJobs((j) => ({ ...j, [job.harness]: job })),
      ended: (job) =>
        toast.add(
          job.state === "ok"
            ? { type: "success", title: `${job.command} finished` }
            : {
                type: "error",
                title: "The command failed",
                description: "The card shows its output and the command to run.",
              },
        ),
      recheck,
    });
    stream.current = onJob;
    const events = new EventSource("/api/setup/events");
    events.addEventListener("job", (e) => {
      onJob(JSON.parse((e as MessageEvent<string>).data) as Job);
    });
    return () => events.close();
  }, [load, recheck]);

  async function act(card: HarnessCard, action: HarnessAction) {
    try {
      const job = await runHarnessAction(card.id, action);
      stream.current?.started(job);
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
