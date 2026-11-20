// The Slack notifier (D-015, D-021): an incoming webhook over plain HTTPS, no SDK.
//
// `notify` and `post` only queue a message and return, so the loop never waits on Slack.
// One message is sent at a time. A 5xx, a 429 or a network error is retried with
// backoff, at most `retries` times; anything else, or the last failure, drops the
// message with one log line. The webhook url is a secret: it never reaches a log.
import { type Notice, type Notifier, slackNoticeText } from "./notifier.ts";

/** Read at the edge only; never written to disk or logs (D-021). */
export const SLACK_WEBHOOK_ENV = "HARNESSD_SLACK_WEBHOOK_URL";

/** The part of `fetch` the notifier uses. */
export type SlackFetch = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number }>;

export interface SlackNotifierOptions {
  /**
   * The webhook, or a lookup run before each message (MET-33), so a webhook saved in
   * Settings is used with no restart. No url, or one that is not https, drops the message.
   */
  webhookUrl: string | (() => Promise<string | undefined>);
  /** Default globalThis.fetch. */
  fetch?: SlackFetch;
  /** Default setTimeout, unref'd. */
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  /** Retries after the first try. Default 3. */
  retries?: number;
  /** The first backoff; each retry doubles it. Default 1000 ms. */
  backoffMs?: number;
  /** Per request. Default 10 000 ms. */
  timeoutMs?: number;
  /** Messages waiting while Slack is slow or down. The oldest is dropped. Default 100. */
  maxQueue?: number;
}

export interface SlackNotifier extends Notifier {
  /** Queues one mrkdwn message, e.g. the daily summary. */
  post(text: string): void;
  /** Resolves once every queued message is sent or dropped. */
  flush(): Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms).unref());

export function createSlackNotifier(options: SlackNotifierOptions): SlackNotifier {
  const lookup = options.webhookUrl;
  const webhook = typeof lookup === "string" ? async () => lookup : lookup;
  const send: SlackFetch = options.fetch ?? ((u, init) => globalThis.fetch(u, init));
  const sleep = options.sleep ?? defaultSleep;
  const log = options.log ?? (() => {});
  const retries = options.retries ?? 3;
  const backoffMs = options.backoffMs ?? 1000;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxQueue = options.maxQueue ?? 100;

  const queue: string[] = [];
  let draining: Promise<void> | undefined;

  /** One try: undefined when posted, else why it failed and whether a retry may help. */
  async function tryPost(
    url: string,
    text: string,
  ): Promise<{ why: string; retry: boolean } | undefined> {
    /** Error text without the webhook url. */
    const scrub = (detail: string): string => detail.split(url).join("<webhook>");
    try {
      const res = await send(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, unfurl_links: false }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) return undefined;
      return { why: `HTTP ${res.status}`, retry: res.status === 429 || res.status >= 500 };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { why: scrub(detail), retry: true };
    }
  }

  async function deliver(text: string): Promise<void> {
    let url: string | undefined;
    try {
      url = (await webhook())?.trim();
    } catch (error) {
      // A lookup error names the source, never a value (SecretError).
      log(`slack: dropped a message, the webhook could not be read (${(error as Error).message})`);
      return;
    }
    if (!url?.startsWith("https://")) return;
    for (let attempt = 0; ; attempt++) {
      const failure = await tryPost(url, text);
      if (failure === undefined) return;
      if (!failure.retry || attempt >= retries) {
        log(
          `slack: dropped a message after ${attempt === 0 ? "1 try" : `${attempt + 1} tries`} (${failure.why})`,
        );
        return;
      }
      const wait = backoffMs * 2 ** attempt;
      log(
        `slack: could not post (${failure.why}), retry ${attempt + 1} of ${retries} in ${wait / 1000}s`,
      );
      await sleep(wait);
    }
  }

  async function drain(): Promise<void> {
    for (let text = queue.shift(); text !== undefined; text = queue.shift()) {
      await deliver(text);
    }
    draining = undefined;
  }

  function post(text: string): void {
    if (queue.length >= maxQueue) {
      queue.shift();
      log("slack: queue full, dropped the oldest message");
    }
    queue.push(text);
    draining ??= drain();
  }

  return {
    async notify(notice: Notice) {
      post(slackNoticeText(notice));
    },
    post,
    async flush() {
      while (draining !== undefined) await draining;
    },
  };
}
