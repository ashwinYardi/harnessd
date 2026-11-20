// Notices: one line to the owner per merge or block (D-015, D-020). See GLOSSARY.md.

/** A Linear issue a notice links. */
export interface NoticeIssue {
  key: string;
  url?: string;
}

export interface NoticePr {
  number: number;
  url: string;
}

/**
 * One event for the owner. `issue` is the issue the owner follows (the parent for a
 * part); `part` is the sub-issue the event is about, when it differs.
 */
export interface Notice {
  kind: "merged" | "needs_input" | "needs_human";
  issue: NoticeIssue;
  part?: string;
  prs: NoticePr[];
  /** Why it blocks: a D-011 trigger, "QA failed 2 times". Not set for a merge. */
  reason?: string;
  /** One line of detail, e.g. the question for the human. */
  detail?: string;
}

/** Sends notices, e.g. to Slack #harnessd. It must never throw into the loop or wait on the network. */
export interface Notifier {
  notify(notice: Notice): Promise<void>;
}

/** Drops every notice. Used when no Slack webhook is configured. */
export class NullNotifier implements Notifier {
  async notify(_notice: Notice): Promise<void> {}
}

const VERBS: Record<Notice["kind"], string> = {
  merged: "merged",
  needs_input: "needs input",
  needs_human: "needs a human",
};

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

interface Style {
  text(s: string): string;
  link(url: string, label: string): string;
  /** The issue as the subject of the line. */
  subject(issue: NoticeIssue): string;
  /** The issue at the end of the line: after a part, or as the bare url in plain text. */
  tail(issue: NoticeIssue, afterPart: boolean): string | undefined;
}

function render(n: Notice, style: Style): string {
  const subject = n.part !== undefined ? style.text(n.part) : style.subject(n.issue);
  const reason = n.reason ? ` (${style.text(oneLine(n.reason))})` : "";
  const parts: string[] = [];
  if (n.detail) parts.push(style.text(oneLine(n.detail)));
  for (const pr of n.prs) parts.push(style.link(pr.url, `PR #${pr.number}`));
  const tail = style.tail(n.issue, n.part !== undefined);
  if (tail !== undefined) parts.push(tail);
  return `${subject} ${VERBS[n.kind]}${reason}${parts.length > 0 ? `: ${parts.join(" ")}` : ""}`;
}

const PLAIN: Style = {
  text: (s) => s,
  link: (url, label) => `${label} ${url}`,
  subject: (i) => i.key,
  tail: (i, afterPart) =>
    afterPart ? `(${i.url === undefined ? i.key : `${i.key} ${i.url}`})` : i.url,
};

/** Escapes Slack mrkdwn control characters. */
export function slackEscape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** A Slack mrkdwn link. */
export function slackLink(url: string, label: string): string {
  return `<${url.replace(/[<>|\s]/g, "")}|${slackEscape(label)}>`;
}

/** The issue key as a Slack link, or the bare key without a url. */
export function slackIssue(i: NoticeIssue): string {
  return i.url === undefined ? slackEscape(i.key) : slackLink(i.url, i.key);
}

const SLACK: Style = {
  text: slackEscape,
  link: slackLink,
  subject: slackIssue,
  tail: (i, afterPart) => (afterPart ? `(${slackIssue(i)})` : undefined),
};

/** The notice as one plain line with bare urls, for logs. */
export function formatNotice(notice: Notice): string {
  return render(notice, PLAIN);
}

/** The notice as one Slack mrkdwn line: the issue and each PR are links. */
export function slackNoticeText(notice: Notice): string {
  return render(notice, SLACK);
}
