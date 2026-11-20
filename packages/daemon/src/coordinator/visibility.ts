// Slack #harnessd for one `harnessd run` (D-015, D-021, D-030): the notifier the loop
// uses and the daily summary. The webhook is looked up before each post, so one saved in
// Settings works with no restart. Without one nothing is posted, and `status` says so.
import type { SlackConfig } from "@harnessd/shared";
import type { NoticeIssue, Notifier } from "./notifier.ts";
import { createSlackNotifier, SLACK_WEBHOOK_ENV, type SlackFetch } from "./slack.ts";
import { createDailySummary, createFileSummaryStore, type SummaryStore } from "./summary.ts";

export interface VisibilityOptions {
  /** The webhook url: the secret store's lookup (saved, reference, then the env var). */
  webhookUrl: () => Promise<string | undefined>;
  slack: SlackConfig;
  /** summary.json goes to `<repo>/.harnessd/state/`. */
  repoDir: string;
  /** Work running now, for the summary. */
  inProgress: () => NoticeIssue[];
  log: (line: string) => void;
  fetch?: SlackFetch;
  now?: () => Date;
  /** Default the file store in the repo. */
  store?: SummaryStore;
}

export interface Visibility {
  /** One line for the start of `harnessd run`: where notices go, or the warning. */
  status(): Promise<string>;
  /** Give it to the loop. */
  notifier: Notifier;
  /** Sends the daily summary when one is due. Never throws. */
  checkSummary(): Promise<void>;
  /** Waits for queued Slack posts, at most `ms`. */
  flush(ms: number): Promise<void>;
}

export function createVisibility(options: VisibilityOptions): Visibility {
  const { slack, log } = options;
  /** The url when it can be used; else why not, for the start line. Never the value. */
  async function webhook(): Promise<{ url: string } | { why: string }> {
    let url: string | undefined;
    try {
      url = (await options.webhookUrl())?.trim();
    } catch (error) {
      return { why: `the webhook could not be read (${(error as Error).message})` };
    }
    if (!url) return { why: `no webhook is saved and ${SLACK_WEBHOOK_ENV} is not set` };
    if (!url.startsWith("https://")) return { why: "the webhook is not an https url" };
    return { url };
  }

  const poster = createSlackNotifier({
    webhookUrl: options.webhookUrl,
    log,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const summary = createDailySummary({
    store: options.store ?? createFileSummaryStore(options.repoDir),
    now: options.now ?? (() => new Date()),
    timeZone: slack.time_zone,
    time: slack.summary_time,
    post: (text) => poster.post(text),
    inProgress: options.inProgress,
    log,
  });
  return {
    async status() {
      const w = await webhook();
      return "url" in w
        ? `slack: posting notices to ${slack.channel}, daily summary at ${slack.summary_time} ${slack.time_zone}`
        : `slack: ${w.why}, so harnessd posts no Slack notices or daily summary (docs/INSTALL.md)`;
    },
    notifier: summary.wrap(poster),
    async checkSummary() {
      try {
        // No webhook yet: the summary waits, and goes out once a webhook is saved.
        if (!("url" in (await webhook()))) return;
        await summary.check();
      } catch (error) {
        log(`summary: check failed: ${(error as Error).message}`);
      }
    },
    async flush(ms) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const limit = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
        timer.unref();
      });
      await Promise.race([poster.flush(), limit]);
      clearTimeout(timer);
    },
  };
}
