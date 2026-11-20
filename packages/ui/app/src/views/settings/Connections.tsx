// Settings → Connections (MET-28): GitHub, Linear, Slack, git, the port and the skill pack,
// each with its doctor checks, the fix for a failure and Check again. Linear and Slack take
// their secret in a write-only field (MET-33). No secret is ever shown.
import { RotateCwIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import {
  Card,
  CardDescription,
  CardHeader,
  CardPanel,
  CardTitle,
} from "../../components/ui/card.tsx";
import { Skeleton } from "../../components/ui/skeleton.tsx";
import { Spinner } from "../../components/ui/spinner.tsx";
import type { Status } from "../../hooks/useStatus.ts";
import { type SecretId, type SecretState, secretFor } from "../../lib/secrets.ts";
import { connectionCards } from "../../lib/setup.ts";
import { readSecrets } from "../../setupApi.ts";
import { ErrorState } from "../common.tsx";
import { CheckLine, StateBadge } from "./parts.tsx";
import { SecretField } from "./SecretField.tsx";

const LABEL = { ok: "OK", warn: "Warning", fail: "Failing", missing: "Not set up" } as const;

/** Set or not, and the source, per secret; "error" when they could not be read. */
function useSecrets() {
  const [secrets, setSecrets] = useState<Partial<Record<SecretId, SecretState>> | "error">();
  const live = useRef(true);
  const load = useCallback(() => {
    setSecrets(undefined);
    readSecrets().then(
      ({ secrets: list }) =>
        live.current && setSecrets(Object.fromEntries(list.map((x) => [x.id, x]))),
      () => live.current && setSecrets("error"),
    );
  }, []);
  useEffect(() => {
    live.current = true;
    load();
    return () => {
      live.current = false;
    };
  }, [load]);
  const put = (state: SecretState) =>
    setSecrets((all) => ({ ...(all === "error" ? {} : all), [state.id]: state }));
  return { secrets, put, retry: load };
}

/**
 * Failing cards first, fixed after each full run of the checks. A save re-runs one card's
 * checks; that card keeps its place, so nothing moves under the cursor.
 */
function useCardOrder(loads: number, ids: () => string[]): (a: string, b: string) => number {
  const order = useRef<{ loads: number; ids: string[] }>({ loads: -1, ids: [] });
  if (order.current.loads !== loads) order.current = { loads, ids: ids() };
  const at = (id: string) => order.current.ids.indexOf(id);
  return (a, b) => at(a) - at(b);
}

export function Connections({ status }: { status: Status }) {
  const s = status.status;
  const { secrets, put, retry } = useSecrets();
  const cards = s.status === "ready" ? connectionCards(s.data) : [];
  const byOrder = useCardOrder(status.loads, () =>
    [...cards].sort((a, b) => Number(a.state === "ok") - Number(b.state === "ok")).map((c) => c.id),
  );
  if (s.status === "loading") {
    return (
      <div className="grid gap-3 sm:grid-cols-2" aria-hidden="true">
        {["a", "b", "c", "d", "e", "f"].map((k) => (
          <Skeleton className="h-36" key={k} shape="card" />
        ))}
      </div>
    );
  }
  if (s.status === "error") {
    return <ErrorState onRetry={status.retry} text={`Could not run the checks. ${s.error}`} />;
  }
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {[...cards]
        .sort((a, b) => byOrder(a.id, b.id))
        .map((card) => {
          const spec = secretFor(card.id);
          return (
            <Card key={card.id}>
              <CardHeader className="pb-1">
                <div className="min-w-0 flex-1">
                  <CardTitle className="flex items-center gap-2">
                    {card.title}
                    <StateBadge state={card.state}>{LABEL[card.state]}</StateBadge>
                  </CardTitle>
                  <CardDescription>{card.about}</CardDescription>
                </div>
                {card.state !== "ok" && (
                  <Button
                    aria-label={`Check ${card.title} again`}
                    disabled={status.checking}
                    onClick={() => void status.recheck()}
                    size="sm"
                    variant="ghost-muted"
                  >
                    {status.checking ? <Spinner /> : <RotateCwIcon aria-hidden="true" />}
                    Check again
                  </Button>
                )}
              </CardHeader>
              <CardPanel>
                {card.checks.length === 0 ? (
                  <p className="py-2 text-muted-foreground text-xs">
                    No check ran for this connection.
                  </p>
                ) : (
                  <ul className="divide-y">
                    {card.checks.map((c) => (
                      <CheckLine check={c} key={c.id} />
                    ))}
                  </ul>
                )}
                {spec && (
                  <SecretField
                    onSaved={(state, checks) => {
                      put(state);
                      status.replace(spec.prefix, checks);
                    }}
                    onRetry={retry}
                    spec={spec}
                    state={
                      secrets === undefined || secrets === "error"
                        ? secrets
                        : (secrets[spec.id] ?? {
                            id: spec.id,
                            set: false,
                            source: null,
                            stored: false,
                          })
                    }
                    title={card.title}
                  />
                )}
              </CardPanel>
            </Card>
          );
        })}
    </div>
  );
}
