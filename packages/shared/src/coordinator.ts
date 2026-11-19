// Grill contract between the coordinator and the rest of harnessd. See docs/COORDINATOR.md.

/** The only reasons the coordinator may ask the human (D-011). */
export const ESCALATION_TRIGGERS = [
  "irreversible",
  "money",
  "secret_or_account",
  "public_api_data_model_or_protected_path",
  "taste_no_precedent",
] as const;

export type EscalationTrigger = (typeof ESCALATION_TRIGGERS)[number];

/** D-011 wording of each trigger, used in prompts and comments. */
export const ESCALATION_TRIGGER_LABELS: Record<EscalationTrigger, string> = {
  irreversible: "irreversible or costly to undo",
  money: "needs money",
  secret_or_account: "needs a secret or an account",
  public_api_data_model_or_protected_path:
    "changes a public API, the data model or a protected path",
  taste_no_precedent: "a product or taste call with no precedent in the spec",
};

export function isEscalationTrigger(value: string): value is EscalationTrigger {
  return (ESCALATION_TRIGGERS as readonly string[]).includes(value);
}

/** One question the coordinator settled itself, and why. */
export interface Call {
  question: string;
  answer: string;
  /** Where the answer comes from: spec section, decision record, code path or vault note. */
  basis: string;
}

/** A question only the human can answer. */
export interface Escalation {
  trigger: EscalationTrigger;
  question: string;
  why: string;
}

export type GrillOutcome = "proceed" | "needs_input" | "error";

export interface GrillResult {
  calls: Call[];
  escalation: Escalation | null;
  outcome: GrillOutcome;
  /** Short reason when the outcome is `error`. */
  error?: string;
}

/** A decision note as written to the vault (same shape as the memory vault's notes). */
export interface DecisionNote {
  /** Issue key, e.g. "MET-12". */
  issue: string;
  title: string;
  question: string;
  decision: string;
  basis: string;
}
