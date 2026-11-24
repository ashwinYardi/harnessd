// The split plan: which backend and frontend parts an issue needs (SPEC "The team", D-014).
// See docs/LOOP.md.
import type {
  Call,
  HarnessAdapter,
  Issue,
  ResolvedAgentConfig,
  Size,
  Task,
  TokenUsage,
} from "@harnessd/shared";
import { COORDINATOR_MAX_TURNS } from "./dispatch.ts";
import { extractJson, type RunReply, runForReply } from "./grill.ts";
import type { GrillContext } from "./prompt.ts";

/** Roles a planned part can have. QA is added by harnessd, never planned. */
export const PART_ROLES = ["backend", "frontend"] as const;
export type PartRole = (typeof PART_ROLES)[number];

export function isPartRole(value: string): value is PartRole {
  return (PART_ROLES as readonly string[]).includes(value);
}

const SIZES: readonly Size[] = ["S", "M", "L"];

/** At most this many parts per issue; more means the issue itself is wrong. */
export const MAX_PLAN_PARTS = 6;

/** A part covers at most this many parent Done-when items (MET-160). */
export const MAX_PART_DONE_WHEN = 3;

/** A part changes at most this many files (MET-160). */
export const MAX_PART_FILES = 8;

/** Paths of the frontend area: the UI app (MET-161). */
export const FRONTEND_AREA_PREFIX = "packages/ui/app/";

/**
 * Paths of the backend area: daemon, shared types, CLI and the daemon-side UI serving
 * (MET-161).
 */
export const BACKEND_AREA_PREFIXES = [
  "packages/daemon/",
  "packages/shared/",
  "packages/cli/",
  "packages/ui/src/",
] as const;

/**
 * Paths a frontend part must not list. The daemon-side UI serving sits in the backend area
 * but is not on this list, so a frontend part may still change it (MET-161).
 */
export const FRONTEND_FORBIDDEN_PREFIXES = [
  "packages/daemon/",
  "packages/shared/",
  "packages/cli/",
] as const;

/** The area a repo path belongs to. Docs may sit in a part of either area (MET-161). */
export type FileArea = "frontend" | "backend" | "docs" | "other";

