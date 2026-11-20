// The workspace vault glossary and draft decision records (D-017, D-021). The coordinator
// grill writes both. The repo's own GLOSSARY.md and docs/decisions/ stay human-reviewed.
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { GlossaryTerm, Precedent } from "@harnessd/shared";
import { slugify } from "./decisions.ts";
import {
  type FrontmatterValue,
  listNotes,
  resolveNote,
  stripFrontmatter,
  VaultError,
  writeNote,
} from "./vault.ts";

/** A new term as the grill writes it: the term plus the issue that found it. */
export interface TermNote extends Omit<GlossaryTerm, "avoid"> {
  issue: string;
  avoid?: string[];
}

/** A precedent as the grill writes it: the precedent plus the issue that set it. */
export interface DraftNote extends Precedent {
  issue: string;
}

export const GLOSSARY_FOLDER = "glossary";
export const DRAFTS_FOLDER = "decision-drafts";

function required(value: string, what: string): string {
  const v = typeof value === "string" ? value.trim() : "";
  if (v === "") throw new VaultError(`${what} is required`);
  return v;
}

async function exists(vault: string, path: string): Promise<boolean> {
  const { file } = await resolveNote(vault, path);
  return stat(file).then(
    () => true,
    () => false,
  );
}

/** Writes once and never overwrites. Returns the vault-relative path, or undefined if the note exists. */
async function writeOnce(
  vault: string,
  path: string,
  body: string,
  frontmatter: Record<string, FrontmatterValue>,
): Promise<string | undefined> {
  if (await exists(vault, path)) return undefined;
  return writeNote(vault, path, body, frontmatter);
}

/**
 * Writes `glossary/<slug>.md` in the GLOSSARY-FORMAT style. The first definition of a
 * term wins: a term whose note exists is not written again, and the result is undefined.
 */
export async function writeGlossaryTerm(
  vault: string,
  note: TermNote,
): Promise<string | undefined> {
  const issue = required(note.issue, "glossary term: issue").toUpperCase();
  const term = required(note.term, "glossary term: term");
  const definition = required(note.definition, "glossary term: definition");
  const avoid = (note.avoid ?? []).map((a) => a.trim()).filter((a) => a !== "");
  const lines = [`**${term}**:`, definition];
  if (avoid.length > 0) lines.push(`_Avoid_: ${avoid.join(", ")}`);
  const frontmatter: Record<string, FrontmatterValue> = { term, issue };
  if (avoid.length > 0) frontmatter.avoid = avoid;
  return writeOnce(vault, `${GLOSSARY_FOLDER}/${slugify(term)}`, lines.join("\n"), frontmatter);
}

/** The body of every term note in `glossary/`, sorted by file name. Empty when there is none. */
export async function readGlossary(vault: string): Promise<string[]> {
  const folder = join(vault, GLOSSARY_FOLDER);
  const out: string[] = [];
  for (const rel of await listNotes(folder)) {
    const text = stripFrontmatter(await readFile(join(folder, rel), "utf8")).trim();
    if (text !== "") out.push(text);
  }
  return out;
}

/**
 * Writes `decision-drafts/<ISSUE>-<slug>.md`: a decision record in the docs/decisions/
 * style with `Status: draft`. The number stays D-NNN until a docs PR accepts it.
 * An existing draft is not overwritten, and the result is undefined.
 */
export async function writeDraftDecision(
  vault: string,
  note: DraftNote,
  now: Date = new Date(),
): Promise<string | undefined> {
  const issue = required(note.issue, "draft decision: issue").toUpperCase();
  const title = required(note.title, "draft decision: title");
  const decision = required(note.decision, "draft decision: decision");
  const why = required(note.why, "draft decision: why");
  const date = now.toISOString().slice(0, 10);
  const body = [
    `# D-NNN ${title}`,
    `Status: draft ${date}. From the coordinator grill of ${issue}; open a docs PR to accept it.`,
    "",
    decision,
    "",
    `Why: ${why}`,
    "",
    `Issue: ${issue}.`,
  ].join("\n");
  return writeOnce(vault, `${DRAFTS_FOLDER}/${issue}-${slugify(title)}`, body, {
    issue,
    status: "draft",
  });
}
