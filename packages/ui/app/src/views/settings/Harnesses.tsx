// Settings → Harnesses (MET-28): one card per harness CLI, with its maker's logo. The card
// shows what the status engine found and runs the fixed setup commands. During a sign-in it
// shows the login link and device code, or the one command to copy (MET-59, part of MET-48).
// OpenCode signs in per provider, so its card has one row per provider (MET-93).
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
import { cn } from "../../lib/cn.ts";
import { jobKey, providerList, providerRow } from "../../lib/opencode.ts";
import { harnessService } from "../../lib/services.ts";
import { harnessSummary } from "../../lib/setup.ts";
import { copyText, jobStream, type LoginLink, signinPanel } from "../../lib/signin.ts";
import {
  type HarnessAction,
  type HarnessCard,
  type Job,
  type OpencodeProviders,
  readHarnesses,
  readOpencodeProviders,
  runHarnessAction,
  setHarnessPath,
  signinOpencodeProvider,
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

function RecheckButton({ onRecheck, checking }: { onRecheck: () => void; checking: boolean }) {
  return (
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
  );
}

/** The login link and device code while a sign-in runs, or the one command to run by hand. */
function SigninSteps({
  link,
  code,
  manual,
  onRecheck,
  checking,
}: {
  link: LoginLink | undefined;
  code: string | undefined;
  manual: string | undefined;
  onRecheck: () => void;
  checking: boolean;
}) {
  if (!link && !code && !manual) return null;
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
      {manual && (
        <>
          <p className="text-muted-foreground text-xs">
            Run this in a terminal, then press Recheck.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <CopyField label="the command" text={manual} />
            <RecheckButton checking={checking} onRecheck={onRecheck} />
          </div>
        </>
      )}
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
  return (
    <SigninSteps
      checking={checking}
      code={code}
      link={link}
      manual={fallback ? card.commands.signin : undefined}
      onRecheck={onRecheck}
    />
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

/**
 * OpenCode's providers: one row per provider an opencode agent uses, plus each signed-in one.
 * Sign in runs the provider's own login as a daemon child (D-031). No field takes a key.
 */
function OpencodeProviderList({
  load,
  jobs,
  found,
  onSignin,
  onRecheck,
  checking,
}: {
  load: Load<OpencodeProviders>;
  jobs: Record<string, Job>;
  found: boolean;
  onSignin: (provider: string) => void;
  onRecheck: () => void;
  checking: boolean;
}) {
  const list = providerList(load);
  return (
    <section aria-labelledby="opencode-providers" className="grid gap-1.5">
      <h3 className="text-muted-foreground text-xs" id="opencode-providers">
        Providers
      </h3>
      {list.kind === "loading" && (
        <div aria-hidden="true" className="grid gap-1.5">
          <Skeleton className="h-9" />
          <Skeleton className="h-9" />
        </div>
      )}
      {list.kind === "error" && (
        <div className="flex flex-wrap items-center gap-2 text-xs" role="alert">
          <span className="text-destructive-foreground">
            Could not read the providers. {list.text}
          </span>
          <RecheckButton checking={checking} onRecheck={onRecheck} />
        </div>
      )}
      {list.kind === "empty" && (
        <p className="text-pretty text-muted-foreground text-xs">
          {list.note ?? "No provider yet."} Give an opencode agent a model such as{" "}
          <code className="font-mono">deepseek/deepseek-chat</code> in Team.
        </p>
      )}
      {list.kind === "ready" && (
        <>
          <ul className="divide-y rounded-lg border">
            {list.providers.map((p) => {
              const job = jobs[jobKey({ harness: "opencode", provider: p.id })];
              const row = providerRow(p, job);
              return (
                <li className="grid gap-2 px-3 py-2" key={p.id}>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                    <span className="min-w-0 truncate font-mono text-xs">{row.id}</span>
                    <span className="text-muted-foreground text-xs">
                      {row.required ? "Used by an agent" : "Not used"}
                    </span>
                    <span className="ms-auto flex items-center gap-2">
                      <StateBadge state={row.tone === "fail" && row.busy ? "warn" : row.tone}>
                        {row.status}
                      </StateBadge>
                      {row.canSignIn && (
                        <Button
                          aria-label={`Sign in to ${row.id}`}
                          disabled={row.busy || !found}
                          focusableWhenDisabled
                          onClick={() => onSignin(row.id)}
                          size="sm"
                          variant={row.required && !row.busy ? "default" : "outline"}
                        >
                          {row.busy ? <Spinner /> : <LogInIcon aria-hidden="true" />}
                          Sign in
                        </Button>
                      )}
                    </span>
                  </div>
                  {job && !p.signedIn && (
                    <>
                      <JobOutput job={job} />
                      <SigninSteps
                        checking={checking}
                        code={row.code}
                        link={row.link}
                        manual={row.manual}
                        onRecheck={onRecheck}
                      />
                    </>
                  )}
                </li>
              );
            })}
          </ul>
          {list.note && <p className="text-muted-foreground text-xs">{list.note}</p>}
        </>
      )}
    </section>
  );
}

function HarnessCardView({
  card,
  job,
  onAction,
  onRecheck,
  checking,
  children,
}: {
  card: HarnessCard;
  job: Job | null;
  onAction: (action: HarnessAction) => void;
  onRecheck: () => void;
  checking: boolean;
  /** OpenCode only: the provider rows. */
  children?: React.ReactNode;
}) {
  const s = harnessSummary(card.id, card.checks);
  // OpenCode has no app install (the installer is copied) and signs in per provider (MET-93).
  const perProvider = card.id === "opencode";
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
    : !s.signedIn && !perProvider
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
            {perProvider && s.found ? (
              <span
                className={cn(
                  "wrap-anywhere",
                  !s.signedIn &&
                    (tone === "warn" ? "text-warning-foreground" : "text-destructive-foreground"),
                )}
              >
                {s.signedIn ? "Yes, every provider below" : s.signIn}
              </span>
            ) : s.signedIn ? (
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
        {perProvider && !s.found && card.commands.install && (
          <div className="grid gap-1.5">
            <p className="text-muted-foreground text-xs">
              Run the official installer in a terminal, then press Recheck.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <CopyField label="the installer command" text={card.commands.install} />
              <RecheckButton checking={checking} onRecheck={onRecheck} />
            </div>
          </div>
        )}
        {children}
        <BinaryPath card={card} onSaved={onRecheck} />
      </CardContent>
      <CardFooter className="flex-wrap">
        {(["install", "update", "signin"] as const).map((action) => {
          // Each button shows only when it can help: Sign in only while signed out.
          const show =
            action === "install"
              ? !s.found && !perProvider
              : action === "signin"
                ? s.found && !s.signedIn && !perProvider
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
        {perProvider ? (
          s.found && (
            <span className="ms-auto text-muted-foreground text-xs">
              Update runs <code className="font-mono">{card.commands.update}</code>
            </span>
          )
        ) : (
          <span className="ms-auto text-muted-foreground text-xs">
            {s.found ? "Sign in runs " : "Runs "}
            <code className="font-mono">
              {s.found ? card.commands.signin : card.commands.install}
            </code>
          </span>
        )}
      </CardFooter>
      {job && (
        <div className="grid gap-2 px-4 pb-3">
          <JobOutput job={job} />
          {!perProvider && (
            <SigninPrompt
              card={card}
              checking={checking}
              job={job}
              onRecheck={onRecheck}
              signedIn={s.signedIn}
            />
          )}
        </div>
      )}
    </Card>
  );
}

export function Harnesses({ onChecksChanged }: { onChecksChanged: () => void }) {
  const [cards, setCards] = useState<Load<HarnessCard[]>>({ status: "loading" });
  const [jobs, setJobs] = useState<Record<string, Job>>({});
  const [providers, setProviders] = useState<Load<OpencodeProviders>>({ status: "loading" });
  const [checking, setChecking] = useState(false);

  // The provider rows load with the cards, so one Recheck reads both.
  const loadProviders = useCallback(async () => {
    try {
      setProviders({ status: "ready", data: await readOpencodeProviders() });
    } catch (e) {
      setProviders((p) => (p.status === "ready" ? p : { status: "error", error: message(e) }));
    }
  }, []);

  const load = useCallback(async () => {
    setChecking(true);
    try {
      const { harnesses } = await readHarnesses();
      setCards({ status: "ready", data: harnesses });
      setJobs((j) => ({
        ...Object.fromEntries(harnesses.flatMap((h) => (h.job ? [[jobKey(h.job), h.job]] : []))),
        ...j,
      }));
      if (harnesses.some((h) => h.id === "opencode")) await loadProviders();
    } catch (e) {
      setCards((c) => (c.status === "ready" ? c : { status: "error", error: message(e) }));
    } finally {
      setChecking(false);
    }
  }, [loadProviders]);

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
      show: (job) => setJobs((j) => ({ ...j, [jobKey(job)]: job })),
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

  async function signinProvider(provider: string) {
    try {
      const job = await signinOpencodeProvider(provider);
      stream.current?.started(job);
      setJobs((j) => ({ ...j, [jobKey(job)]: job }));
    } catch (e) {
      toast.add({ type: "error", title: "Sign in did not start", description: message(e) });
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
        >
          {card.id === "opencode" && (
            <OpencodeProviderList
              checking={checking}
              found={harnessSummary(card.id, card.checks).found}
              jobs={jobs}
              load={providers}
              onRecheck={recheck}
              onSignin={(p) => void signinProvider(p)}
            />
          )}
        </HarnessCardView>
      ))}
      <p className="text-muted-foreground text-xs">
        harnessd runs only these fixed commands. Keys go in only through each CLI's own sign-in.
      </p>
    </div>
  );
}
