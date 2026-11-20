// Settings → Connections (MET-28): GitHub, Linear, Slack, git, the port and the skill pack,
// each with its doctor checks, the fix for a failure and Check again. No secret is shown.
import { RotateCwIcon } from "lucide-react";
import { ServiceLogo } from "../../components/service-logo.tsx";
import { Button } from "../../components/ui/button.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../components/ui/card.tsx";
import { Skeleton } from "../../components/ui/skeleton.tsx";
import { Spinner } from "../../components/ui/spinner.tsx";
import type { Status } from "../../hooks/useStatus.ts";
import { connectionService } from "../../lib/services.ts";
import { connectionCards } from "../../lib/setup.ts";
import { ErrorState } from "../common.tsx";
import { CheckLine, StateBadge } from "./parts.tsx";

const LABEL = { ok: "OK", warn: "Warning", fail: "Failing", missing: "Not set up" } as const;

export function Connections({ status }: { status: Status }) {
  const s = status.status;
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
      {connectionCards(s.data)
        .sort((a, b) => Number(a.state === "ok") - Number(b.state === "ok"))
        .map((card) => {
          const logo = connectionService(card.id);
          return (
            <Card key={card.id}>
              <CardHeader className="pb-1">
                <div className="min-w-0 flex-1">
                  <CardTitle className="flex items-center gap-2">
                    {logo && <ServiceLogo service={logo} />}
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
              <CardContent>
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
              </CardContent>
            </Card>
          );
        })}
    </div>
  );
}
