// Slack #harnessd for one `harnessd run` (D-015, D-021): the notifier the loop uses and
// the daily summary. Without HARNESSD_SLACK_WEBHOOK_URL it is NullNotifier, and `status`
// is the one warning to log.
import type { SlackConfig } from "@harnessd/shared";
import { type NoticeIssue, type Notifier, NullNotifier } from "./notifier.ts";
import { createSlackNotifier, SLACK_WEBHOOK_ENV, type SlackFetch } from "./slack.ts";
import { createDailySummary, createFileSummaryStore, type SummaryStore } from "./summary.ts";

export interface VisibilityOptions {
  env: NodeJS.ProcessEnv;
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
  enabled: boolean;
  /** One line for the start of `harnessd run`: where notices go, or the warning. */
  status: string;
  /** Give it to the loop. */
  notifier: Notifier;
  /** Sends the daily summary when one is due. Never throws. */
  checkSummary(): Promise<void>;
  /** Waits for queued Slack posts, at most `ms`. */
  flush(ms: number): Promise<void>;
}

export function createVisibility(options: VisibilityOptions): Visibility {
  const { slack, log } = options;
  const url = options.env[SLACK_WEBHOOK_ENV]?.trim();
  const off = (why: string): Visibility => ({
    enabled: false,
    status: `slack: ${SLACK_WEBHOOK_ENV} ${why}, so harnessd posts no Slack notices or daily summary (docs/INSTALL.md)`,
    notifier: new NullNotifier(),
    checkSummary: async () => {},
    flush: async () => {},
  });
  if (!url) return off("is not set");
  if (!url.startsWith("https://")) return off("is not an https url");

  const poster = createSlackNotifier({
    webhookUrl: url,
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
    enabled: true,
    status: `slack: posting notices to ${slack.channel}, daily summary at ${slack.summary_time} ${slack.time_zone}`,
    notifier: summary.wrap(poster),
    async checkSummary() {
      try {
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