function repoPath(file: string): string {
  return file.trim().replace(/^\.\//, "");
}

/** A path's area, from its prefix. A `.md` file or a `docs/` path is docs (MET-161). */
export function fileArea(file: string): FileArea {
  const path = repoPath(file);
  if (path.endsWith(".md") || path.startsWith("docs/")) return "docs";
  if (path.startsWith(FRONTEND_AREA_PREFIX)) return "frontend";
  if (BACKEND_AREA_PREFIXES.some((prefix) => path.startsWith(prefix))) return "backend";
  return "other";
}

/** True when a frontend part may not change this path (MET-161). */
export function isFrontendForbidden(file: string): boolean {
  const path = repoPath(file);
  return FRONTEND_FORBIDDEN_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/** One command a part runs to prove it works, and what the output must show. */
export interface PlanVerify {
  run: string;
  expect: string;
}

/** A decision record a part depends on, named in its brief (D-044). */
export interface PlanDecision {
  /** `D-NNN`, a file in `docs/decisions/`. */
  id: string;
  /** One sentence on why it applies to this part. */
  line: string;
}

/** The fixed brief of one part (MET-160). */
export interface PlanPart {
  role: PartRole;
  title: string;
  /** S or M. L is parsed so the loop can refuse it (D-014). */
  size: Size;
  /** One sentence on what the part achieves. */
  goal: string;
  /** 1-based numbers into the parent's parsed Done-when list. */
  doneWhen: number[];
  /** Repo-relative paths the part changes. */
  files: string[];
  /** Ordered steps, one action each. */
  steps: string[];
  /** The commands that prove the part, and what each must show. */
  verify: PlanVerify[];
  /** What this part leaves to another part or to a later ticket. */
  outOfScope: string;
  /** The records this part reads; the builder reads only these and its brief (D-044). */
  decisions?: PlanDecision[];
  /** Grill call numbers (1-based) or question texts that apply to this part (D-044). */
  calls?: (number | string)[];
}

export interface SplitPlan {
  parts: PlanPart[];
  /**
   * `bad` when both plan runs were unusable: there are no parts and the parent needs a
   * human (MET-160). `limited` when the harness hit a usage limit: there are no parts and
   * the issue is not split (MET-70). `harness` when the harness run itself failed: the next
   * tick uses the next harness (D-048).
   */
  source: "model" | "limited" | "harness" | "bad";
  /** Why the issue is one part or why it splits. Every model plan has one (MET-160). */
  reason?: string;
  /** The errors of the last rejected plan, joined on one line. */
  error?: string;
  /** Every error that rejected the second plan, one per entry (MET-160). */
  errors?: string[];
  /** Why the next plan run must use the next harness (D-048). */
  switchReason?: string;
  /** Tokens the plan runs used (D-040, D-043). */
  tokens?: TokenUsage;
  /** Turns the plan runs took, when the harness reports them. */
  turns?: number;
  /** True when every plan reply had unknown usage, so `tokens` counts nothing (MET-188). */
  usageUnknown?: true;
}

export type ParsedPlanReply =
  | { ok: true; parts: PlanPart[]; reason: string }
  | { ok: false; error: string };

/** The JSON shape the coordinator must reply with. */
export const PLAN_REPLY_SHAPE = `{
  "parts": [{
    "role": "backend" | "frontend",
    "title": "string",
    "size": "S" | "M",
    "goal": "one sentence",
    "doneWhen": [1, 2],
    "files": ["repo/relative/path.ts"],
    "steps": ["one action"],
    "verify": [{ "run": "command", "expect": "what its output must show" }],
    "outOfScope": "what this part leaves to another part",
    "decisions": [{ "id": "D-NNN", "line": "why it applies to this part" }],
    "calls": [1, "a grill question this part follows"]
  }],
  "reason": "why the issue stayed one part, or why it split"
}`;

/** A decision id: D- and three digits, as in a `docs/decisions/` file name. */
export const DECISION_ID = /^D-\d{3}$/;

/** Ids of the records that exist, from the grill context. */
export function knownDecisionIds(context: GrillContext): Set<string> {
  const ids = new Set<string>();
  for (const decision of context.decisions) {
    const match = /^(D-\d{3})(?:-|$)/.exec(decision.name);
    if (match?.[1]) ids.add(match[1]);
  }
  return ids;
}

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const PART_KEYS = [
  "role",
  "title",
  "size",
  "goal",
  "doneWhen",
  "files",
  "steps",
  "verify",
  "outOfScope",
  "decisions",
  "calls",
] as const;

export interface ParsePlanOptions {
  /**
   * The ids that have a record file. A well-formed id outside this set is dropped
   * with one log line (D-044). When absent, every well-formed id is kept.
   */
  knownIds?: ReadonlySet<string>;
  /** Receives one line per dropped decision id. */
  log?: (line: string) => void;
}

/**
 * Strictly validates a plan reply: known keys only, every brief field, 1 to 6 parts and a
 * reason. It checks the shape only; {@link checkPlan} checks the content and the caps.
 */
export function parsePlanReply(text: string, options: ParsePlanOptions = {}): ParsedPlanReply {
  let value: unknown;
  try {
    value = JSON.parse(extractJson(text));
  } catch (error) {
    return { ok: false, error: `not JSON: ${(error as Error).message}` };
  }
  if (!isObj(value)) return { ok: false, error: "expected a JSON object" };
  for (const key of Object.keys(value)) {
    if (key !== "parts" && key !== "reason") return { ok: false, error: `unknown key "${key}"` };
  }
  if (!Array.isArray(value.parts)) return { ok: false, error: "parts: expected an array" };
  if (value.parts.length === 0) return { ok: false, error: "parts: expected at least one part" };
  if (value.parts.length > MAX_PLAN_PARTS) {
    return { ok: false, error: `parts: expected at most ${MAX_PLAN_PARTS} parts` };
  }
  // Every plan says why the issue is one part or why it splits (MET-160).
  if (typeof value.reason !== "string" || value.reason.trim() === "") {
    return {
      ok: false,
      error: "reason: expected a non-empty string that says why the issue is one part or splits",
    };
  }
  const reason = value.reason.trim();
  const parts: PlanPart[] = [];
  for (const [i, raw] of value.parts.entries()) {
    const path = `parts[${i}]`;
    if (!isObj(raw)) return { ok: false, error: `${path}: expected an object` };
    for (const key of Object.keys(raw)) {
      if (!(PART_KEYS as readonly string[]).includes(key)) {
        return { ok: false, error: `${path}: unknown key "${key}"` };
      }
    }
    for (const key of ["role", "title", "size", "goal", "outOfScope"] as const) {
      const v = raw[key];
      if (typeof v !== "string" || v.trim() === "") {
        return { ok: false, error: `${path}.${key}: expected a non-empty string` };
      }
    }
    const role = (raw.role as string).trim();
    if (!isPartRole(role)) {
      return { ok: false, error: `${path}.role: expected backend or frontend, got "${role}"` };
    }
    const size = (raw.size as string).trim().toUpperCase();
    if (!(SIZES as readonly string[]).includes(size)) {
      return { ok: false, error: `${path}.size: expected S or M, got "${raw.size as string}"` };
    }
    const doneWhen = parseDoneWhen(raw.doneWhen, `${path}.doneWhen`);
    if ("error" in doneWhen) return { ok: false, error: doneWhen.error };
    const files = parseStringArray(raw.files, `${path}.files`);
    if ("error" in files) return { ok: false, error: files.error };
    const steps = parseStringArray(raw.steps, `${path}.steps`);
    if ("error" in steps) return { ok: false, error: steps.error };
    const verify = parseVerify(raw.verify, `${path}.verify`);
    if ("error" in verify) return { ok: false, error: verify.error };
    const decisions = parseDecisions(raw.decisions, `${path}.decisions`, options);
    if ("error" in decisions) return { ok: false, error: decisions.error };
    const calls = parsePartCalls(raw.calls, `${path}.calls`);
    if ("error" in calls) return { ok: false, error: calls.error };
    const part: PlanPart = {
      role,
      title: (raw.title as string).trim(),
      size: size as Size,
      goal: (raw.goal as string).trim(),
      doneWhen: doneWhen.value,
      files: files.value,
      steps: steps.value,
      verify: verify.value,
      outOfScope: (raw.outOfScope as string).trim(),
    };
    if (decisions.value.length > 0) part.decisions = decisions.value;
    if (calls.value.length > 0) part.calls = calls.value;
    parts.push(part);
  }
  return { ok: true, parts, reason };
}

/** A part's `doneWhen`: 1-based numbers into the parent's list. */
function parseDoneWhen(raw: unknown, path: string): { value: number[] } | { error: string } {
  if (!Array.isArray(raw)) return { error: `${path}: expected an array` };
  const value: number[] = [];
  for (const [i, entry] of raw.entries()) {
    if (typeof entry !== "number" || !Number.isInteger(entry) || entry < 1) {
      return { error: `${path}[${i}]: expected a positive Done-when number` };
    }
    value.push(entry);
  }
  return { value };
}

/** A list of strings: files or steps. A blank entry is caught by {@link checkPlan}. */
function parseStringArray(raw: unknown, path: string): { value: string[] } | { error: string } {
  if (!Array.isArray(raw)) return { error: `${path}: expected an array` };
  const value: string[] = [];
  for (const [i, entry] of raw.entries()) {
    if (typeof entry !== "string") return { error: `${path}[${i}]: expected a string` };
    value.push(entry.trim());
  }
  return { value };
}

/** A part's `verify` entries: a command and what its output must show. */
function parseVerify(raw: unknown, path: string): { value: PlanVerify[] } | { error: string } {
  if (!Array.isArray(raw)) return { error: `${path}: expected an array` };
  const value: PlanVerify[] = [];
  for (const [i, entry] of raw.entries()) {
    const at = `${path}[${i}]`;
    if (!isObj(entry)) return { error: `${at}: expected an object` };
    for (const key of Object.keys(entry)) {
      if (key !== "run" && key !== "expect") return { error: `${at}: unknown key "${key}"` };
    }
    if (typeof entry.run !== "string" || typeof entry.expect !== "string") {
      return { error: `${at}: expected run and expect strings` };
    }
    value.push({ run: entry.run.trim(), expect: entry.expect.trim() });
  }
  return { value };
}

/**
 * A part's optional `decisions`. A malformed entry makes the plan invalid. A well-formed
 * id with no record file is dropped with one log line (D-044).
 */
function parseDecisions(
  raw: unknown,
  path: string,
  options: ParsePlanOptions,
): { value: PlanDecision[] } | { error: string } {
  const value: PlanDecision[] = [];
  if (raw === undefined) return { value };
  if (!Array.isArray(raw)) return { error: `${path}: expected an array` };
  for (const [i, entry] of raw.entries()) {
    const at = `${path}[${i}]`;
    if (!isObj(entry)) return { error: `${at}: expected an object` };
    for (const key of Object.keys(entry)) {
      if (key !== "id" && key !== "line") return { error: `${at}: unknown key "${key}"` };
    }
    if (
      typeof entry.id !== "string" ||
      entry.id.trim() === "" ||
      typeof entry.line !== "string" ||
      entry.line.trim() === ""
    ) {
      return { error: `${at}: expected id and line strings` };
    }
    const id = entry.id.trim();
    if (!DECISION_ID.test(id)) {
      return { error: `${at}.id: expected D-NNN, got "${id}"` };
    }
    if (options.knownIds !== undefined && !options.knownIds.has(id)) {
      options.log?.(`plan: dropped decision ${id}: no record in docs/decisions/`);
      continue;
    }
    value.push({ id, line: entry.line.trim() });
  }
  return { value };
}

/** A part's optional `calls`: 1-based call numbers or the call's question text. */
function parsePartCalls(
  raw: unknown,
  path: string,
): { value: (number | string)[] } | { error: string } {
  const value: (number | string)[] = [];
  if (raw === undefined) return { value };
  if (!Array.isArray(raw)) return { error: `${path}: expected an array` };
  for (const [i, entry] of raw.entries()) {
    if (typeof entry === "number") {
      if (!Number.isInteger(entry) || entry < 1) {
        return { error: `${path}[${i}]: expected a positive call number or a question string` };
      }
      value.push(entry);
    } else if (typeof entry === "string" && entry.trim() !== "") {
      value.push(entry.trim());
    } else {
      return { error: `${path}[${i}]: expected a positive call number or a question string` };
    }
  }
  return { value };
}

/**
 * The content checks that follow a successful parse (MET-160, MET-161). Returns every
 * error, not only the first, so one retry can fix them all:
 * - every brief field is non-empty, and the arrays hold at least one entry;
 * - a part covers at most 3 Done-when items and changes at most 8 files;
 * - a part lists no file in the other area, and no docs-only part joins a multi-part plan;
 * - no frontend part comes before a backend part;
 * - every Done-when number points into the parent's parsed list;
 * - every parent Done-when item is in at least one part. The check is skipped when the
 *   parent has no parsed items: the part body then says "as written", like QA does.
 */
export function checkPlan(parts: readonly PlanPart[], parent: Issue): string[] {
  const errors: string[] = [];
  const total = parent.doneWhen.length;
  const covered = new Set<number>();
  for (const [i, part] of parts.entries()) {
    const path = `parts[${i}]`;
    if (part.goal.trim() === "") errors.push(`${path}.goal: expected a one-sentence goal`);
    if (part.files.length === 0) errors.push(`${path}.files: expected at least one file`);
    if (part.files.length > MAX_PART_FILES) {
      errors.push(
        `${path}.files: expected at most ${MAX_PART_FILES} files, got ${part.files.length}`,
      );
    }
    const areas = part.files.map(fileArea);
    for (const [j, file] of part.files.entries()) {
      if (file.trim() === "") errors.push(`${path}.files[${j}]: expected a repo-relative path`);
      if (part.role === "backend" && areas[j] === "frontend") {
        errors.push(
          `${path}.files[${j}]: a backend part lists the frontend file "${file}"; move it to a frontend part (MET-161)`,
        );
      }
      if (part.role === "frontend" && isFrontendForbidden(file)) {
        errors.push(
          `${path}.files[${j}]: a frontend part lists the backend file "${file}"; move it to a backend part (MET-161)`,
        );
      }
    }
    // Docs changes go in the part whose code they describe, never in a docs part.
    if (parts.length > 1 && part.files.length > 0 && areas.every((area) => area === "docs")) {
      errors.push(
        `${path}.files: a part in a multi-part plan needs code; docs go in the part whose code they describe (MET-161)`,
      );
    }
    if (part.steps.length === 0) errors.push(`${path}.steps: expected at least one step`);
    for (const [j, step] of part.steps.entries()) {
      if (step.trim() === "") errors.push(`${path}.steps[${j}]: expected one action`);
    }
    if (part.verify.length === 0) errors.push(`${path}.verify: expected at least one check`);
    for (const [j, check] of part.verify.entries()) {
      if (check.run.trim() === "" || check.expect.trim() === "") {
        errors.push(`${path}.verify[${j}]: expected run and expect`);
      }
    }
    if (part.outOfScope.trim() === "") {
      errors.push(`${path}.outOfScope: expected what the part leaves out`);
    }
    if (part.doneWhen.length > MAX_PART_DONE_WHEN) {
      errors.push(
        `${path}.doneWhen: expected at most ${MAX_PART_DONE_WHEN} items, got ${part.doneWhen.length}`,
      );
    }
    if (total > 0 && part.doneWhen.length === 0) {
      errors.push(`${path}.doneWhen: expected at least one Done-when number`);
    }
    for (const [j, n] of part.doneWhen.entries()) {
      if (total > 0 && (n < 1 || n > total)) {
        errors.push(`${path}.doneWhen[${j}]: expected a number from 1 to ${total}, got ${n}`);
      }
      covered.add(n);
    }
  }
  // The backend part lands the contract first; the loop does not reorder the parts (MET-161).
  let frontendAt = -1;
  for (const [i, part] of parts.entries()) {
    if (part.role === "frontend" && frontendAt === -1) frontendAt = i;
    if (part.role === "backend" && frontendAt !== -1) {
      errors.push(
        `parts[${i}]: a backend part comes after the frontend part at parts[${frontendAt}]; plan the backend part first (MET-161)`,
      );
    }
  }
  if (total > 0) {
    for (let n = 1; n <= total; n++) {
      if (covered.has(n)) continue;
      const item = parent.doneWhen[n - 1];
      errors.push(`Done when item ${n} is in no part: "${item?.text ?? ""}"`);
    }
  }
  return errors;
}

function doneWhenList(issue: Issue): string {
  if (issue.doneWhen.length === 0) return "(none parsed from the body)";
  return issue.doneWhen.map((d) => `- [${d.checked ? "x" : " "}] ${d.text}`).join("\n");
}

export interface PlanPromptInput {
  issue: Issue;
  context: GrillContext;
  /** The coordinator's resolved instruction text. */
  instructions?: string;
  /** Calls the grill settled; the plan must follow them. */
  calls?: Call[];
  /** The errors that rejected the previous plan; set only on the retry (MET-160). */
  errors?: string[];
}

/** Builds the split prompt for one issue that passed the grill. */
export function buildPlanPrompt({
  issue,
  context,
  instructions,
  calls,
  errors,
}: PlanPromptInput): string {
  const decisions =
    context.decisions.length === 0
      ? "(none)"
      : context.decisions.map((d) => `### ${d.name}\n${d.text}`).join("\n\n");
  const parts = [
    "You are the harnessd coordinator. Split this Linear issue into parts for the Backend and Frontend agents.",
    [
      "Rules:",
      '- A part has role "backend" (daemon, CLI, adapters, integrations, shared types, docs) or "frontend" (the UI in packages/ui/app/).',
      "- Size rule: keep the issue as ONE part only when it is small: one area (backend or UI), about 3 Done-when items or fewer, and about 5 files or fewer. Otherwise split it. Every part is at most size M.",
      "- Area split: backend and UI work go in separate parts. The backend part (shared types, API, daemon) comes first and blocks the frontend part, which builds against the merged contract.",
      '- A part lists the repo paths it changes. A backend part lists no file under "packages/ui/app/". A frontend part lists no file in "packages/daemon/", "packages/shared/" or "packages/cli/". Docs, DESIGN.md and decision records may sit in either part.',
      "- Docs changes go in the part whose code they describe, never in a separate docs part.",
      "- Only plan parts with real work. An issue with no UI work gets no frontend part; one with only UI work gets no backend part.",
      "- Each part is size S (about 30 minutes) or M (about 2 hours). L is not allowed: split larger work into more parts (D-014).",
      '- "reason" must say why the issue stayed one part or why it split, also for a one-part plan. A plan with no reason is invalid.',
      "- Do not plan QA; harnessd adds the QA part itself.",
      '- Each part lists the decision records it depends on in "decisions": [{ "id": "D-NNN", "line": "why it applies" }]. The builder reads only its brief and these records (D-044).',
      '- Each part lists the grill calls that apply to it in "calls": the call numbers below, or their question texts.',
      '- Each part carries its brief: "goal" (one sentence), "doneWhen" (the 1-based numbers of the parent "Done when" items it covers), "files" (the repo-relative paths it changes), "steps" (one action each), "verify" (each command and what its output must show) and "outOfScope". A part covers at most 3 Done-when items and changes at most 8 files.',
      'Never write "Read docs/SPEC.md and docs/decisions/" or tell the agent to read every record.',
      "You may read files in this repo; do not edit anything.",
    ].join("\n"),
    `Reply with strict JSON only, no prose and no code fence, in exactly this shape:\n${PLAN_REPLY_SHAPE}`,
  ];
  if (errors !== undefined && errors.length > 0) {
    parts.push(
      `## Errors in your previous plan\nYour last reply was rejected. Fix every item and reply again with only the JSON object:\n${errors.map((e) => `- ${e}`).join("\n")}`,
    );
  }
  if (instructions?.trim()) parts.push(`## Coordinator instructions\n${instructions.trim()}`);
  parts.push(
    `## Issue ${issue.key}: ${issue.title}\nURL: ${issue.url}\nSize: ${issue.size ?? "unknown"}\n` +
      `Labels: ${issue.labels.join(", ") || "(none)"}\n\n` +
      `### Body\n${issue.description.trim() || "(empty)"}\n\n### Done when\n${doneWhenList(issue)}`,
  );
  if (calls && calls.length > 0) {
    parts.push(
      `## Calls from the grill\n${calls.map((c, i) => `${i + 1}. ${c.question} → ${c.answer}`).join("\n")}`,
    );
  }
  parts.push(
    `## Spec (docs/SPEC.md)\n${context.spec || "(missing)"}`,
    `## Decision records (docs/decisions/)\n${decisions}`,
  );
  return `${parts.join("\n\n")}\n`;
}

export interface PlanDeps {
  /** Runs the coordinator model. Its id must match `agent.harness`. */
  adapter: HarnessAdapter;
  agent: ResolvedAgentConfig;
  context: GrillContext;
  cwd: string;
  calls?: Call[];
  /** Receives one line per dropped decision id (D-044). */
  log?: (line: string) => void;
  /** Wall-clock budget of each planning run. Default 10 minutes. */
  budgetMs?: number;
  /** Turn cap of each planning run. Default `COORDINATOR_MAX_TURNS` (D-045). */
  maxTurns?: number;
}

export const DEFAULT_PLAN_BUDGET_MS = 10 * 60_000;

/** The turn-cap text an adapter reports, or undefined (D-045). */
function turnCapOf(error: string): string | undefined {
  return /turn cap \([^)]*\)/.exec(error)?.[0];
}

function addTokens(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  };
}

