// The merge gate (SPEC "Autonomy loop" step 6, D-013, D-014). See docs/LOOP.md "Merge".
//
// A QA approval is recorded in loop.json with each PR's head as QA saw it. Every tick,
// each recorded PR is read again with one `gh pr view`:
// - the head moved: QA runs again on the new head, nothing merges unreviewed;
// - a protected path is touched: the PR gets `merge.label`, the parent goes to Needs input,
//   and one ping goes out, ever, per PR;
// - CI failed or the PR conflicts: the part is sent back once, then escalated (D-014);
// - CI is pending: try again next tick;
// - CI is green: `gh pr merge --squash --match-head-commit <approved sha>`, part to Done.
// Once every part is merged, the QA sub-issue and the parent move to Done.
import type { Issue, LinkedIssue, MergeConfig } from "@harnessd/shared";
import type { GitHub, PullRequestCheck, PullRequestStatus } from "../github/client.ts";
import type { LinearClient } from "../linear/client.ts";
import type { Notice, NoticeIssue, NoticePr, Notifier } from "./notifier.ts";
import type { PrReview } from "./qa.ts";
import { isCanceledState, isWorkPart } from "./split.ts";
import type { LoopState, MergePr, PendingMerge } from "./state.ts";

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function short(sha: string): string {
  return sha.slice(0, 7);
}

function times(n: number): string {
  return n === 1 ? "once" : n === 2 ? "twice" : `${n} times`;
}

// --- protected paths ----------------------------------------------------------

/**
 * A `protected_paths` glob as a RegExp over repo paths, case-insensitive. `**` spans
 * directories, `*` and `?` stay within one, `{a,b}` is either. A glob without a `/`
 * matches the file name at any depth, as in .gitignore.
 */
