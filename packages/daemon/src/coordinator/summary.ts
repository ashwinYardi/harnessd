// The daily summary (D-015, D-021): one Slack message a day at `slack.summary_time` in
// `slack.time_zone`. It lists the merges and blocks noticed since the last summary, the
// time each harness was held by a usage limit, and the work in progress now. State lives
// in `<repo>/.harnessd/state/summary.json`, so a summary missed while the daemon was off
// goes out once at the next start.
import { readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { type HarnessId, harnessName, isHarnessId } from "@harnessd/shared";
import { writeJsonAtomic } from "../control/files.ts";
import type { HoldEvent } from "./limits.ts";
import {
  type Notice,
  type NoticeIssue,
  type Notifier,
  slackEscape,
  slackIssue,
  slackNoticeText,
} from "./notifier.ts";

export interface SummaryState {
  version: 1;
  /** When the last summary went out, or when counting started. Unset before the first start. */
  lastSentAt?: string;
  /** Notices since `lastSentAt`. */
  notices: { at: string; notice: Notice }[];
  /**
   * Harness holds that started or ended since `lastSentAt` (MET-82). A hold still open
   * at a summary is carried over as a start at the summary time.
   */
  holdEvents?: HoldEvent[];
}

export interface SummaryStore {
  load(): Promise<SummaryState>;
  save(state: SummaryState): Promise<void>;
}

export interface DailySummaryOptions {
  store: SummaryStore;
  now: () => Date;
  /** An IANA time zone, e.g. "Asia/Kolkata". */
  timeZone: string;
  /** "HH:MM", 24-hour. */
  time: string;
  /** Sends the summary text (Slack mrkdwn). Must not throw or wait on the network. */
  post: (text: string) => void;
  /** Work running now. */
  inProgress: () => NoticeIssue[];
  log?: (line: string) => void;
}

export interface DailySummary {
  /** A notifier that records each notice for the summary, then hands it to `inner`. */
  wrap(inner: Notifier): Notifier;
  /** Sends the summary when a summary time has passed since the last one. True if sent. */
  check(): Promise<boolean>;
  /** Records a hold's start or end, for the limited time. Never throws. */
  hold(event: HoldEvent): Promise<void>;
}

function zonedParts(date: Date, timeZone: string): Record<string, number> {
  const out: Record<string, number> = {};
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  });
  for (const p of format.formatToParts(date)) {
    if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  return out;
}

/** The zone's offset from UTC at `ms`, in ms. */
function offsetAt(ms: number, timeZone: string): number {
  const p = zonedParts(new Date(ms), timeZone);
  const local = Date.UTC(p.year ?? 0, (p.month ?? 1) - 1, p.day, p.hour, p.minute, p.second);
  return local - Math.floor(ms / 1000) * 1000;
}

/** The instant of a local wall-clock time in the zone. */
function zonedTime(y: number, m: number, d: number, hh: number, mm: number, tz: string): number {
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  const guess = wall - offsetAt(wall, tz);
  return wall - offsetAt(guess, tz);
}

/** The latest summary time at or before `now`. */
export function lastSummarySlot(now: Date, timeZone: string, time: string): Date {
  const [hh = 0, mm = 0] = time.split(":").map(Number);
  const p = zonedParts(now, timeZone);
  const y = p.year ?? 0;
  const m = p.month ?? 1;
  const d = p.day ?? 1;
  const today = zonedTime(y, m, d, hh, mm, timeZone);
  if (today <= now.getTime()) return new Date(today);
  // Yesterday: Date.UTC rolls day 0 back into the previous month.
  return new Date(zonedTime(y, m, d - 1, hh, mm, timeZone));
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function localLabel(iso: string, timeZone: string): string {
  const p = zonedParts(new Date(iso), timeZone);
  const pad = (n: number | undefined) => String(n ?? 0).padStart(2, "0");
  return `${p.day} ${MONTHS[(p.month ?? 1) - 1]} ${pad(p.hour)}:${pad(p.minute)}`;
}

/**
 * Time held per harness between `since` and `until`, in ms, and the harnesses still held
 * at `until`. Events are taken in the order they were recorded, not by time: an end that
 * comes after a carried-over start closes it, even when the hold expired a little earlier.
 */
export function limitedTime(
  events: readonly HoldEvent[],
  since: string,
  until: string,
): { held: Map<HarnessId, number>; open: HarnessId[] } {
  const from = Date.parse(since);
  const to = Date.parse(until);
  const open = new Map<HarnessId, number>();
  const held = new Map<HarnessId, number>();
  const add = (h: HarnessId, start: number, end: number) =>
    held.set(h, (held.get(h) ?? 0) + Math.max(0, Math.min(end, to) - Math.max(start, from)));
  for (const e of events) {
    const at = Date.parse(e.at);
    if (e.kind === "start") {
      if (!open.has(e.harness)) open.set(e.harness, at);
      continue;
    }
    // An end with no start here: count from the hold's own start. add() clips it to `since`.
    const start = open.get(e.harness) ?? (e.since === undefined ? from : Date.parse(e.since));
    add(e.harness, Number.isNaN(start) ? from : start, at);
    open.delete(e.harness);
  }
  for (const [h, start] of open) add(h, start, to);
  for (const [h, ms] of held) if (ms <= 0) held.delete(h);
  return { held, open: [...open.keys()].sort() };
}

/** "2h 10m", "45m" or "3h". A hold under a minute shows as "1m". */
export function formatDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/** The summary as Slack mrkdwn. */
export function formatSummary(
  since: string | undefined,
  timeZone: string,
  notices: Notice[],
  inProgress: NoticeIssue[],
  limited: ReadonlyMap<HarnessId, number> = new Map(),
): string {
  const head = `*harnessd daily summary*${since ? ` since ${localLabel(since, timeZone)}` : ""} (${slackEscape(timeZone)})`;
  const section = (title: string, items: Notice[]): string[] =>
    items.length === 0
      ? [`*${title}*: none`]
      : [`*${title} (${items.length})*`, ...items.map((n) => `• ${slackNoticeText(n)}`)];
  const running =
    inProgress.length === 0
      ? "*In progress*: none"
      : `*In progress (${inProgress.length})*: ${inProgress.map(slackIssue).join(", ")}`;
  return [
    head,
    ...section(
      "Merged",
      notices.filter((n) => n.kind === "merged"),
    ),
    ...section(
      "Blocked",
      notices.filter((n) => n.kind !== "merged"),
    ),
    ...[...limited]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([h, ms]) => `${harnessName(h)} limited ${formatDuration(ms)}`),
    running,
  ].join("\n");
}

