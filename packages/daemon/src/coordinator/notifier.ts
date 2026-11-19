/** Sends one human-facing line, e.g. to Slack #harnessd. The Slack notifier ships in MET-16. */
export interface Notifier {
  notify(text: string): Promise<void>;
}

/** Drops every message. Used until a real notifier is configured. */
export class NullNotifier implements Notifier {
  async notify(_text: string): Promise<void> {}
}