export function globToRegExp(glob: string): RegExp {
  let g = glob.trim().replace(/^\.\//, "").replace(/^\/+/, "");
  if (!g.includes("/")) g = `**/${g}`;
  let out = "";
  let inBraces = false;
  for (let i = 0; i < g.length; i++) {
    const c = g[i] as string;
    if (c === "*" && g[i + 1] === "*") {
      const atStart = i === 0 || g[i - 1] === "/";
      if (atStart && g[i + 2] === "/") {
        out += "(?:.*/)?";
        i += 2;
      } else {
        out += ".*";
        i += 1;
      }
    } else if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else if (c === "{" && !inBraces) {
      inBraces = true;
      out += "(?:";
    } else if (c === "}" && inBraces) {
      inBraces = false;
      out += ")";
    } else if (c === "," && inBraces) out += "|";
    else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  if (inBraces) out += ")";
  return new RegExp(`^${out}$`, "i");
}

/** The paths that match any glob. */
export function protectedFiles(paths: string[], globs: string[]): string[] {
  const res = globs.filter((g) => g.trim() !== "").map(globToRegExp);
  return paths.filter((p) => res.some((re) => re.test(p.replace(/^\/+/, ""))));
}

// --- CI -------------------------------------------------------------------------

export interface CiVerdict {
  /** Green only when there is at least one check and every check passed (D-013). */
  state: "pass" | "pending" | "fail";
  failing: PullRequestCheck[];
  pending: PullRequestCheck[];
}

/** No checks at all is pending, not green: D-013 needs CI green. */
export function ciVerdict(checks: PullRequestCheck[]): CiVerdict {
  const failing = checks.filter((c) => c.state === "fail");
  const pending = checks.filter((c) => c.state === "pending");
  const state =
    failing.length > 0 ? "fail" : pending.length > 0 || checks.length === 0 ? "pending" : "pass";
  return { state, failing, pending };
}

function describeCheck(c: PullRequestCheck): string {
  return `CI: \`${c.name}\` ${c.detail.toLowerCase()}${c.url ? ` (${c.url})` : ""}`;
}

// --- recording an approval ----------------------------------------------------------

/** The merge record of an approved QA round: each approved PR pinned to the head QA saw. */
export function pendingMerge(
  qa: LinkedIssue,
  parent: Issue,
  reviews: PrReview[],
  now: Date,
): PendingMerge {
  const prs: MergePr[] = [];
  for (const r of reviews) {
    if (r.decision !== "approve" || r.pr === undefined) continue;
    prs.push({
      partId: r.part.id,
      partKey: r.part.key,
      number: r.pr.number,
      url: r.pr.url,
      sha: r.pr.headRefOid,
    });
  }
  return {
    qaId: qa.id,
    qaKey: qa.key,
    parentId: parent.id,
    parentKey: parent.key,
    parentUrl: parent.url,
    approvedAt: now.toISOString(),
    prs,
  };
}

// --- one pass -------------------------------------------------------------------------

/** The Linear calls the gate makes. A LinearClient satisfies it. */
export type MergeLinear = Pick<LinearClient, "comment" | "moveTo" | "listChildren">;

export interface MergeDeps {
  github: Pick<GitHub, "prStatus" | "mergePr" | "addLabel">;
  linear: MergeLinear;
  notifier: Notifier;
  config: MergeConfig;
  /** `limits.qa_max_failures`: gate failures per parent before the human is asked (D-014). */
  maxFailures: number;
  /** The pause flag, re-read before each PR and right before each merge (MET-15). */
  paused: () => boolean | Promise<boolean>;
  /** Persists the state; called before anything irreversible is reported. */
  save: () => Promise<void>;
  now?: () => Date;
  log?: (line: string) => void;
}

export interface MergeReport {
  /** Part keys merged by harnessd this pass. */
  merged: string[];
  /** Part keys whose PR started waiting for a human this pass. */
  needsHuman: string[];
  /** Part keys sent back for failed CI or a conflict. */
  sentBack: string[];
  /** Parent keys moved to Done. */
  done: string[];
  /** The parent of each PR merged this pass, by harnessd or a human, once per parent. */
  landed: Array<{ id: string; key: string; url: string }>;
  /** True when a pause stopped the pass. */
  paused: boolean;
}

type GateState = Pick<
  LoopState,
  "merges" | "gateFailures" | "humanPings" | "qaFeedback" | "sessions"
>;

/** A PR the gate sends back to its part, with one line per reason. */
interface GateFailure {
  pr: MergePr;
  failing: string[];
}

/** The issue a merge notice links: the parent the owner follows. */
function parentIssue(entry: PendingMerge): NoticeIssue {
  return { key: entry.parentKey, url: entry.parentUrl };
}

function noticePr(pr: { number: number; url: string }): NoticePr {
  return { number: pr.number, url: pr.url };
}

/**
 * Advances every recorded QA approval by one step (see the file comment). Never throws:
 * a `gh` or Linear error is logged and the PR is looked at again next tick.
 */
export async function advanceMerges(state: GateState, deps: MergeDeps): Promise<MergeReport> {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => {});
  const report: MergeReport = {
    merged: [],
    needsHuman: [],
    sentBack: [],
    done: [],
    landed: [],
    paused: false,
  };
  const safely = async (what: string, fn: () => Promise<unknown>): Promise<boolean> => {
    try {
      await fn();
      return true;
    } catch (error) {
      log(`could not ${what}: ${message(error)}`);
      return false;
    }
  };
  const paused = async (): Promise<boolean> => {
    try {
      if (await deps.paused()) report.paused = true;
    } catch (error) {
      // An unreadable flag never lets a merge through.
      log(`could not read the pause flag, not merging: ${message(error)}`);
      report.paused = true;
    }
    return report.paused;
  };
  const drop = (entry: PendingMerge): void => {
    state.merges = state.merges.filter((m) => m !== entry);
  };

  /** One ping per PR, ever: recorded and saved before it is sent. */
  async function noticeOnce(pr: MergePr, notice: Notice): Promise<void> {
    if (state.humanPings[pr.url] !== undefined) return;
    state.humanPings[pr.url] = now().toISOString();
    await deps.save();
    await safely("send the notice", () => deps.notifier.notify(notice));
  }

  async function label(pr: MergePr): Promise<void> {
    if (pr.labeled === true) return;
    if (
      await safely(`label PR #${pr.number}`, () =>
        deps.github.addLabel(pr.number, deps.config.label),
      )
    ) {
      pr.labeled = true;
      await deps.save();
    }
  }

  /** The PR waits for a human: the label, one comment, the parent to Needs input, one ping. */
  async function needsHuman(
    entry: PendingMerge,
    pr: MergePr,
    reason: string,
    details: string[],
  ): Promise<void> {
    pr.needsHuman = reason;
    await deps.save();
    report.needsHuman.push(pr.partKey);
    log(`${pr.partKey}: PR #${pr.number} needs a human (${reason})`);
    const closed = pr.closedAt !== undefined;
    if (!closed) await label(pr);
    const next = closed
      ? `harnessd leaves ${entry.parentKey} to a human.`
      : `It is labelled \`${deps.config.label}\` and harnessd will not merge it. ` +
        `Once a human merges it, ${pr.partKey} moves to Done.`;
    const body = [
      `**harnessd merge**: [PR #${pr.number}](${pr.url}) of ${pr.partKey} needs a human (D-013): ${reason}. ${next}`,
      ...(details.length > 0 ? ["", ...details.map((d) => `- ${d}`)] : []),
    ].join("\n");
    await safely(`comment on ${entry.parentKey}`, () =>
      deps.linear.comment(entry.parentId, `${body}\n`),
    );
    await safely(`move ${entry.parentKey} to Needs input`, () =>
      deps.linear.moveTo(entry.parentId, "Needs input"),
    );
    await noticeOnce(pr, {
      kind: "needs_human",
      issue: parentIssue(entry),
      part: pr.partKey,
      prs: [noticePr(pr)],
      reason,
    });
  }

  async function merged(
    entry: PendingMerge,
    pr: MergePr,
    by: "harnessd" | "a human",
  ): Promise<void> {
    pr.mergedAt = now().toISOString();
    await deps.save();
    if (by === "harnessd") report.merged.push(pr.partKey);
    if (!report.landed.some((p) => p.id === entry.parentId)) {
      report.landed.push({ id: entry.parentId, key: entry.parentKey, url: entry.parentUrl });
    }
    log(`${pr.partKey}: PR #${pr.number} merged by ${by}, Done`);
    const how =
      by === "harnessd"
        ? `${deps.config.method} merged at \`${short(pr.sha)}\``
        : "merged by a human";
    await safely(`comment on ${pr.partKey}`, () =>
      deps.linear.comment(pr.partId, `**harnessd merge**: [PR #${pr.number}](${pr.url}) ${how}.\n`),
    );
    await safely(`move ${pr.partKey} to Done`, () => deps.linear.moveTo(pr.partId, "Done"));
    // The part is done: its session is no longer needed for a send-back (MET-156).
    if (state.sessions !== undefined) delete state.sessions[pr.partId];
    // D-015: one line per merge.
    await safely("send the merge line", () =>
      deps.notifier.notify({
        kind: "merged",
        issue: parentIssue(entry),
        part: pr.partKey,
        prs: [noticePr(pr)],
      }),
    );
  }

  /** QA approved another commit: QA runs again on the new head. No failure is counted. */
  async function headMoved(entry: PendingMerge, pr: MergePr, head: string): Promise<void> {
    log(`${pr.partKey}: PR #${pr.number} moved from ${short(pr.sha)} to ${short(head)}, QA again`);
    await safely(`comment on ${entry.qaKey}`, () =>
      deps.linear.comment(
        entry.qaId,
        `**harnessd merge**: [PR #${pr.number}](${pr.url}) of ${pr.partKey} moved from \`${short(pr.sha)}\` to \`${short(head)}\` after QA approved it. ` +
          `Nothing merges unreviewed, so ${entry.qaKey} runs again on the new head.\n`,
      ),
    );
    if (await safely(`re-queue ${entry.qaKey}`, () => deps.linear.moveTo(entry.qaId, "Ready"))) {
      drop(entry);
    }
  }

  /** Failed CI or a conflict: the part goes back once, then the human is asked (D-014). */
  async function sendBack(entry: PendingMerge, failures: GateFailure[]): Promise<void> {
    const count = (state.gateFailures[entry.parentId] ?? 0) + 1;
    const lines = failures.flatMap(({ pr, failing }) => [
      `- ${pr.partKey} [PR #${pr.number}](${pr.url}):`,
      ...failing.map((f) => `  - ${f}`),
    ]);
    drop(entry);
    if (count >= deps.maxFailures) {
      delete state.gateFailures[entry.parentId];
      for (const { pr } of failures) {
        delete state.qaFeedback[pr.partId];
        if (state.sessions !== undefined) delete state.sessions[pr.partId];
      }
      await deps.save();
      const body = [
        `**harnessd merge**: the merge gate failed ${times(count)} for ${entry.parentKey}, so this needs a human (D-014). ` +
          `${entry.qaKey} and ${entry.parentKey} are in Needs input, and nothing is sent back again.`,
        "",
        ...lines,
      ].join("\n");
      await safely(`comment on ${entry.parentKey}`, () =>
        deps.linear.comment(entry.parentId, `${body}\n`),
      );
      await safely(`move ${entry.qaKey} to Needs input`, () =>
        deps.linear.moveTo(entry.qaId, "Needs input"),
      );
      await safely(`move ${entry.parentKey} to Needs input`, () =>
        deps.linear.moveTo(entry.parentId, "Needs input"),
      );
      await safely("send the notice", () =>
        deps.notifier.notify({
          kind: "needs_input",
          issue: parentIssue(entry),
          prs: failures.map(({ pr }) => noticePr(pr)),
          reason: `merge gate failed ${times(count)}`,
        }),
      );
      log(`${entry.parentKey}: merge gate failed ${times(count)}, Needs input`);
      return;
    }
    state.gateFailures[entry.parentId] = count;
    for (const { pr, failing } of failures) {
      state.qaFeedback[pr.partId] = { prUrl: pr.url, failing };
      report.sentBack.push(pr.partKey);
    }
    await deps.save();
    for (const { pr, failing } of failures) {
      const body = [
        `**harnessd merge**: [PR #${pr.number}](${pr.url}) cannot merge (round ${count} of ${deps.maxFailures}, D-014). ` +
          "Back to Ready so its agent fixes the PR; QA then checks it again.",
        "",
        ...failing.map((f) => `- ${f}`),
      ].join("\n");
      await safely(`comment on ${pr.partKey}`, () => deps.linear.comment(pr.partId, `${body}\n`));
      await safely(`re-queue ${pr.partKey}`, () => deps.linear.moveTo(pr.partId, "Ready"));
      log(`${pr.partKey}: PR #${pr.number} cannot merge, sent back`);
    }
    await safely(`comment on ${entry.qaKey}`, () =>
      deps.linear.comment(
        entry.qaId,
        `**harnessd merge**: round ${count} of ${deps.maxFailures} did not pass the merge gate. ` +
          `${entry.qaKey} runs again once every part is back in review.\n\n${lines.join("\n")}\n`,
      ),
    );
    await safely(`re-queue ${entry.qaKey}`, () => deps.linear.moveTo(entry.qaId, "Ready"));
  }

  /** Every PR merged: QA to Done, and the parent once every part of it is Done. */
  async function finish(entry: PendingMerge): Promise<void> {
    let parts: LinkedIssue[];
    try {
      parts = (await deps.linear.listChildren(entry.parentId)).filter(isWorkPart);
    } catch (error) {
      log(`${entry.parentKey}: could not read the parts, retrying next tick: ${message(error)}`);
      return;
    }
    const merged = new Set(entry.prs.map((p) => p.partId));
    // A canceled part never gets a PR, so it must not hold the parent and QA open (MET-154).
    const open = parts.filter(
      (p) => p.state.toLowerCase() !== "done" && !isCanceledState(p.state) && !merged.has(p.id),
    );
    drop(entry);
    if (open.length > 0) {
      // Per-part QA: the QA sub-issue stays until the last part of the parent is merged.
      log(`${entry.parentKey}: merged, but ${open.map((p) => p.key).join(", ")} not Done yet`);
      await deps.save();
      return;
    }
    delete state.gateFailures[entry.parentId];
    await deps.save();
    await safely(`move ${entry.qaKey} to Done`, () => deps.linear.moveTo(entry.qaId, "Done"));
    const prs = entry.prs.map((p) => `[PR #${p.number}](${p.url})`).join(", ");
    await safely(`comment on ${entry.parentKey}`, () =>
      deps.linear.comment(
        entry.parentId,
        `**harnessd merge**: every part is merged${prs ? ` (${prs})` : ""}. ${entry.parentKey} is Done.\n`,
      ),
    );
    await safely(`move ${entry.parentKey} to Done`, () =>
      deps.linear.moveTo(entry.parentId, "Done"),
    );
    report.done.push(entry.parentKey);
    log(`${entry.parentKey}: every part merged, Done`);
  }

  /** One recorded approval. Returns false when a pause stopped it. */
  async function advance(entry: PendingMerge): Promise<boolean> {
    const failures: GateFailure[] = [];
    for (const pr of entry.prs) {
      if (pr.mergedAt !== undefined || pr.closedAt !== undefined) continue;
      if (await paused()) return false;
      let status: PullRequestStatus;
      try {
        status = await deps.github.prStatus(pr.number);
      } catch (error) {
        log(
          `${pr.partKey}: could not read PR #${pr.number}, retrying next tick: ${message(error)}`,
        );
        continue;
      }
      if (status.state === "MERGED") {
        await merged(entry, pr, "a human");
        continue;
      }
      if (status.state === "CLOSED") {
        pr.closedAt = now().toISOString();
        await needsHuman(entry, pr, "closed without merging", []);
        continue;
      }
      if (status.headRefOid !== pr.sha) {
        await headMoved(entry, pr, status.headRefOid);
        return true;
      }
      if (pr.needsHuman !== undefined) {
        await label(pr);
        continue;
      }
      const touched = protectedFiles(
        status.files.map((f) => f.path),
        deps.config.protected_paths,
      );
      if (touched.length > 0) {
        const shown = touched.slice(0, 20).map((p) => `\`${p}\``);
        if (touched.length > 20) shown.push(`… ${touched.length - 20} more`);
        await needsHuman(entry, pr, "touches protected paths", shown);
        continue;
      }
      if (status.files.length < status.changedFiles) {
        await needsHuman(
          entry,
          pr,
          `GitHub listed ${status.files.length} of ${status.changedFiles} changed files, so the protected paths could not be checked`,
          [],
        );
        continue;
      }
      const ci = ciVerdict(status.checks);
      const failing = ci.failing.map(describeCheck);
      if (status.mergeable === "CONFLICTING") {
        failing.push(
          "The PR conflicts with its base branch: merge or rebase the base into the branch and push.",
        );
      }
      if (failing.length > 0) {
        failures.push({ pr, failing });
        continue;
      }
      if (ci.state === "pending" || status.mergeable !== "MERGEABLE") {
        const why =
          ci.state !== "pending"
            ? "GitHub is still checking mergeability"
            : ci.pending.length > 0
              ? `${ci.pending.map((c) => c.name).join(", ")} pending`
              : "no checks yet";
        log(`${pr.partKey}: PR #${pr.number} waits (${why})`);
        continue;
      }
      if (await paused()) return false;
      try {
        await deps.github.mergePr(pr.number, {
          method: deps.config.method,
          matchHeadCommit: pr.sha,
        });
      } catch (error) {
        await needsHuman(entry, pr, "GitHub refused the merge", [oneLine(message(error))]);
        continue;
      }
      await merged(entry, pr, "harnessd");
    }
    if (failures.length > 0) {
      await sendBack(entry, failures);
      return true;
    }
    if (entry.prs.every((p) => p.mergedAt !== undefined)) await finish(entry);
    else if (entry.prs.every((p) => p.mergedAt !== undefined || p.closedAt !== undefined)) {
      // A human closed a PR: the parent is theirs now (it is in Needs input).
      drop(entry);
      await deps.save();
    }
    return true;
  }

  for (const entry of [...state.merges]) {
    if (!(await advance(entry))) break;
  }
  return report;
}