export function createDailySummary(options: DailySummaryOptions): DailySummary {
  const { store, now, timeZone, time, post } = options;
  const log = options.log ?? (() => {});
  let state: SummaryState | undefined;
  /** Every step runs in turn, so a notice never lands in the middle of a summary. */
  let chain: Promise<unknown> = Promise.resolve();

  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = chain.then(fn, fn);
    chain = next.catch(() => undefined);
    return next;
  }

  async function current(): Promise<SummaryState> {
    if (state === undefined) {
      try {
        state = await store.load();
      } catch (error) {
        log(`summary: could not load the state, starting empty: ${(error as Error).message}`);
        state = { version: 1, notices: [] };
      }
    }
    return state;
  }

  async function save(s: SummaryState): Promise<void> {
    try {
      await store.save(s);
    } catch (error) {
      log(`summary: could not save the state: ${(error as Error).message}`);
    }
  }

  async function record(notice: Notice): Promise<void> {
    const s = await current();
    s.notices.push({ at: now().toISOString(), notice });
    await save(s);
  }

  async function recordHold(event: HoldEvent): Promise<void> {
    const s = await current();
    s.holdEvents = [...(s.holdEvents ?? []), event];
    await save(s);
  }

  async function check(): Promise<boolean> {
    const s = await current();
    const at = now();
    if (s.lastSentAt === undefined) {
      s.lastSentAt = at.toISOString();
      await save(s);
      return false;
    }
    const slot = lastSummarySlot(at, timeZone, time);
    if (slot.getTime() <= Date.parse(s.lastSentAt)) return false;
    const sentAt = at.toISOString();
    const limited = limitedTime(s.holdEvents ?? [], s.lastSentAt, sentAt);
    const text = formatSummary(
      s.lastSentAt,
      timeZone,
      s.notices.map((n) => n.notice),
      options.inProgress(),
      limited.held,
    );
    // Recorded before it is sent: a crash loses one summary rather than repeating it.
    s.lastSentAt = sentAt;
    s.notices = [];
    s.holdEvents = limited.open.map((harness) => ({ harness, kind: "start", at: sentAt }));
    await save(s);
    post(text);
    return true;
  }

  return {
    wrap(inner) {
      return {
        async notify(notice) {
          await serial(() => record(notice)).catch((error) =>
            log(`summary: could not record a notice: ${(error as Error).message}`),
          );
          await inner.notify(notice);
        },
      };
    },
    check: () => serial(check),
    hold: (event) =>
      serial(() => recordHold(event)).catch((error) =>
        log(`summary: could not record a hold: ${(error as Error).message}`),
      ),
  };
}

export function summaryStatePath(repoDir: string): string {
  return join(repoDir, ".harnessd", "state", "summary.json");
}

function isHoldEvent(value: unknown): value is HoldEvent {
  const v = value as Partial<HoldEvent> | null;
  return (
    typeof v === "object" &&
    v !== null &&
    typeof v.harness === "string" &&
    isHarnessId(v.harness) &&
    (v.kind === "start" || v.kind === "end") &&
    typeof v.at === "string" &&
    !Number.isNaN(Date.parse(v.at)) &&
    (v.since === undefined || (typeof v.since === "string" && !Number.isNaN(Date.parse(v.since))))
  );
}

function isNotice(value: unknown): value is { at: string; notice: Notice } {
  const v = value as { at?: unknown; notice?: Partial<Notice> } | null;
  return (
    typeof v === "object" &&
    v !== null &&
    typeof v.at === "string" &&
    typeof v.notice === "object" &&
    v.notice !== null &&
    typeof v.notice.kind === "string" &&
    typeof v.notice.issue?.key === "string" &&
    Array.isArray(v.notice.prs)
  );
}

/** `<repo>/.harnessd/state/summary.json`. A missing file is empty; an unreadable one is moved aside. */
export function createFileSummaryStore(repoDir: string): SummaryStore {
  const file = summaryStatePath(repoDir);
  return {
    async load() {
      let text: string;
      try {
        text = await readFile(file, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, notices: [] };
        throw error;
      }
      try {
        const raw = JSON.parse(text) as Partial<SummaryState> | null;
        if (typeof raw !== "object" || raw === null) throw new Error("not an object");
        const out: SummaryState = {
          version: 1,
          notices: Array.isArray(raw.notices) ? raw.notices.filter(isNotice) : [],
        };
        if (typeof raw.lastSentAt === "string") out.lastSentAt = raw.lastSentAt;
        if (Array.isArray(raw.holdEvents)) out.holdEvents = raw.holdEvents.filter(isHoldEvent);
        return out;
      } catch {
        await rename(file, `${file}.corrupt-${Date.now()}`);
        return { version: 1, notices: [] };
      }
    },
    save: (state) => writeJsonAtomic(file, state),
  };
}
