import { join } from "node:path";
import type { DecisionNote } from "@harnessd/shared";
import { writeDecisionNote } from "../memory/decisions.ts";
import {
  type DraftNote,
  type TermNote,
  writeDraftDecision,
  writeGlossaryTerm,
} from "../memory/glossary.ts";

/**
 * Where the grill's notes go. `write` returns the path or id of the written note.
 * `term` and `draft` return undefined when the note already exists. A sink without
 * them drops terms and drafts; the Linear comment still lists them.
 */
export interface DecisionSink {
  write(note: DecisionNote): Promise<string>;
  /** A new term for the workspace vault glossary. */
  term?(note: TermNote): Promise<string | undefined>;
  /** A draft decision record for a docs PR. */
  draft?(note: DraftNote): Promise<string | undefined>;
}

/** `<repo>/.harnessd/vault`, the workspace vault. */
export function workspaceVaultDir(repoDir: string): string {
  return join(repoDir, ".harnessd", "vault");
}

/**
 * Writes each note into the memory vault (MET-17) at `<vault>/decisions/<ISSUE>-<slug>.md`.
 * The same issue and title rewrite one note. Terms go to `<vault>/glossary/` and drafts to
 * `<vault>/decision-drafts/`; neither is overwritten. Returns absolute file paths.
 */
export function createFileDecisionSink(vaultDir: string): DecisionSink {
  const abs = (rel: string | undefined) => (rel === undefined ? undefined : join(vaultDir, rel));
  return {
    async write(note) {
      return join(vaultDir, await writeDecisionNote(vaultDir, note));
    },
    async term(note) {
      return abs(await writeGlossaryTerm(vaultDir, note));
    },
    async draft(note) {
      return abs(await writeDraftDecision(vaultDir, note));
    },
  };
}
