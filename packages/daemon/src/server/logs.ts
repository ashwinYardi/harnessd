// The live log the UI shows (MET-18): loop lines and agent actions, newest kept.
import type { LogLevel, LogLine } from "@harnessd/shared";

/** Lines kept for a client that connects later. */
export const DEFAULT_LOG_CAPACITY = 500;

/** Longest line kept; longer ones are cut. */
export const MAX_LOG_LINE = 2000;

const ISSUE_KEY = /\b[A-Z][A-Z0-9]*-\d+\b/;
const WARN = /\b(fail(ed|s)?|could not|error|Needs input|needs a human|timeout)\b/i;

export interface LogOrigin {
  /** Default "loop". */
  source?: string;
  /** Default: the first issue key in the text. */
  issueKey?: string;
}

export interface LogBuffer {
  push(text: string, origin?: LogOrigin): LogLine;
  /** The kept lines, oldest first. */
  tail(): LogLine[];
  /** Calls `listener` for every new line until the returned function is called. */
  subscribe(listener: (line: LogLine) => void): () => void;
}

export interface LogBufferOptions {
  capacity?: number;
  now?: () => Date;
}

export function createLogBuffer(options: LogBufferOptions = {}): LogBuffer {
  const capacity = options.capacity ?? DEFAULT_LOG_CAPACITY;
  const now = options.now ?? (() => new Date());
  const lines: LogLine[] = [];
  const listeners = new Set<(line: LogLine) => void>();
  let seq = 0;

  return {
    push(raw, origin = {}) {
      const text = raw.replace(/\s+/g, " ").trim().slice(0, MAX_LOG_LINE);
      const level: LogLevel = WARN.test(text) ? "warn" : "info";
      const line: LogLine = {
        seq: ++seq,
        at: now().toISOString(),
        source: origin.source ?? "loop",
        level,
        text,
      };
      const key = origin.issueKey ?? ISSUE_KEY.exec(text)?.[0];
      if (key !== undefined) line.issueKey = key;
      lines.push(line);
      if (lines.length > capacity) lines.splice(0, lines.length - capacity);
      for (const listener of listeners) listener(line);
      return line;
    },
    tail: () => [...lines],
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
