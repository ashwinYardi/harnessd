import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ESCALATION_TRIGGER_LABELS, ESCALATION_TRIGGERS, type Issue } from "@harnessd/shared";
import { readGlossary } from "../memory/glossary.ts";
import { stripFrontmatter } from "../memory/vault.ts";

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
  /** GLOSSARY.md at the repo root, when present. Human-reviewed; the loop never writes it. */
  glossary?: string;
  /** The workspace glossary: term notes from `<repo>/.harnessd/vault/glossary/`, when there are any. */
  vaultGlossary?: string[];
  /** The grill-with-docs method. The prompt uses BUILT_IN_GRILL_METHOD when it is missing. */
  method?: GrillMethod;
}

/** The grill-with-docs method text and where it came from. */
export interface GrillMethod {
  /** `skill pack`: the installed grilling and domain-modeling skills. `built-in`: the fallback. */
  source: "skill pack" | "built-in";
  text: string;
}

/** The skills grill-with-docs names (its SKILL.md calls the Skill tool for these two). */
export const GRILL_WITH_DOCS_SKILLS = ["grilling", "domain-modeling"] as const;

/** The method when the skill pack is not installed: a short form of the two skills. */
export const BUILT_IN_GRILL_METHOD = [
  "### grilling",
  "Map the issue as a design tree: every decision branches into the decisions that hang off it.",
  "The frontier is every decision whose prerequisites are settled. Work the frontier in rounds until it is empty.",
  "Find facts in the repo yourself. Leave nothing silently assumed.",
  "",
  "### domain-modeling",
  "Challenge each term in the issue against the glossary. Name a conflict at once.",
  "Replace vague or overloaded words with one precise term.",
  "Test each relationship with concrete edge-case scenarios.",
  "Check claims about behaviour against the code.",
  "A term is new only if it is specific to this project. Define what it is in one or two sentences, and list words to avoid.",
  "Record a decision only when it is hard to reverse, surprising without context, and the result of a real trade-off.",
].join("\n");

async function readIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * Builds the method from `<skillsDir>/grilling/SKILL.md` and `<skillsDir>/domain-modeling/SKILL.md`
 * (the MET-21 pack in `~/.harnessd/skills/`). Frontmatter is dropped. When either is missing or
 * empty, or there is no skillsDir, it is the built-in method.
 */
export async function loadGrillMethod(skillsDir: string | undefined): Promise<GrillMethod> {
  const builtIn = BUILT_IN_METHOD;
  if (skillsDir === undefined) return builtIn;
  const parts: string[] = [];
  for (const name of GRILL_WITH_DOCS_SKILLS) {
    const text = await readIfPresent(join(skillsDir, name, "SKILL.md")).catch(() => undefined);
    const body = text === undefined ? "" : stripFrontmatter(text).trim();
    if (body === "") return builtIn;
    parts.push(`### ${name}\n${body}`);
  }
  return { source: "skill pack", text: parts.join("\n\n") };
}

const BUILT_IN_METHOD: GrillMethod = { source: "built-in", text: BUILT_IN_GRILL_METHOD };

export interface LoadGrillContextOptions {
  /** Where the skill pack is installed, e.g. `~/.harnessd/skills`. Without it the method is not loaded. */
  skillsDir?: string | undefined;
}

/**
 * Reads docs/SPEC.md, docs/decisions/*.md, GLOSSARY.md and the workspace vault glossary
 * from a repo, and the method from the skill pack. Missing files read as empty; optional
 * parts are left out.
 */