/**
 * Asks the coordinator's harness for a split plan. A bad plan (a parse error, a plan-check
 * error or a turn cap) gets one more run in the same planning step, on the same harness,
 * with the errors in its prompt. After a second bad plan the result is `source: "bad"`:
 * the loop moves the parent to Needs input. Both runs count toward the token budget
 * (D-043). A usage limit (D-034) and a failed harness run (D-048) keep their own paths.
 */
export async function planIssue(issue: Issue, deps: PlanDeps): Promise<SplitPlan> {
  if (deps.adapter.id !== deps.agent.harness) {
    // A misconfigured harness is no plan and no retry: the issue stays Ready (D-048).
    return {
      parts: [],
      source: "harness",
      error: `adapter ${deps.adapter.id} does not match the ${deps.agent.name} harness ${deps.agent.harness}`,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
  }
  const calls = deps.calls ?? [];
  const maxTurns = deps.maxTurns ?? COORDINATOR_MAX_TURNS;
  const budgetMs = deps.budgetMs ?? DEFAULT_PLAN_BUDGET_MS;
  let spent: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let turns: number | undefined;
  let errors: string[] = [];
  /** Replies that did and did not report usage; a sum of only unknown replies is unknown. */
  let knownReplies = 0;
  let unknownReplies = 0;
  const usage = () => ({
    tokens: spent,
    ...(turns === undefined ? {} : { turns }),
    ...(unknownReplies > 0 && knownReplies === 0 ? { usageUnknown: true as const } : {}),
  });

  for (let attempt = 1; attempt <= 2; attempt++) {
    const input: PlanPromptInput = {
      issue,
      context: deps.context,
      instructions: deps.agent.instructions,
      calls,
    };
    if (attempt > 1) input.errors = errors;
    const task: Task = {
      id: attempt === 1 ? `plan-${issue.key}` : `plan-${issue.key}-retry`,
      title: `Plan ${issue.key}: ${issue.title}`,
      prompt: buildPlanPrompt(input),
      budgetMs,
      maxTurns,
    };
    if (deps.agent.model !== undefined) task.model = deps.agent.model;

    const reply: RunReply = await runForReply(deps.adapter, task, deps.cwd);
    if (reply.usageUnknown === true) unknownReplies += 1;
    else {
      knownReplies += 1;
      spent = addTokens(spent, reply.tokens);
    }
    if (reply.turns !== undefined) turns = (turns ?? 0) + reply.turns;

    if (!reply.ok && reply.limited) {
      return { parts: [], source: "limited", error: reply.error, ...usage() };
    }
    if (!reply.ok && reply.switchReason !== undefined) {
      // The harness run itself failed (timeout, stall, crash): retry on the next harness (D-048).
      return {
        parts: [],
        source: "harness",
        error: reply.error,
        switchReason: reply.switchReason,
        ...usage(),
      };
    }
    if (!reply.ok) {
      const cap = turnCapOf(reply.error);
      // A cancelled run is no plan at all: the loop sees the pause and retries next tick.
      if (cap === undefined && /cancel/i.test(reply.error)) {
        return { parts: [], source: "harness", error: reply.error, ...usage() };
      }
      // A turn cap and an empty or unusable reply are a bad plan: retry once (D-045, MET-160).
      errors = [cap ?? reply.error];
      continue;
    }

    const parsed = parsePlanReply(reply.text, {
      knownIds: knownDecisionIds(deps.context),
      ...(deps.log === undefined ? {} : { log: deps.log }),
    });
    if (!parsed.ok) {
      errors = [parsed.error];
      continue;
    }
    const problems = checkPlan(parsed.parts, issue);
    if (problems.length === 0) {
      return {
        parts: parsed.parts,
        source: "model",
        reason: parsed.reason,
        ...usage(),
      };
    }
    errors = problems;
  }

  return {
    parts: [],
    source: "bad",
    error: errors.join("; "),
    errors,
    ...usage(),
  };
}
