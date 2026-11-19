import { join } from "node:path";
import type { DecisionNote } from "@harnessd/shared";
import { writeDecisionNote } from "../memory/decisions.ts";

/** Where decision notes go. Returns the path or id of the written note. */
export interface DecisionSink {
  write(note: DecisionNote): Promise<string>;
}

/** `<repo>/.harnessd/vault`, the workspace vault. */
export function workspaceVaultDir(repoDir: string): string {
  return join(repoDir, ".harnessd", "vault");
}

/**
 * Writes each note into the memory vault (MET-17) at `<vault>/decisions/<ISSUE>-<slug>.md`.
 * The same issue and title rewrite one note. Returns the absolute file path.
 */
export function createFileDecisionSink(vaultDir: string): DecisionSink {
  return {
    async write(note) {
      return join(vaultDir, await writeDecisionNote(vaultDir, note));
    },
  };
}