export async function loadGrillContext(
  repoDir: string,
  options: LoadGrillContextOptions = {},
): Promise<GrillContext> {
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
  const context: GrillContext = { spec: spec.trim(), decisions };
  const glossary = (await readIfPresent(join(repoDir, "GLOSSARY.md")))?.trim();
  if (glossary) context.glossary = glossary;
  const vaultGlossary = await readGlossary(join(repoDir, ".harnessd", "vault"));
  if (vaultGlossary.length > 0) context.vaultGlossary = vaultGlossary;
  if (options.skillsDir !== undefined) context.method = await loadGrillMethod(options.skillsDir);
  return context;
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
  "escalation": null | { "trigger": "${ESCALATION_TRIGGERS.join(" | ")}", "question": "string", "why": "string" },
  "terms": [{ "term": "string", "definition": "string", "avoid": ["string"] }],
  "precedents": [{ "title": "string", "decision": "string", "why": "string" }]
}`;

/** How the coordinator runs grill-with-docs with nobody to answer (D-017, D-022). */
const HEADLESS_RULES = [
  "No human answers during the grill. These rules override the method where they differ:",
  "- Build the design tree. Answer each frontier question yourself, with a basis. Then recompute the frontier. Stop when it is empty.",
  "- Do not ask, wait or pause for the user. Do not call the Skill tool. Do not edit or write any file.",
  "- Each settled question is one entry in calls.",
  "- A new domain term goes in terms, not in GLOSSARY.md. Skip terms that a glossary below already defines.",
  "- A call that passes all three decision-record tests (hard to reverse, surprising, a real trade-off) also goes in precedents. Leave precedents empty when no call sets new precedent.",
  "- Only a D-011 trigger goes to the human, as the escalation.",
].join("\n");

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
    "You are the harnessd coordinator. Grill this Linear issue with the grill-with-docs method before any work starts (D-011, D-017).",
    "List every question a builder would have to settle: ambiguity, missing details, conflicts with the spec or decisions. " +
      "Answer each one yourself from the spec, the decision records and the glossaries below, the code in this repo and the vault in .harnessd/vault/. " +
      "You may read files; do not edit anything.",
    `Escalate only when a question cannot be settled by you and it falls under one of these D-011 triggers:\n${triggers}\n` +
      "Anything else you decide, record as a call and proceed. At most one escalation: the single question the human must answer.",
    `Reply with strict JSON only, no prose and no code fence, in exactly this shape:\n${GRILL_REPLY_SHAPE}\n` +
      'Each "basis" names its source (spec section, decision id, file path or vault note).',
  ];
  const method = context.method ?? BUILT_IN_METHOD;
  parts.push(`## Method: grill-with-docs (${method.source})\n${HEADLESS_RULES}\n\n${method.text}`);
  if (instructions?.trim()) parts.push(`## Coordinator instructions\n${instructions.trim()}`);
  parts.push(
    `## Issue ${issue.key}: ${issue.title}\nURL: ${issue.url}\nSize: ${issue.size ?? "unknown"}\n\n` +
      `### Body\n${issue.description.trim() || "(empty)"}\n\n### Done when\n${doneWhenList(issue)}`,
    `## Spec (docs/SPEC.md)\n${context.spec || "(missing)"}`,
    `## Decision records (docs/decisions/)\n${decisions}`,
    `## Glossary (GLOSSARY.md)\n${context.glossary || "(none)"}`,
  );
  if (context.vaultGlossary && context.vaultGlossary.length > 0) {
    parts.push(
      `## Workspace glossary (.harnessd/vault/glossary/)\n${context.vaultGlossary.join("\n\n")}`,
    );
  }
  return `${parts.join("\n\n")}\n`;
}

/** The two memory vaults an agent run can read and write (D-005). */
export interface AgentMemory {
  /** `<main repo>/.harnessd/vault`. */
  workspaceVault: string;
  /** `$HARNESSD_HOME/vault`, by default `~/.harnessd/vault`. */
  globalVault: string;
}

/**
 * The part and QA prompts' "Memory" section (MET-55): the memory tools, the vaults, and
 * the harness files the loop synced into the worktree before the run.
 */
export function memorySection({ workspaceVault, globalVault }: AgentMemory): string {
  const dir = (path: string) => (path.endsWith("/") ? path : `${path}/`);
  return [
    "## Memory",
    "The harnessd-memory MCP server serves the memory vaults. Use its tools: search_notes, read_note and write_note.",
    `- Workspace vault: ${dir(workspaceVault)}`,
    `- Global vault: ${dir(globalVault)} ($HARNESSD_HOME/vault/)`,
    "Search the vaults before you settle a question the spec and the decisions do not answer.",
    "",
    "harnessd synced the harness files into this worktree before the run: AGENTS.md, CLAUDE.md, .claude/, .agents/, .mcp.json and .codex/. " +
      "They are not part of your change unless the issue asks, and git status does not show them. " +
      "To commit one, run `git update-index --no-skip-worktree <path>` for a tracked file, then `git add -f <path>`.",
  ].join("\n");
}
