import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ESCALATION_TRIGGER_LABELS, ESCALATION_TRIGGERS, type Issue } from "@harnessd/shared";

/** A decision record from docs/decisions/. */
export interface DecisionRecord {
  /** File name, e.g. "D-011-autopilot-escalation.md". */
  name: string;
  text: string;
}

/** What the grill reads from the repo besides the issue. */
export interface GrillContext {
  /** docs/SPEC.md, or empty when the repo has none. */
  spec: string;
  /** docs/decisions/*.md, sorted by file name. */
  decisions: DecisionRecord[];
}

async function readIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Reads docs/SPEC.md and docs/decisions/*.md from a repo. Missing files read as empty. */
export async function loadGrillContext(repoDir: string): Promise<GrillContext> {
  const docs = join(repoDir, "docs");
  const spec = (await readIfPresent(join(docs, "SPEC.md"))) ?? "";
  let names: string[] = [];
  try {
    names = (await readdir(join(docs, "decisions"))).filter((n) => n.endsWith(".md")).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const decisions: DecisionRecord[] = [];
  for (const name of names) {
    const text = await readIfPresent(join(docs, "decisions", name));
    if (text !== undefined) decisions.push({ name, text: text.trim() });
  }
  return { spec: spec.trim(), decisions };
}

export interface GrillPromptInput {
  issue: Issue;
  context: GrillContext;
  /** The coordinator's resolved instruction text. */
  instructions?: string;
}

/** The JSON shape the coordinator must reply with. */
export const GRILL_REPLY_SHAPE = `{
  "calls": [{ "question": "string", "answer": "string", "basis": "string" }],
  "escalation": null | { "trigger": "${ESCALATION_TRIGGERS.join(" | ")}", "question": "string", "why": "string" }
}`;

function doneWhenList(issue: Issue): string {
  if (issue.doneWhen.length === 0) return "(none parsed from the body)";
  return issue.doneWhen.map((d) => `- [${d.checked ? "x" : " "}] ${d.text}`).join("\n");
}

/** Builds the self-grill prompt for one issue. */
export function buildGrillPrompt({ issue, context, instructions }: GrillPromptInput): string {
  const triggers = ESCALATION_TRIGGERS.map((t) => `- ${t}: ${ESCALATION_TRIGGER_LABELS[t]}`).join(
    "\n",
  );
  const decisions =
    context.decisions.length === 0
      ? "(none)"
      : context.decisions.map((d) => `### ${d.name}\n${d.text}`).join("\n\n");
  const parts = [
    "You are the harnessd coordinator. Grill this Linear issue before any work starts (D-011).",
    "List every question a builder would have to settle: ambiguity, missing details, conflicts with the spec or decisions. " +
      "Answer each one yourself from the spec, the decision records below, the code in this repo and the vault in .harnessd/vault/. " +
      "You may read files; do not edit anything.",
    `Escalate only when a question cannot be settled by you and it falls under one of these D-011 triggers:\n${triggers}\n` +
      "Anything else you decide, record as a call and proceed. At most one escalation: the single question the human must answer.",
    `Reply with strict JSON only, no prose and no code fence, in exactly this shape:\n${GRILL_REPLY_SHAPE}\n` +
      'Each "basis" names its source (spec section, decision id, file path or vault note).',
  ];
  if (instructions?.trim()) parts.push(`## Coordinator instructions\n${instructions.trim()}`);
  parts.push(
    `## Issue ${issue.key}: ${issue.title}\nURL: ${issue.url}\nSize: ${issue.size ?? "unknown"}\n\n` +
      `### Body\n${issue.description.trim() || "(empty)"}\n\n### Done when\n${doneWhenList(issue)}`,
    `## Spec (docs/SPEC.md)\n${context.spec || "(missing)"}`,
    `## Decision records (docs/decisions/)\n${decisions}`,
  );
  return `${parts.join("\n\n")}\n`;
}
