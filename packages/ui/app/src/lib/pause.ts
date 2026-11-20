// The kill switch is optimistic: the click shows the new state at once, the daemon confirms it,
// and a failed call rolls back to the last confirmed state (DESIGN.md, UX checklist).

export interface PauseState {
  paused: boolean;
  since?: string;
  reason?: string;
}

export type PauseBusy = "pausing" | "resuming" | null;

export interface PauseView {
  /** The daemon's last known state. */
  confirmed: PauseState;
  /** What the UI shows: the optimistic state while a call is in flight. */
  shown: PauseState;
  busy: PauseBusy;
}

const RUNNING: PauseState = { paused: false };

/** A state from the daemon. While a call is in flight, the optimistic state stays shown. */
export function pauseView(state: PauseState | undefined, prev?: PauseView): PauseView {
  const confirmed = state ?? RUNNING;
  if (prev?.busy) return { ...prev, confirmed };
  return { confirmed, shown: confirmed, busy: null };
}

export function pauseStarted(view: PauseView, action: "pause" | "resume"): PauseView {
  return action === "pause"
    ? { confirmed: view.confirmed, shown: { paused: true }, busy: "pausing" }
    : { confirmed: view.confirmed, shown: { paused: false }, busy: "resuming" };
}

export function pauseSettled(_view: PauseView, state: PauseState): PauseView {
  return { confirmed: state, shown: state, busy: null };
}

export function pauseFailed(view: PauseView): PauseView {
  return { confirmed: view.confirmed, shown: view.confirmed, busy: null };
}
