// The kill switch. Always in the header, never behind a confirmation (DESIGN.md).
import { PauseIcon, PlayIcon } from "lucide-react";
import { Button } from "../components/ui/button.tsx";
import { Spinner } from "../components/ui/spinner.tsx";
import type { PauseView } from "../lib/pause.ts";

export function PauseButton({ view, onToggle }: { view: PauseView; onToggle: () => void }) {
  const { busy, shown } = view;
  const text =
    busy === "pausing"
      ? "Pausing"
      : busy === "resuming"
        ? "Resuming"
        : shown.paused
          ? "Resume"
          : "Pause all";
  return (
    <Button
      aria-disabled={busy !== null || undefined}
      className="min-w-28"
      data-pause-control
      onClick={onToggle}
      variant={shown.paused ? "default" : "outline"}
    >
      {busy ? (
        <Spinner />
      ) : shown.paused ? (
        <PlayIcon aria-hidden="true" />
      ) : (
        <PauseIcon aria-hidden="true" />
      )}
      <span>{text}</span>
      <span className="sr-only">{text === "Pause all" ? " agents" : " all agents"}</span>
    </Button>
  );
}
