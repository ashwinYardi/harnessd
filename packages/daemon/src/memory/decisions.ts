import { VaultError, writeNote } from "./vault.ts";

/** A call the coordinator made instead of asking the human (SPEC autonomy loop, D-011). */
export interface DecisionNote {
  /** Linear issue key, such as `MET-11`. */
  issue: string;
  /** Short title; it becomes the file name slug. */
  title: string;
  question: string;
  decision: string;
  /** What settled it: spec section, decision record, code or vault note. */
  basis: string;
}

const ISSUE_KEY = /^[A-Z][A-Z0-9]*-\d+$/;

/** `Pick the DB, now!` becomes `pick-the-db-now`. At most 60 characters. */
export function slugify(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return slug === "" ? "decision" : slug;
}

/**
 * Writes `decisions/<ISSUE>-<slug>.md` with YAML frontmatter (issue, question,
 * decision, basis) and a readable body. Writing the same issue and title again
 * overwrites the note. Returns the vault-relative path.
 */
export async function writeDecisionNote(vault: string, note: DecisionNote): Promise<string> {
  const issue = note.issue.trim().toUpperCase();
  if (!ISSUE_KEY.test(issue)) {
    throw new VaultError(`issue must be a key like MET-11, got ${JSON.stringify(note.issue)}`);
  }
  for (const key of ["title", "question", "decision", "basis"] as const) {
    if (typeof note[key] !== "string" || note[key].trim() === "") {
      throw new VaultError(`decision note: ${key} is required`);
    }
  }
  const title = note.title.trim();
  const question = note.question.trim();
  const decision = note.decision.trim();
  const basis = note.basis.trim();
  const body = [
    `# ${issue}: ${title}`,
    `## Question\n\n${question}`,
    `## Decision\n\n${decision}`,
    `## Basis\n\n${basis}`,
  ].join("\n\n");
  return writeNote(vault, `decisions/${issue}-${slugify(title)}`, body, {
    issue,
    question,
    decision,
    basis,
  });
}
